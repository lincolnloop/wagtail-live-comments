"""An editor comments on a nested card of the live page, then sees the pin.

The live server runs in a thread, so the data comes from ``transactional_db``,
and ``tests/e2e/settings.py`` gives both threads one SQLite file.
"""

import pytest
from django.contrib.auth import get_user_model
from playwright.sync_api import expect
from testapp.factories import demo_stream
from testapp.models import DemoPage
from wagtail.models import Comment, Locale, Page, Site

from wagtail_live_comments import block_map

PASSWORD = "password"


@pytest.fixture
def live_page(transactional_db):
    Locale.objects.get_or_create(language_code="en")
    root = Page.get_first_root_node() or Page.add_root(title="Root", slug="root")
    Site.objects.update_or_create(is_default_site=True, defaults={"hostname": "localhost", "root_page": root})
    page = root.add_child(instance=DemoPage(title="Demo", slug="demo", **demo_stream()))
    page.save_revision().publish()
    return page


@pytest.fixture
def editor_page(page, live_server, live_page):
    get_user_model().objects.create_superuser("editor", "editor@example.com", PASSWORD)
    page.goto(f"{live_server.url}/cms/login/")
    page.fill("input[name=username]", "editor")
    page.fill("input[name=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_url(f"{live_server.url}/cms/")
    page.goto(f"{live_server.url}{live_page.url}")
    return page


def test_editor_comments_on_a_nested_card(editor_page, live_page):
    card_id = str(live_page.body[1].value["content"][1].value["cards"].bound_blocks[0].id)

    editor_page.click("[data-wagtail-userbar-trigger]")
    editor_page.click("[data-live-page-comment-trigger]")
    editor_page.click(f'[data-block-id="{card_id}"] h3')
    editor_page.fill("[data-live-page-comment-dialog] textarea", "Is this headline right?")
    editor_page.click("[data-live-page-comment-submit]")

    pin = editor_page.locator(f'[data-live-page-comment-pin][data-live-page-comment-pin-block="{card_id}"]')
    expect(pin).to_have_count(1)
    # A pin is our UI, not a block: block tools (inspect, targeting) must skip it.
    expect(pin).not_to_have_attribute("data-block-id", card_id)
    expect(pin).to_have_attribute("data-block-ids-ignore", "")

    # Back in targeting mode, the pin is still not a target, and clicking it opens
    # its comment instead of a new-comment dialog.
    editor_page.click("[data-wagtail-userbar-trigger]")
    editor_page.click("[data-live-page-comment-trigger]")
    expect(pin).not_to_have_attribute("data-commentable", "")
    pin.locator("[data-live-page-comment-pill]").click()
    expect(editor_page.locator("[data-live-page-comment-dialog][open]")).to_have_count(0)
    expect(editor_page.locator("[data-live-page-comment-popover]:not([hidden])")).to_have_count(1)
    # Pins live in the page, so the script adds the stylesheet there too.
    expect(editor_page.locator("head link[data-wagtail-live-comments-css]")).to_have_count(1)
    comment = Comment.objects.get()
    assert comment.text == "Is this headline right?"
    assert card_id in comment.contentpath


def test_one_comment_popover_is_open_at_a_time(editor_page, live_page):
    editor = get_user_model().objects.get(username="editor")
    heading_id, note_id = str(live_page.body[0].id), str(live_page.sidebar[0].id)
    first, second = (
        Comment.objects.create(
            page=live_page, user=editor, text=text, contentpath=block_map.contentpath_for_block(live_page, block_id)
        )
        for text, block_id in (("On the heading.", heading_id), ("On the note.", note_id))
    )
    open_popovers = editor_page.locator("[data-live-page-comment-popover]:not([hidden])")
    expanded = editor_page.locator('[data-live-page-comment-pill][aria-expanded="true"]')

    def pill(comment):
        return editor_page.locator(f"#live-page-comment-{comment.pk} [data-live-page-comment-pill]")

    # A permalink opens its comment; opening another pin closes it.
    editor_page.goto(f"{editor_page.url}#live-page-comment-{first.pk}")
    editor_page.reload()
    expect(open_popovers).to_have_count(1)
    expect(pill(first)).to_have_attribute("aria-expanded", "true")
    # The open popover may cover the other pin at this viewport: click it directly.
    pill(second).dispatch_event("click")
    expect(open_popovers).to_have_count(1)
    expect(open_popovers).to_contain_text("On the note.")
    expect(expanded).to_have_count(1)
    # Following a permalink while another comment is open swaps them.
    editor_page.evaluate("location.hash = ''")  # The URL still carries the first permalink.
    editor_page.evaluate(f"location.hash = 'live-page-comment-{first.pk}'")
    expect(open_popovers).to_contain_text("On the heading.")
    expect(open_popovers).to_have_count(1)
    expect(expanded).to_have_count(1)

    # The same pin toggles it shut; Escape and an outside click close it too.
    pill(first).click()
    expect(open_popovers).to_have_count(0)
    expect(expanded).to_have_count(0)
    pill(first).click()
    editor_page.keyboard.press("Escape")
    expect(open_popovers).to_have_count(0)
    pill(first).click()
    editor_page.locator("body").click(position={"x": 5, "y": 5})
    expect(open_popovers).to_have_count(0)
    expect(expanded).to_have_count(0)


def test_blocks_missing_from_the_latest_draft_say_why(page, live_server, live_page):
    sidebar_note_id = str(live_page.sidebar[0].id)
    draft = live_page.get_latest_revision_as_object()
    draft.sidebar = []
    draft.save_revision()
    get_user_model().objects.create_superuser("editor", "editor@example.com", PASSWORD)
    page.goto(f"{live_server.url}/cms/login/")
    page.fill("input[name=username]", "editor")
    page.fill("input[name=password]", PASSWORD)
    page.click("button[type=submit]")
    page.wait_for_url(f"{live_server.url}/cms/")
    page.goto(f"{live_server.url}{live_page.url}")

    page.click("[data-wagtail-userbar-trigger]")
    page.click("[data-live-page-comment-trigger]")
    note = page.locator(f'[data-block-id="{sidebar_note_id}"]')

    expect(note).to_have_attribute("data-comment-unavailable", "")
    expect(page.locator("[data-live-page-comment-status]")).to_contain_text("1 block isn't in the latest draft")
    note.click()
    expect(page.locator("[data-live-page-comment-status]")).to_contain_text("Not in the latest draft")
    expect(page.locator("[data-live-page-comment-dialog][open]")).to_have_count(0)


def test_targeting_is_exclusive_with_other_block_modes(editor_page):
    """Inspect (or any wagtail-block-ids mode) turning on ends targeting, and vice versa."""
    editor_page.evaluate(
        """() => {
            window.__modes = [];
            document.addEventListener("wagtail-block-ids:mode-on", (e) => window.__modes.push(e.detail.source));
        }"""
    )
    editor_page.click("[data-wagtail-userbar-trigger]")
    editor_page.click("[data-live-page-comment-trigger]")

    expect(editor_page.locator("html[data-live-page-comment-targeting]")).to_have_count(1)
    assert editor_page.evaluate("window.__modes") == ["wagtail-live-comments"]

    editor_page.evaluate(
        """() => document.dispatchEvent(new CustomEvent("wagtail-block-ids:mode-on",
            { detail: { source: "wagtail-inspect" } }))"""
    )

    expect(editor_page.locator("html[data-live-page-comment-targeting]")).to_have_count(0)
    expect(editor_page.locator("[data-commentable]")).to_have_count(0)


def test_anonymous_visitors_get_a_plain_page(page, live_server, live_page):
    page.goto(f"{live_server.url}{live_page.url}")

    expect(page.locator("[data-block-id]")).to_have_count(0)
    expect(page.locator("wagtail-userbar")).to_have_count(0)
