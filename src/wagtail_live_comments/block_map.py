"""StreamField block UUIDs and the comment contentpaths that point into them.

A contentpath is the dotted path Wagtail's editor uses to pin a comment on a form
field, e.g. ``body.<section uuid>.content.<card uuid>.headline``. Every StreamField
on the page is a candidate root, not only ``body``.
"""

from __future__ import annotations

import typing as t
import uuid

from django.conf import settings
from wagtail.blocks import ChoiceBlock, FieldBlock, ListBlock, StreamBlock, StructBlock
from wagtail.blocks.list_block import ListValue
from wagtail.blocks.stream_block import StreamValue
from wagtail.fields import StreamField

if t.TYPE_CHECKING:
    from collections.abc import Iterator

    from wagtail.blocks import BoundBlock
    from wagtail.models import Page

# Editor comment pins attach to FieldBlock widgets, not StreamChild wrappers, so a
# block's contentpath ends on the first of these fields it has.
DEFAULT_LABEL_FIELDS = (
    "text",
    "title",
    "headline",
    "placeholder",
    "label",
    "fineprint",
    "body",
    "description",
    "eyebrow",
)


def _label_fields() -> tuple[str, ...]:
    return tuple(getattr(settings, "WAGTAIL_LIVE_COMMENTS_LABEL_FIELDS", DEFAULT_LABEL_FIELDS))


def stream_field_names(page: Page) -> list[str]:
    """Names of the StreamFields on ``page``'s specific model."""
    model = getattr(page, "specific_class", None) or type(page)
    return [field.name for field in model._meta.get_fields() if isinstance(field, StreamField)]


def _stream_values(page: Page) -> Iterator[tuple[str, StreamValue]]:
    for name in stream_field_names(page):
        value = getattr(page, name, None)
        if isinstance(value, StreamValue):
            yield name, value


# Adapted from wagtail-inspect 0.1.1 (block_map.blocks_for_field); keep in sync by hand.
def _child_ids(value: object) -> Iterator[str]:
    if isinstance(value, StreamValue):
        for child in value:
            if child.id:
                yield str(child.id)
            yield from _child_ids(child.value)
    elif isinstance(value, ListValue):
        for child in value.bound_blocks:
            if isinstance(child, str):
                continue
            if child.id:
                yield str(child.id)
            yield from _child_ids(child.value)
    elif isinstance(value, dict):
        for field_value in value.values():
            yield from _child_ids(field_value)


def block_ids(page: Page) -> list[str]:
    """UUIDs of every stream and list child, top-level and nested, in page order."""
    return [block_id for _name, value in _stream_values(page) for block_id in _child_ids(value)]


def _as_uuid(part: str) -> str | None:
    try:
        return str(uuid.UUID(part))
    except ValueError:
        return None


def block_id_from_contentpath(page: Page, contentpath: str) -> str | None:
    """Innermost block UUID in ``contentpath``, or ``None`` if it is not in a StreamField."""
    parts = (contentpath or "").split(".")
    if parts[0] not in stream_field_names(page):
        return None
    found = None
    for part in parts[1:]:
        found = _as_uuid(part) or found
    return found


def top_level_block_id(page: Page, contentpath: str) -> str | None:
    """The StreamChild UUID the editor gives a ``#block-<uuid>-section`` panel."""
    parts = (contentpath or "").split(".")
    if len(parts) < 2 or parts[0] not in stream_field_names(page):
        return None
    return _as_uuid(parts[1])


def _field_score(name: str, block: object, label_fields: tuple[str, ...]) -> int:
    if name in label_fields:
        return 0
    if isinstance(block, FieldBlock) and not isinstance(block, ChoiceBlock):
        return 1
    if isinstance(block, (StructBlock, StreamBlock, ListBlock)):
        return 2
    return 3


def _leaf_parts(bound: BoundBlock, parts: list[str], label_fields: tuple[str, ...]) -> list[str] | None:
    block = bound.block
    if isinstance(block, FieldBlock):
        return parts
    if isinstance(block, StructBlock):
        children = sorted(
            block.child_blocks.items(),
            key=lambda item: (_field_score(item[0], item[1], label_fields), item[0]),
        )
        for name, child_block in children:
            child_value = bound.value.get(name, child_block.get_default())
            found = _leaf_parts(child_block.bind(child_value), [*parts, name], label_fields)
            if found:
                return found
        return None
    if isinstance(block, (StreamBlock, ListBlock)):
        children = bound.value if isinstance(block, StreamBlock) else bound.value.bound_blocks
        for child in children:
            found = _leaf_parts(child, [*parts, str(child.id)], label_fields)
            if found:
                return found
    return None


def _find_parts(value: object, parts: list[str], block_id: str, label_fields: tuple[str, ...]) -> list[str] | None:
    if isinstance(value, (StreamValue, ListValue)):
        children = value if isinstance(value, StreamValue) else value.bound_blocks
        for child in children:
            child_id = getattr(child, "id", None)
            child_parts = [*parts, str(child_id)] if child_id else parts
            if child_id and str(child_id) == block_id:
                return _leaf_parts(child, child_parts, label_fields)
            found = _find_parts(child.value, child_parts, block_id, label_fields)
            if found:
                return found
    elif isinstance(value, dict):
        for name, field_value in value.items():
            found = _find_parts(field_value, [*parts, str(name)], block_id, label_fields)
            if found:
                return found
    return None


def contentpath_for_block(page: Page, block_id: str) -> str | None:
    """Field path the editor can pin for ``block_id``, e.g. ``body.<uuid>.text``."""
    label_fields = _label_fields()
    for name, value in _stream_values(page):
        parts = _find_parts(value, [name], str(block_id), label_fields)
        if parts:
            return ".".join(parts)
    return None
