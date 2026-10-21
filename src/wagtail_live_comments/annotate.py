"""Stamp ``data-block-id`` / ``data-block-type`` on StreamField block roots for editors.

Patches applied from ``AppConfig.ready()``:

- ``BoundBlock.render`` / ``render_as_block``: while stamping, inject the attributes
  into the first tag of each block's output (StreamChild is a BoundBlock, so
  top-level and nested stream children both get them). Never wraps the output: a
  ``display:contents`` wrapper breaks grid placement in host layouts, so a block
  whose template has no root tag is simply not targetable.
- ``ListValue.__iter__``: while stamping, yield proxies so ``{% include_block item %}``
  over list children renders through ``BoundBlock`` and gets ids too.
- ``Page.serve`` and ``PreviewableMixin.serve_preview``: turn stamping on for users
  who may comment on the page, and render lazy ``TemplateResponse``s while it is on.
  Anonymous and non-editor responses are untouched.

wagtail-inspect patches the same methods and, unlike this module, stamps without
checking for an existing ``data-block-id`` (and may wrap in ``display:contents``). So
when it is installed its patches are applied first, whatever the ``INSTALLED_APPS``
order: its layer stays inside ours, and ours leaves a root it already stamped alone.
Patches are idempotent (in both packages); failures log and do not abort startup.
"""

from __future__ import annotations

import contextlib
import contextvars
import logging
import re
import typing as t

from django.apps import apps as django_apps
from django.utils.html import conditional_escape
from django.utils.safestring import mark_safe
from wagtail.blocks import BoundBlock
from wagtail.blocks.list_block import ListValue
from wagtail.models import Page

try:
    from wagtail.models.preview import PreviewableMixin
except ImportError:  # pragma: no cover - Wagtail < 6.x layout
    from wagtail.models import PreviewableMixin

from .permissions import can_comment

if t.TYPE_CHECKING:
    from collections.abc import Iterator

logger = logging.getLogger(__name__)

_stamping = contextvars.ContextVar("wagtail_live_comments_stamping", default=False)
_originals: dict[str, t.Any] = {}

# Duplicated from wagtail-inspect 0.1.1 (patches._FIRST_TAG_RE); keep in sync by hand.
_FIRST_TAG_RE = re.compile(r"<[a-zA-Z][a-zA-Z0-9:-]*")


@contextlib.contextmanager
def stamping() -> Iterator[None]:
    """Stamp block roots for everything rendered inside this block."""
    token = _stamping.set(True)
    try:
        yield
    finally:
        _stamping.reset(token)


def _stamp(bound: BoundBlock, output: t.Any) -> t.Any:
    if not _stamping.get():
        return output
    block_id = getattr(bound, "id", None)
    if not block_id:
        return output
    html = str(output)
    match = _FIRST_TAG_RE.search(html)
    if not match:
        return output
    # Already stamped by an inner layer (or by wagtail-inspect in preview).
    first_tag_end = html.find(">", match.end())
    if "data-block-id=" in html[match.start() : first_tag_end if first_tag_end != -1 else None]:
        return output
    block_type = getattr(bound, "block_type", None) or getattr(getattr(bound, "block", None), "name", "")
    attrs = (
        f' data-block-id="{conditional_escape(str(block_id))}"'
        f' data-block-type="{conditional_escape(str(block_type or "block"))}"'
    )
    return mark_safe(html[: match.end()] + attrs + html[match.end() :])


# Duplicated from wagtail-inspect 0.1.1 (patches._ListChildProxy); keep in sync by hand.
class _ListChildProxy:
    """ListChild with value-like access plus ``id`` / ``render_as_block``."""

    __slots__ = ("_child",)

    def __init__(self, list_child: t.Any) -> None:
        object.__setattr__(self, "_child", list_child)

    id = property(lambda self: self._child.id)
    block = property(lambda self: self._child.block)
    block_type = property(lambda self: getattr(self._child, "block_type", None))
    value = property(lambda self: self._child.value)

    def render(self, context: t.Any = None) -> t.Any:
        return self._child.render(context)

    def render_as_block(self, context: t.Any = None) -> t.Any:
        return self._child.render_as_block(context)

    def __str__(self) -> str:
        return str(self._child.value)

    def __iter__(self) -> t.Iterator[t.Any]:
        return iter(self._child.value)

    def __getattr__(self, name: str) -> t.Any:
        v = self._child.value
        getitem = getattr(v, "__getitem__", None)
        if getitem is not None:
            try:
                return getitem(name)
            except (KeyError, TypeError, IndexError):
                pass
        return getattr(v, name)

    def __getitem__(self, key: t.Any) -> t.Any:
        return self._child.value[key]

    def __len__(self) -> int:
        return len(self._child.value)

    def __bool__(self) -> bool:
        return bool(self._child.value)


def _patched_render(self: BoundBlock, context: t.Any = None) -> t.Any:
    return _stamp(self, _originals["BoundBlock.render"](self, context=context))


def _patched_render_as_block(self: BoundBlock, context: t.Any = None) -> t.Any:
    return _stamp(self, _originals["BoundBlock.render_as_block"](self, context=context))


def _patched_list_iter(self: ListValue) -> t.Iterator[t.Any]:
    if not _stamping.get():
        return _originals["ListValue.__iter__"](self)
    return iter(_ListChildProxy(child) for child in self.bound_blocks)


def _render_stamped(page: t.Any, request: t.Any, serve: t.Callable[[], t.Any]) -> t.Any:
    if _stamping.get() or not can_comment(page, getattr(request, "user", None)):
        return serve()
    with stamping():
        response = serve()
        # TemplateResponse renders lazily, after this context would be reset.
        if callable(getattr(response, "render", None)) and not getattr(response, "is_rendered", True):
            response.render()
        return response


def _patched_serve(self: Page, request: t.Any, *args: t.Any, **kwargs: t.Any) -> t.Any:
    return _render_stamped(self, request, lambda: _originals["Page.serve"](self, request, *args, **kwargs))


def _patched_serve_preview(self: t.Any, request: t.Any, mode_name: t.Any) -> t.Any:
    original = _originals["PreviewableMixin.serve_preview"]
    return _render_stamped(self, request, lambda: original(self, request, mode_name))


# Duplicated from wagtail-inspect 0.1.1 (patches._apply_patch); keep in sync by hand.
def _apply_patch(target: t.Any, attr: str, replacement: t.Any, label: str) -> None:
    """Replace *attr* on *target* once; log failures without raising."""
    if label in _originals:
        return
    try:
        _originals[label] = getattr(target, attr)
        setattr(target, attr, replacement)
    except Exception:
        logger.exception("wagtail_live_comments: failed to patch %s", label)


def _apply_inspect_patches_first() -> None:
    """Make wagtail-inspect's layer the inner one, if that app is installed."""
    if not django_apps.is_installed("wagtail_inspect"):
        return
    try:
        from wagtail_inspect import patches as inspect_patches
    except ImportError:
        return
    inspect_patches.apply_patches()


def apply_patches() -> None:
    _apply_inspect_patches_first()
    _apply_patch(BoundBlock, "render", _patched_render, "BoundBlock.render")
    _apply_patch(BoundBlock, "render_as_block", _patched_render_as_block, "BoundBlock.render_as_block")
    _apply_patch(ListValue, "__iter__", _patched_list_iter, "ListValue.__iter__")
    _apply_patch(Page, "serve", _patched_serve, "Page.serve")
    _apply_patch(PreviewableMixin, "serve_preview", _patched_serve_preview, "PreviewableMixin.serve_preview")
