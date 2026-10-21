"""JSON adapters over ``PageComments``: check access, parse the request, call one method, encode the result.

Every route sits under the Wagtail admin URLs, so Wagtail's admin-access check runs
first. The browser sends ``X-Requested-With: XMLHttpRequest``, which makes that check
answer 403 rather than redirect to the login page.
"""

from __future__ import annotations

import functools
import json
import typing as t

from django.http import HttpRequest, JsonResponse
from django.views.decorators.http import require_GET, require_POST

from .comments import CommentError, PageComments

_STATUS = {
    CommentError.AUTH: 403,
    CommentError.STALE_BLOCK: 409,
    CommentError.VALIDATION: 400,
}


def _payload(request: HttpRequest) -> dict[str, t.Any]:
    if "application/json" not in (request.content_type or ""):
        return request.POST.dict()
    if not request.body:
        return {}
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError as exc:
        raise CommentError(CommentError.VALIDATION, "Request body must be valid JSON.") from exc
    if not isinstance(data, dict):
        raise CommentError(CommentError.VALIDATION, "Request body must be a JSON object.")
    return data


def _json_errors(view: t.Callable[..., JsonResponse]) -> t.Callable[..., JsonResponse]:
    @functools.wraps(view)
    def wrapped(request: HttpRequest, *args: t.Any, **kwargs: t.Any) -> JsonResponse:
        try:
            return view(request, *args, **kwargs)
        except CommentError as exc:
            return JsonResponse({"ok": False, "error": exc.code, "message": exc.message}, status=_STATUS[exc.code])

    return wrapped


def _action(view: t.Callable[..., JsonResponse]) -> t.Callable[..., JsonResponse]:
    return require_POST(_json_errors(view))


@_action
def create(request: HttpRequest, page_id: int) -> JsonResponse:
    comments = PageComments.for_page_id(page_id, request.user)
    data = _payload(request)
    comment = comments.create(data.get("block_uuid"), data.get("text"), data.get("position"))
    return JsonResponse({"ok": True, "comment": comment}, status=201)


@_action
def reply_create(request: HttpRequest, page_id: int, comment_id: int) -> JsonResponse:
    comments = PageComments.for_page_id(page_id, request.user)
    reply = comments.reply(comment_id, _payload(request).get("text"))
    return JsonResponse({"ok": True, "reply": reply}, status=201)


@_action
def edit(request: HttpRequest, page_id: int, comment_id: int, reply_id: int | None = None) -> JsonResponse:
    comments = PageComments.for_page_id(page_id, request.user)
    result = comments.edit(comment_id, _payload(request).get("text"), reply_id=reply_id)
    return JsonResponse({"ok": True, **result})


@_action
def delete(request: HttpRequest, page_id: int, comment_id: int, reply_id: int | None = None) -> JsonResponse:
    PageComments.for_page_id(page_id, request.user).delete(comment_id, reply_id=reply_id)
    return JsonResponse({"ok": True})


@_action
def resolve(request: HttpRequest, page_id: int, comment_id: int) -> JsonResponse:
    PageComments.for_page_id(page_id, request.user).resolve(comment_id)
    return JsonResponse({"ok": True})


@require_GET
@_json_errors
def mention_candidates(request: HttpRequest, page_id: int) -> JsonResponse:
    """``?q=`` searches the ``@`` picker; ``?tokens=@a&tokens=@[B]`` resolves typed tokens.

    The page editor resolves tokens to highlight mentions in Wagtail's own comment sidebar.
    """
    comments = PageComments.for_page_id(page_id, request.user)
    result = comments.mention_candidates(request.GET.get("q", ""), request.GET.getlist("tokens"))
    return JsonResponse({"ok": True, **result})
