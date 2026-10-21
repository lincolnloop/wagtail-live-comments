import json
import re
import sys
import types
from html import unescape

import pytest
from django.contrib.auth import get_user_model
from django.test import Client, RequestFactory, override_settings
from django.urls import reverse
from wagtail import hooks
from wagtail.admin.userbar import EditPageItem, apply_userbar_hooks
from wagtail.blocks import BoundBlock

from tests.backend.helpers import blocks, url
from wagtail_live_comments import annotate
from wagtail_live_comments.comments import PageComments
from wagtail_live_comments.wagtail_hooks import AddCommentUserbarItem, mentions_editor_js

User = get_user_model()

CONFIG_RE = re.compile(r'<script id="wagtail-live-comments-config" type="application/json">(.*?)</script>', re.DOTALL)


def _request(user, **attrs):
    request = RequestFactory().get("/demo/")
    request.user = user
    for name, value in attrs.items():
        setattr(request, name, value)
    return request


def _all_block_ids(page):
    b = blocks(page)
    return [*(str(block.id) for block in b.values()), str(b["grid"].value["cards"].bound_blocks[1].id)]


# -- Block ids on the rendered page ----------------------------------------------------------


def test_editor_page_view_stamps_every_block_root_without_wrappers(editor_client, live_page):
    html = editor_client.get(live_page.url).content.decode()

    for block_id in _all_block_ids(live_page):
        assert html.count(f'data-block-id="{block_id}"') == 1
    b = blocks(live_page)
    assert f'<section data-block-id="{b["section"].id}" data-block-type="section"' in html
    assert f'<article data-block-id="{b["card"].id}"' in html


def test_anonymous_page_view_is_untouched(live_page):
    html = Client().get(live_page.url).content.decode()

    assert "data-block-id" not in html
    assert "wagtail-live-comments-config" not in html
    assert "Add a Comment" not in html


def test_non_editor_page_view_is_untouched(live_page):
    reader = User.objects.create_user(username="reader", password="password")
    client = Client()
    client.force_login(reader)

    assert "data-block-id" not in client.get(live_page.url).content.decode()


@override_settings(WAGTAIL_LIVE_COMMENTS_ENABLED=False)
def test_disabled_setting_leaves_editor_views_untouched(editor_client, live_page):
    html = editor_client.get(live_page.url).content.decode()

    assert "data-block-id" not in html
    assert "Add a Comment" not in html


def test_preview_stamps_block_roots_for_editors(editor_client, live_page):
    response = editor_client.get(reverse("wagtailadmin_pages:view_draft", args=[live_page.pk]))

    html = response.content.decode()
    assert response.status_code == 200
    for block_id in _all_block_ids(live_page):
        assert f'data-block-id="{block_id}"' in html
    assert CONFIG_RE.search(html)


def test_existing_block_id_on_the_root_is_left_alone(live_page):
    heading = blocks(live_page)["heading"]

    with annotate.stamping():
        stamped = annotate._stamp(heading, '<h2 data-block-id="x">Hi</h2>')
        nested = annotate._stamp(heading, '<div><h2 data-block-id="x">Hi</h2></div>')

    assert stamped == '<h2 data-block-id="x">Hi</h2>'
    # A child's id is not the root's: the root still gets one.
    assert nested.startswith(f'<div data-block-id="{heading.id}"')


def test_stamping_is_off_outside_editor_serves(live_page):
    heading = blocks(live_page)["heading"]

    assert "data-block-id" not in str(BoundBlock.render(heading))
    with annotate.stamping():
        assert f'data-block-id="{heading.id}"' in str(BoundBlock.render(heading))


def test_wagtail_inspect_patches_go_inside_ours(monkeypatch):
    """Inspect stamps without checking for an existing id, so its layer must be the inner one."""
    calls = []
    fake = types.ModuleType("wagtail_inspect.patches")
    fake.apply_patches = lambda: calls.append("inspect")
    monkeypatch.setitem(sys.modules, "wagtail_inspect", types.ModuleType("wagtail_inspect"))
    monkeypatch.setitem(sys.modules, "wagtail_inspect.patches", fake)
    monkeypatch.setattr(annotate.django_apps, "is_installed", lambda name: name == "wagtail_inspect")

    annotate.apply_patches()

    assert calls == ["inspect"]


def test_patches_are_idempotent():
    render = BoundBlock.render

    annotate.apply_patches()

    assert BoundBlock.render is render


# -- Userbar item ------------------------------------------------------------------------------


def test_editor_page_view_carries_the_config_in_the_userbar(editor_client, editor, live_page):
    html = editor_client.get(live_page.url).content.decode()

    match = CONFIG_RE.search(html)
    assert match is not None
    assert json.loads(unescape(match.group(1))) == PageComments(live_page, editor).config()
    assert "wagtail_live_comments/js/live-comments.js" in html
    assert "data-live-page-comment-trigger" in html


def test_userbar_item_renders_for_editors_on_live_and_preview(editor, live_page):
    item = AddCommentUserbarItem(live_page)

    for request in (_request(editor), _request(editor, is_preview=True)):
        html = item.render_html({"request": request})
        assert "Add a Comment" in html
        assert CONFIG_RE.search(html)
    assert "wagtail_live_comments/js/live-comments.js" in str(item.media)
    assert "wagtail_live_comments/css/live-comments.css" in str(item.media)


def test_userbar_item_is_empty_in_the_editor_preview_panel(editor, live_page):
    html = AddCommentUserbarItem(live_page).render_html({"request": _request(editor, in_preview_panel=True)})

    assert html == ""


def test_userbar_item_is_empty_for_non_editors(live_page):
    reader = User.objects.create_user(username="reader", password="password")

    assert AddCommentUserbarItem(live_page).render_html({"request": _request(reader)}) == ""


def test_userbar_hook_adds_the_item_after_edit(editor, live_page):
    items = [EditPageItem(live_page), object()]

    apply_userbar_hooks(_request(editor), items, live_page)

    assert isinstance(items[1], AddCommentUserbarItem)
    assert "add_comment_item" in [fn.__name__ for fn in hooks.get_hooks("construct_wagtail_userbar")]


@pytest.mark.django_db
def test_page_editor_loads_the_mention_picker():
    html = str(mentions_editor_js())

    assert 'id="wagtail-live-comments-mentions-config"' in html
    assert url("mention_candidates", page_id=0) in unescape(html)
    for asset in ("js/live-comments.js", "js/comment-mentions-editor.js", "css/live-comments.css"):
        assert f"wagtail_live_comments/{asset}" in html


@override_settings(WAGTAIL_LIVE_COMMENTS_ENABLED=False)
def test_page_editor_skips_the_mention_picker_when_disabled():
    assert mentions_editor_js() == ""
