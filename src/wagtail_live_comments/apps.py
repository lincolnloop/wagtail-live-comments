from django.apps import AppConfig


class WagtailLiveCommentsConfig(AppConfig):
    """Django app configuration for Wagtail Live Comments."""

    name = "wagtail_live_comments"
    label = "wagtail_live_comments"
    verbose_name = "Wagtail Live Comments"
    default_auto_field = "django.db.models.AutoField"

    def ready(self) -> None:
        from . import annotate

        annotate.apply_patches()
