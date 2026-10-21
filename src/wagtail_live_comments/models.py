from django.db import models


class CommentAnchor(models.Model):
    """Where on its block a live-page comment was dropped (fractions 0-1 of the box).

    Kept off ``Comment.position``: for rich text fields Wagtail's editor owns that
    column and rewrites it to Draftail range JSON (``"[]"``) on any edit, which
    would wipe the pin's point.

    No reverse accessor (``related_name="+"``): ``Comment.save()`` builds
    ``update_fields`` from ``_meta.get_fields()``, so a reverse relation would
    break every later save of the comment, including the page editor's.
    """

    comment = models.OneToOneField(
        "wagtailcore.Comment",
        on_delete=models.CASCADE,
        related_name="+",
    )
    x = models.FloatField()
    y = models.FloatField()

    def __str__(self) -> str:
        return f"Comment {self.comment_id} at ({self.x:.2f}, {self.y:.2f})"
