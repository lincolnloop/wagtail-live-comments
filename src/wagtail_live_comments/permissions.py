from __future__ import annotations

import typing as t

from django.conf import settings

if t.TYPE_CHECKING:
    from wagtail.models import Page


def comments_enabled() -> bool:
    """``WAGTAIL_LIVE_COMMENTS_ENABLED``, defaulting to ``WAGTAILADMIN_COMMENTS_ENABLED``."""
    default = getattr(settings, "WAGTAILADMIN_COMMENTS_ENABLED", True)
    return bool(getattr(settings, "WAGTAIL_LIVE_COMMENTS_ENABLED", default))


def can_edit(page: Page, user: t.Any) -> bool:
    """Signed-in ``user`` may edit ``page``: who may read and write its comments."""
    return bool(
        getattr(page, "pk", None)
        and getattr(user, "is_authenticated", False)
        and page.permissions_for_user(user).can_edit()
    )


def can_comment(page: Page, user: t.Any) -> bool:
    """Whether ``user`` gets live-page comments (UI, block ids, endpoints) on ``page``."""
    return comments_enabled() and can_edit(page, user)
