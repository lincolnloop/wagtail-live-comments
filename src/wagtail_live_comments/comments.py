"""Live-page comments on one page, as one user sees and changes them.

``PageComments`` is the whole contract the views and the userbar item use. It
stores native ``wagtailcore.Comment`` / ``CommentReply`` rows (so they round-trip
into the page editor's comment sidebar), plus a ``CommentAnchor`` for the pin
point. Results are the JSON shapes the browser reads; failures raise
``CommentError`` with a stable ``code``.
"""

from __future__ import annotations

import typing as t
import uuid
from functools import cached_property

from django.db import transaction
from django.db.models import Prefetch
from django.shortcuts import get_object_or_404
from django.templatetags.static import static
from django.urls import reverse
from django.utils import timezone
from wagtail.admin.templatetags.wagtailadmin_tags import avatar_url
from wagtail.models import Comment, CommentReply, Page

from . import block_map
from .mentions import MENTION_MAX_LENGTH, display_name, mention_candidates, mentions_in, resolve_mentions
from .models import CommentAnchor
from .permissions import can_edit, comments_enabled

if t.TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from .mentions import Mention

URL_NAMESPACE = "wagtail_live_comments"
STYLESHEET = "wagtail_live_comments/css/live-comments.css"

# Cap on resolved ``tokens`` per mention lookup (one request per editor repaint).
_MAX_RESOLVED_TOKENS = 50


class CommentError(Exception):
    """A request the comment contract refuses. ``code`` is what the browser branches on."""

    AUTH = "auth"
    STALE_BLOCK = "stale_block"
    VALIDATION = "validation"

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ClickPoint(t.TypedDict):
    """Where a pin sits, as fractions (0-1) of its block's box."""

    x: float
    y: float


def _url(name: str, **kwargs: t.Any) -> str:
    return reverse(f"{URL_NAMESPACE}:{name}", kwargs=kwargs)


def _click_point(raw: object) -> ClickPoint | None:
    """``None`` means "no point" (keyboard, or older comments): the pin stacks in the block corner."""
    if not isinstance(raw, dict):
        return None
    try:
        x = float(str(raw.get("x")))
        y = float(str(raw.get("y")))
    except (TypeError, ValueError):
        return None
    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
        return None
    return {"x": x, "y": y}


def _block_id(raw: object) -> str:
    if raw is None or raw == "":
        raise CommentError(CommentError.VALIDATION, "A block UUID is required.")
    try:
        return str(uuid.UUID(str(raw).strip()))
    except ValueError as exc:
        raise CommentError(CommentError.VALIDATION, "Block UUID is not a valid UUID.") from exc


def _text(raw: object) -> str:
    text = "" if raw is None else str(raw).strip()
    if not text:
        raise CommentError(CommentError.VALIDATION, "Comment text is required.")
    return text


def _author_name(user: t.Any) -> str:
    """Comments outlive deleted users (``user`` is then ``None``)."""
    return display_name(user) if user is not None else ""


def _avatar(user: t.Any) -> str:
    """Same avatar the Wagtail editor's comment sidebar shows for this user."""
    return avatar_url(user, size=50) if user is not None else ""


def _is_mine(author: t.Any, viewer: t.Any) -> bool:
    return bool(
        author is not None
        and viewer is not None
        and getattr(viewer, "is_authenticated", False)
        and getattr(author, "pk", None) is not None
        and author.pk == viewer.pk
    )


class PageComments:
    """Live-page comments on ``page`` for ``user``.

    Build it with ``for_page_id`` on requests (it checks permission) or directly
    when the caller has already checked ``can_comment``.
    """

    def __init__(self, page: Page, user: t.Any) -> None:
        self.page = page
        self.user = user

    @classmethod
    def for_page_id(cls, page_id: int, user: t.Any) -> PageComments:
        """Raises ``Http404`` for a missing page and ``CommentError(AUTH)`` without permission."""
        page = get_object_or_404(Page, pk=page_id)
        if not comments_enabled():
            raise CommentError(CommentError.AUTH, "Comments are disabled.")
        if not can_edit(page, user):
            raise CommentError(CommentError.AUTH, "You do not have permission to comment on this page.")
        return cls(page, user)

    # -- Reading -----------------------------------------------------------------

    def config(self) -> dict[str, t.Any]:
        """Bootstrap the live-page script reads from the userbar."""
        page_id = self.page.pk
        return {
            "pageId": page_id,
            "createUrl": _url("create", page_id=page_id),
            "mentionsUrl": _url("mention_candidates", page_id=page_id),
            "cssUrl": static(STYLESHEET),
            "eligibleBlockIds": self._source[1],
            "currentUser": _author_name(self.user),
            "currentAvatar": _avatar(self.user),
            "comments": self._open_comments_by_block(),
        }

    def mention_candidates(self, query: str = "", tokens: Iterable[str] = ()) -> dict[str, t.Any]:
        """People and groups the ``@`` picker offers, or, given ``tokens``, which of them resolve."""
        # "@[" + name + "]" is the longest token.
        capped = [str(token)[: MENTION_MAX_LENGTH + 3] for token in list(tokens)[:_MAX_RESOLVED_TOKENS]]
        if capped:
            resolved = resolve_mentions(self.page, [" ".join(capped)])
            return {"mentions": list(resolved.values())}
        return mention_candidates(self.page, str(query)[:MENTION_MAX_LENGTH], exclude_user=self.user)

    # -- Writing -----------------------------------------------------------------

    def create(self, block_id: object, text: object, position: object = None) -> dict[str, t.Any]:
        """Comment on a block of the latest draft. Does not create a revision."""
        target = _block_id(block_id)
        body = _text(text)
        point = _click_point(position)
        source, _ids = self._source
        contentpath = block_map.contentpath_for_block(source, target)
        if not contentpath or not Comment(contentpath=contentpath).has_valid_contentpath(source):
            raise CommentError(CommentError.STALE_BLOCK, "That block is not present on the latest draft.")

        revision = self.page.get_latest_revision()
        with transaction.atomic():
            comment = Comment.objects.create(
                page=self.page,
                user=self.user,
                text=body,
                contentpath=contentpath,
                revision_created=revision,
            )
            if point is not None:
                CommentAnchor.objects.create(comment=comment, x=point["x"], y=point["y"])
            comment.log_create(page_revision=revision, user=self.user)
        return self._serialize_comment(comment, point=point, mentions=resolve_mentions(self.page, [body]))

    def reply(self, comment_id: int, text: object) -> dict[str, t.Any]:
        comment = self._open_comment(comment_id)
        body = _text(text)
        reply = CommentReply.objects.create(comment=comment, user=self.user, text=body)
        reply.log_create(page_revision=self.page.get_latest_revision(), user=self.user)
        return self._serialize_reply(reply, mentions=resolve_mentions(self.page, [body]))

    def edit(self, comment_id: int, text: object, *, reply_id: int | None = None) -> dict[str, t.Any]:
        """Rewrite the user's own comment or reply. Returns its new text and mentions."""
        target = self._own(comment_id, reply_id)
        target.text = _text(text)
        target.save()
        target.log_edit(page_revision=self.page.get_latest_revision(), user=self.user)
        return {"text": target.text, "mentions": mentions_in(target.text, resolve_mentions(self.page, [target.text]))}

    def delete(self, comment_id: int, *, reply_id: int | None = None) -> None:
        target = self._own(comment_id, reply_id)
        target.log_delete(page_revision=self.page.get_latest_revision(), user=self.user)
        target.delete()

    def resolve(self, comment_id: int) -> None:
        """Any editor of the page may resolve, as in the page editor."""
        comment = self._open_comment(comment_id)
        comment.resolved_at = timezone.now()
        comment.resolved_by = self.user
        comment.save()
        comment.log_resolve(page_revision=self.page.get_latest_revision(), user=self.user)

    # -- Internals ---------------------------------------------------------------

    @cached_property
    def _source(self) -> tuple[Page, list[str]]:
        """Page object whose StreamFields comments target, and its block ids.

        Prefer the latest draft. A draft with no blocks is treated as a wiped draft,
        so fall back to the live page the editor is looking at. Cached: rebuilding
        the draft means loading and deserializing its revision.
        """
        latest = self.page.get_latest_revision_as_object()
        ids = block_map.block_ids(latest)
        if ids:
            return latest, ids
        live = self.page.specific
        return live, block_map.block_ids(live)

    def _open_comment(self, comment_id: int) -> Comment:
        comment = get_object_or_404(Comment, pk=comment_id, page_id=self.page.pk)
        if comment.resolved_at is not None:
            raise CommentError(CommentError.VALIDATION, "That comment is resolved.")
        return comment

    def _own(self, comment_id: int, reply_id: int | None) -> Comment | CommentReply:
        comment = self._open_comment(comment_id)
        target = comment if reply_id is None else get_object_or_404(CommentReply, pk=reply_id, comment_id=comment.pk)
        if target.user_id != getattr(self.user, "pk", None):
            raise CommentError(CommentError.AUTH, "You can only change your own comments.")
        return target

    def _open_comments_by_block(self) -> dict[str, list[dict[str, t.Any]]]:
        # ``avatar_url`` reads ``user.wagtail_userprofile``: join it, or it is a query per author.
        comments = list(
            Comment.objects.filter(page=self.page, resolved_at__isnull=True)
            .select_related("user__wagtail_userprofile")
            .prefetch_related(
                Prefetch("replies", queryset=CommentReply.objects.select_related("user__wagtail_userprofile"))
            )
            .order_by("created_at")
        )
        points = {
            anchor.comment_id: ClickPoint(x=anchor.x, y=anchor.y)
            for anchor in CommentAnchor.objects.filter(comment__in=comments)
        }
        mentions = resolve_mentions(
            self.page,
            (text for comment in comments for text in [comment.text, *(r.text for r in comment.replies.all())]),
        )
        grouped: dict[str, list[dict[str, t.Any]]] = {}
        for comment in comments:
            block_id = block_map.block_id_from_contentpath(self.page, comment.contentpath)
            if block_id:
                grouped.setdefault(block_id, []).append(
                    self._serialize_comment(comment, point=points.get(comment.pk), mentions=mentions)
                )
        return grouped

    def _editor_url(self, contentpath: str) -> str:
        """Page-edit URL scrolled to the StreamChild panel for this comment."""
        edit = reverse("wagtailadmin_pages:edit", args=[self.page.pk])
        block_id = block_map.top_level_block_id(self.page, contentpath)
        return f"{edit}#block-{block_id}-section" if block_id else edit

    def _serialize_card(self, item: Comment | CommentReply, mentions: Mapping[str, Mention]) -> dict[str, t.Any]:
        """Fields a comment and a reply share."""
        return {
            "id": item.pk,
            "text": item.text,
            "author": _author_name(item.user),
            "avatar": _avatar(item.user),
            "createdAt": item.created_at.isoformat(),
            "mine": _is_mine(item.user, self.user),
            "mentions": mentions_in(item.text, mentions),
        }

    def _serialize_reply(self, reply: CommentReply, *, mentions: Mapping[str, Mention]) -> dict[str, t.Any]:
        ids = {"page_id": self.page.pk, "comment_id": reply.comment_id, "reply_id": reply.pk}
        return {
            **self._serialize_card(reply, mentions),
            "editUrl": _url("reply_edit", **ids),
            "deleteUrl": _url("reply_delete", **ids),
        }

    def _serialize_comment(
        self, comment: Comment, *, point: ClickPoint | None, mentions: Mapping[str, Mention]
    ) -> dict[str, t.Any]:
        ids = {"page_id": self.page.pk, "comment_id": comment.pk}
        return {
            **self._serialize_card(comment, mentions),
            "replies": [self._serialize_reply(reply, mentions=mentions) for reply in comment.replies.all()],
            "contentpath": comment.contentpath,
            "revision_created": comment.revision_created_id,
            "position": point,
            "replyUrl": _url("reply_create", **ids),
            "editUrl": _url("edit", **ids),
            "deleteUrl": _url("delete", **ids),
            "resolveUrl": _url("resolve", **ids),
            "editorUrl": self._editor_url(comment.contentpath),
        }
