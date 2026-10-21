from django.apps import AppConfig


class WagtailLiveCommentsConfig(AppConfig):
    """Django app configuration for Wagtail Live Comments."""

    name = "wagtail_live_comments"
    label = "wagtail_live_comments"
    verbose_name = "Wagtail Live Comments"
    default_auto_field = "django.db.models.AutoField"

    def ready(self) -> None:
        from wagtail_block_ids import register_page_marker

        from .permissions import can_comment

        # Editors who may comment get data-block-id on live and preview serves. No
        # display:contents wrappers: they break grid placement in host layouts.
        register_page_marker(lambda page, request: can_comment(page, getattr(request, "user", None)))
