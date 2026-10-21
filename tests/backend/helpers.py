"""Shared helpers for backend tests."""

from django.urls import reverse

# The live-page script sends this, so Wagtail's admin check answers 403 instead of redirecting.
XHR = {"HTTP_X_REQUESTED_WITH": "XMLHttpRequest"}


def url(name, **kwargs):
    return reverse(f"wagtail_live_comments:{name}", kwargs=kwargs)


def create(client, page, block_id, text="A comment.", **extra):
    return client.post(
        url("create", page_id=page.pk),
        data={"block_uuid": str(block_id), "text": text, **extra},
        content_type="application/json",
    )


def blocks(page):
    """The demo page's blocks by role: heading, section, text, grid, card, note."""
    section = page.body[1]
    text, grid = section.value["content"]
    return {
        "heading": page.body[0],
        "section": section,
        "text": text,
        "grid": grid,
        "card": grid.value["cards"].bound_blocks[0],
        "note": page.sidebar[0],
    }
