"""Mounted under the Wagtail admin at ``live-comments/`` by ``wagtail_hooks.register_admin_urls``."""

from django.urls import path

from . import views

app_name = "wagtail_live_comments"

_comment = "pages/<int:page_id>/comments/<int:comment_id>/"
_reply = f"{_comment}replies/<int:reply_id>/"

urlpatterns = [
    path("pages/<int:page_id>/", views.create, name="create"),
    path("pages/<int:page_id>/mention-candidates/", views.mention_candidates, name="mention_candidates"),
    path(f"{_comment}replies/", views.reply_create, name="reply_create"),
    path(f"{_comment}edit/", views.edit, name="edit"),
    path(f"{_comment}delete/", views.delete, name="delete"),
    path(f"{_comment}resolve/", views.resolve, name="resolve"),
    path(f"{_reply}edit/", views.edit, name="reply_edit"),
    path(f"{_reply}delete/", views.delete, name="reply_delete"),
]
