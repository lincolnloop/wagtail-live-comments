from __future__ import annotations

import typing as t

from django.forms import Media
from django.templatetags.static import static
from django.urls import include, path, reverse
from django.utils.html import format_html, json_script
from wagtail import hooks
from wagtail.admin.userbar import BaseItem, EditPageItem

from . import urls
from .comments import STYLESHEET, URL_NAMESPACE, PageComments
from .permissions import can_comment, comments_enabled

if t.TYPE_CHECKING:
    from collections.abc import Mapping

    from django.http import HttpRequest
    from wagtail.models import Page

SCRIPT = "wagtail_live_comments/js/live-comments.js"
EDITOR_SCRIPT = "wagtail_live_comments/js/comment-mentions-editor.js"


class AddCommentUserbarItem(BaseItem):
    """Userbar "Add a Comment" item, carrying the page's comment bootstrap.

    The config and the trigger render inside the userbar's shadow root; the script
    and stylesheet ride along as ``Media`` so Wagtail emits them as external files
    (a strict ``script-src`` CSP still allows them).
    """

    template_name = "wagtail_live_comments/userbar/item_add_comment.html"

    def __init__(self, page: Page) -> None:
        self.page = page

    @property
    def media(self) -> Media:
        return Media(js=[SCRIPT], css={"all": [STYLESHEET]})

    def get_context_data(self, parent_context: Mapping[str, t.Any]) -> dict[str, t.Any]:
        context = super().get_context_data(parent_context)
        request = parent_context["request"]
        context["live_comments_config"] = PageComments(self.page, request.user).config()
        return context

    def render_html(self, parent_context: Mapping[str, t.Any]) -> str:
        request = t.cast("HttpRequest | None", parent_context.get("request"))
        if request is None or getattr(request, "in_preview_panel", False):
            # The page editor's preview panel has the editor's own comment sidebar.
            return ""
        if not can_comment(self.page, request.user):
            return ""
        return super().render_html(parent_context)


@hooks.register("register_admin_urls")
def register_admin_urls() -> list[t.Any]:
    return [path("live-comments/", include(urls))]


@hooks.register("construct_wagtail_userbar")
def add_comment_item(_request: HttpRequest, items: list[t.Any], page: Page | None = None) -> None:
    """Add a Comment, right after Edit, on live and preview serves."""
    if page is None or not getattr(page, "pk", None):
        return
    item = AddCommentUserbarItem(page)
    for index, existing in enumerate(items):
        if isinstance(existing, EditPageItem):
            items.insert(index + 1, item)
            return
    items.append(item)


# Wagtail 7 dropped ``insert_editor_css``, and the global CSS hook would load these
# styles on every admin page, so the stylesheet rides along here.
@hooks.register("insert_editor_js")
def mentions_editor_js() -> str:
    """@ picker and mention highlights in the page editor's comment sidebar."""
    if not comments_enabled():
        return ""
    template = reverse(f"{URL_NAMESPACE}:mention_candidates", kwargs={"page_id": 0})
    return json_script({"mentionsUrlTemplate": template}, "wagtail-live-comments-mentions-config") + format_html(
        '<link rel="stylesheet" href="{}"><script src="{}"></script><script src="{}"></script>',
        static(STYLESHEET),
        static(SCRIPT),
        static(EDITOR_SCRIPT),
    )
