import json
import re
import uuid

import pytest
from django.contrib.auth import get_user_model
from django.template.loader import render_to_string
from django.test import Client, override_settings
from django.urls import reverse
from wagtail.admin.templatetags.wagtailadmin_tags import avatar_url
from wagtail.models import Comment, CommentReply, PageSubscription, Revision

from tests.backend.helpers import XHR, blocks, create, url
from wagtail_live_comments.comments import PageComments
from wagtail_live_comments.models import CommentAnchor

User = get_user_model()


def _config(page, user):
    return PageComments(page, user).config()


def _comments_data_from_comment_panel(page, user):
    """CommentApp payload the page-edit Comment panel serializes as #comments-data."""
    instance = page.get_latest_revision_as_object()
    subscription, _created = PageSubscription.objects.get_or_create(
        page=page, user=user, defaults={"comment_notifications": False}
    )
    form = instance.get_edit_handler().get_form_class()(
        instance=instance, subscription=subscription, parent_page=page.get_parent(), for_user=user
    )
    html = render_to_string(
        "wagtailadmin/panels/comments/comment_panel.html", {"comments_data": form.serialize_comments(user)}
    )
    match = re.search(r'<script id="comments-data" type="application/json">(.*?)</script>', html, flags=re.DOTALL)
    assert match is not None
    return json.loads(match.group(1))


def _replace_body_in_draft(page):
    page.body = [("heading", "Draft-only heading")]
    page.save_revision()
    return str(page.get_latest_revision_as_object().body[0].id)


# -- Permissions ---------------------------------------------------------------------


def test_anonymous_create_is_refused(live_page):
    response = create(Client(**XHR), live_page, blocks(live_page)["heading"].id)

    assert response.status_code == 403
    assert Comment.objects.count() == 0


def test_user_without_edit_permission_is_forbidden(live_page):
    reader = User.objects.create_user(username="reader", password="password")
    reader.user_permissions.add(_access_admin())
    client = Client(**XHR)
    client.force_login(reader)

    response = create(client, live_page, blocks(live_page)["heading"].id)

    assert response.status_code == 403
    assert response.json() == {
        "ok": False,
        "error": "auth",
        "message": "You do not have permission to comment on this page.",
    }
    assert Comment.objects.count() == 0


def test_permission_is_checked_before_the_body_is_read(live_page):
    reader = User.objects.create_user(username="reader", password="password")
    reader.user_permissions.add(_access_admin())
    client = Client(**XHR)
    client.force_login(reader)

    response = client.post(url("create", page_id=live_page.pk), data="{not json", content_type="application/json")

    assert response.status_code == 403
    assert response.json()["error"] == "auth"


@override_settings(WAGTAIL_LIVE_COMMENTS_ENABLED=False)
def test_disabled_setting_refuses_create(editor_client, live_page):
    response = create(editor_client, live_page, blocks(live_page)["heading"].id)

    assert response.status_code == 403
    assert response.json()["message"] == "Comments are disabled."


def test_csrf_failure_is_refused(editor, live_page):
    client = Client(enforce_csrf_checks=True, **XHR)
    client.force_login(editor)

    response = create(client, live_page, blocks(live_page)["heading"].id)

    assert response.status_code == 403
    assert Comment.objects.count() == 0


def _access_admin():
    from django.contrib.auth.models import Permission

    return Permission.objects.get(content_type__app_label="wagtailadmin", codename="access_admin")


# -- Creating ------------------------------------------------------------------------


def test_create_stores_a_native_comment_without_a_new_revision(editor_client, editor, live_page):
    heading_id = str(blocks(live_page)["heading"].id)
    latest_before = live_page.get_latest_revision()
    revisions_before = Revision.page_revisions.filter(object_id=str(live_page.pk)).count()

    response = create(editor_client, live_page, heading_id, "Please check this copy.")

    comment = Comment.objects.get()
    assert response.status_code == 201
    payload = response.json()["comment"]
    assert payload["id"] == comment.pk
    assert payload["contentpath"] == f"body.{heading_id}"
    assert payload["text"] == "Please check this copy."
    assert payload["revision_created"] == latest_before.pk
    assert payload["position"] is None
    assert payload["author"] == editor.username
    assert payload["avatar"] == avatar_url(editor, size=50)
    assert payload["createdAt"] == comment.created_at.isoformat()
    assert payload["mine"] is True
    assert payload["replies"] == []
    assert "x" not in payload
    ids = {"page_id": live_page.pk, "comment_id": comment.pk}
    assert payload["replyUrl"] == url("reply_create", **ids)
    assert payload["editUrl"] == url("edit", **ids)
    assert payload["deleteUrl"] == url("delete", **ids)
    assert payload["resolveUrl"] == url("resolve", **ids)
    assert payload["editorUrl"] == (
        reverse("wagtailadmin_pages:edit", args=[live_page.pk]) + f"#block-{heading_id}-section"
    )
    assert comment.user_id == editor.pk
    assert comment.position == ""
    assert live_page.get_latest_revision().pk == latest_before.pk
    assert Revision.page_revisions.filter(object_id=str(live_page.pk)).count() == revisions_before


def test_create_accepts_form_posts(editor_client, live_page):
    heading_id = str(blocks(live_page)["heading"].id)

    response = editor_client.post(
        url("create", page_id=live_page.pk), data={"block_uuid": heading_id, "text": "Form post."}
    )

    assert response.status_code == 201


def test_create_targets_a_nested_card(editor_client, live_page):
    b = blocks(live_page)

    response = create(editor_client, live_page, b["card"].id)

    assert response.status_code == 201
    assert Comment.objects.get().contentpath == (
        f"body.{b['section'].id}.content.{b['grid'].id}.cards.{b['card'].id}.headline"
    )
    assert response.json()["comment"]["editorUrl"].endswith(f"#block-{b['section'].id}-section")


def test_create_targets_a_second_stream_field(editor_client, editor, live_page):
    note = blocks(live_page)["note"]

    response = create(editor_client, live_page, note.id)

    assert response.status_code == 201
    assert Comment.objects.get().contentpath == f"sidebar.{note.id}"
    assert str(note.id) in _config(live_page, editor)["comments"]


def test_create_stores_the_click_point_on_an_anchor(editor_client, editor, live_page):
    heading_id = str(blocks(live_page)["heading"].id)

    response = create(editor_client, live_page, heading_id, position={"x": 0.2, "y": 0.15})

    comment = Comment.objects.get()
    assert response.status_code == 201
    # Comment.position belongs to Wagtail's editor; the point lives on the anchor.
    assert comment.position == ""
    anchor = CommentAnchor.objects.get(comment=comment)
    assert (anchor.x, anchor.y) == (0.2, 0.15)
    created = response.json()["comment"]
    assert created["position"] == {"x": 0.2, "y": 0.15}
    assert (created["x"], created["y"]) == (0.2, 0.15)
    grouped = _config(live_page, editor)["comments"][heading_id]
    assert grouped[0]["position"] == {"x": 0.2, "y": 0.15}
    assert grouped[0]["replyUrl"] == created["replyUrl"]


@pytest.mark.parametrize(
    "position",
    [{"x": 1.2, "y": 0.1}, {"x": "left", "y": 0.1}, None, "0.5,0.5"],
)
def test_out_of_range_click_points_are_dropped(editor_client, live_page, position):
    response = create(editor_client, live_page, blocks(live_page)["heading"].id, position=position)

    assert response.status_code == 201
    assert response.json()["comment"]["position"] is None
    assert not CommentAnchor.objects.exists()


def test_click_point_survives_the_editor_rewriting_position(editor_client, editor, live_page):
    heading_id = str(blocks(live_page)["heading"].id)
    create(editor_client, live_page, heading_id, position={"x": 0.4, "y": 0.6})
    # Draftail rewrites the position of comments on rich text fields to its own
    # inline-range JSON whenever the field changes in the editor.
    Comment.objects.update(position="[]")

    grouped = _config(live_page, editor)["comments"][heading_id]

    assert grouped[0]["position"] == {"x": 0.4, "y": 0.6}


def test_create_on_an_unpublished_page(editor_client, live_page):
    live_page.unpublish()
    heading_id = str(live_page.get_latest_revision_as_object().body[0].id)

    response = create(editor_client, live_page, heading_id, "From preview.")

    assert response.status_code == 201
    assert Comment.objects.get().page_id == live_page.pk


# -- Validation and stale blocks ---------------------------------------------------------


def test_missing_block_uuid_is_a_validation_error(editor_client, live_page):
    response = editor_client.post(
        url("create", page_id=live_page.pk), data={"text": "No target."}, content_type="application/json"
    )

    assert response.status_code == 400
    assert response.json() == {"ok": False, "error": "validation", "message": "A block UUID is required."}


def test_invalid_block_uuid_is_a_validation_error(editor_client, live_page):
    response = create(editor_client, live_page, "not-a-uuid")

    assert response.status_code == 400
    assert response.json()["message"] == "Block UUID is not a valid UUID."


def test_blank_text_is_a_validation_error(editor_client, live_page):
    response = create(editor_client, live_page, blocks(live_page)["heading"].id, "   ")

    assert response.status_code == 400
    assert response.json()["message"] == "Comment text is required."


@pytest.mark.parametrize("body", ["{not json", "[1, 2]"])
def test_malformed_json_is_a_validation_error(editor_client, live_page, body):
    response = editor_client.post(url("create", page_id=live_page.pk), data=body, content_type="application/json")

    assert response.status_code == 400
    assert response.json()["error"] == "validation"


def test_block_missing_from_the_latest_draft_is_stale(editor_client, live_page):
    live_id = str(blocks(live_page)["heading"].id)
    draft_id = _replace_body_in_draft(live_page)
    assert draft_id != live_id

    response = create(editor_client, live_page, live_id)

    assert response.status_code == 409
    assert response.json() == {
        "ok": False,
        "error": "stale_block",
        "message": "That block is not present on the latest draft.",
    }
    assert Comment.objects.count() == 0


def test_unknown_block_is_stale(editor_client, live_page):
    response = create(editor_client, live_page, uuid.uuid4())

    assert response.status_code == 409
    assert response.json()["error"] == "stale_block"


def test_an_emptied_draft_falls_back_to_the_live_blocks(editor_client, live_page):
    live_id = str(blocks(live_page)["heading"].id)
    live_page.body = []
    live_page.sidebar = []
    live_page.save_revision()

    response = create(editor_client, live_page, live_id)

    assert response.status_code == 201
    assert Comment.objects.get().contentpath == f"body.{live_id}"


# -- Round-trip into the page editor -------------------------------------------------------


def test_created_comment_appears_in_the_page_editor(editor_client, editor, live_page):
    heading_id = str(blocks(live_page)["heading"].id)
    create(editor_client, live_page, heading_id, "Visible in the page editor.")

    comments_data = _comments_data_from_comment_panel(live_page, editor)

    assert comments_data["user"] == editor.pk
    assert any(
        item["contentpath"] == f"body.{heading_id}" and item["text"] == "Visible in the page editor."
        for item in comments_data["comments"]
    )


def test_comment_on_a_draft_only_block_appears_in_the_page_editor(editor_client, editor, live_page):
    draft_id = _replace_body_in_draft(live_page)

    response = create(editor_client, live_page, draft_id)

    assert response.status_code == 201
    paths = [item["contentpath"] for item in _comments_data_from_comment_panel(live_page, editor)["comments"]]
    assert f"body.{draft_id}" in paths


# -- Replies, edit, delete, resolve ----------------------------------------------------------


def test_reply_on_an_existing_comment(editor_client, editor, live_page):
    heading_id = str(blocks(live_page)["heading"].id)
    create(editor_client, live_page, heading_id, "Parent comment.")
    comment = Comment.objects.get()

    response = editor_client.post(
        url("reply_create", page_id=live_page.pk, comment_id=comment.pk),
        data={"text": "A reply."},
        content_type="application/json",
    )

    reply = CommentReply.objects.get()
    assert response.status_code == 201
    payload = response.json()["reply"]
    assert payload["text"] == "A reply."
    assert payload["mine"] is True
    ids = {"page_id": live_page.pk, "comment_id": comment.pk, "reply_id": reply.pk}
    assert payload["editUrl"] == url("reply_edit", **ids)
    assert payload["deleteUrl"] == url("reply_delete", **ids)
    grouped = _config(live_page, editor)["comments"][heading_id]
    assert grouped[0]["replies"][0]["editUrl"] == payload["editUrl"]


def test_edit_delete_resolve_follow_editor_permissions(editor_client, live_page):
    other = User.objects.create_superuser(username="other-editor", password="password")
    heading_id = str(blocks(live_page)["heading"].id)
    create(editor_client, live_page, heading_id, "Original comment.")
    comment = Comment.objects.get()
    editor_client.post(
        url("reply_create", page_id=live_page.pk, comment_id=comment.pk),
        data={"text": "Original reply."},
        content_type="application/json",
    )
    reply = CommentReply.objects.get()
    ids = {"page_id": live_page.pk, "comment_id": comment.pk}

    edited = editor_client.post(url("edit", **ids), data={"text": "Edited."}, content_type="application/json")
    reply_edited = editor_client.post(
        url("reply_edit", reply_id=reply.pk, **ids), data={"text": "Edited reply."}, content_type="application/json"
    )

    assert edited.json() == {"ok": True, "text": "Edited.", "mentions": []}
    assert reply_edited.status_code == 200
    reply.refresh_from_db()
    assert reply.text == "Edited reply."

    other_client = Client(**XHR)
    other_client.force_login(other)
    hijack = other_client.post(url("edit", **ids), data={"text": "Hijack."}, content_type="application/json")
    assert hijack.status_code == 403
    assert hijack.json()["message"] == "You can only change your own comments."
    assert other_client.post(url("reply_delete", reply_id=reply.pk, **ids)).status_code == 403

    # Anyone who can edit the page may resolve, as in the page editor.
    assert other_client.post(url("resolve", **ids)).status_code == 200
    comment.refresh_from_db()
    assert comment.resolved_by_id == other.pk
    assert _config(live_page, other)["comments"] == {}
    resolved_again = editor_client.post(url("resolve", **ids))
    assert resolved_again.status_code == 400
    assert resolved_again.json()["message"] == "That comment is resolved."

    create(editor_client, live_page, heading_id, "To delete.")
    doomed = Comment.objects.get(resolved_at__isnull=True)
    deleted = editor_client.post(url("delete", page_id=live_page.pk, comment_id=doomed.pk))
    assert deleted.json() == {"ok": True}
    assert not Comment.objects.filter(pk=doomed.pk).exists()


def test_actions_on_another_pages_comment_are_not_found(editor_client, live_page, root_page):
    create(editor_client, live_page, blocks(live_page)["heading"].id)
    comment = Comment.objects.get()
    other_page = root_page.add_child(instance=type(live_page)(title="Other", slug="other"))

    response = editor_client.post(url("resolve", page_id=other_page.pk, comment_id=comment.pk))

    assert response.status_code == 404


def test_actions_are_post_only(editor_client, live_page):
    assert editor_client.get(url("create", page_id=live_page.pk)).status_code == 405


# -- Page config ---------------------------------------------------------------------------


def test_config_lists_every_block_and_the_editors_comments(editor_client, editor, live_page):
    b = blocks(live_page)
    create(editor_client, live_page, b["card"].id, "On the card.")

    config = _config(live_page, editor)

    assert config["pageId"] == live_page.pk
    assert config["createUrl"] == url("create", page_id=live_page.pk)
    assert config["mentionsUrl"] == url("mention_candidates", page_id=live_page.pk)
    assert config["cssUrl"].endswith("wagtail_live_comments/css/live-comments.css")
    second_card = b["grid"].value["cards"].bound_blocks[1]
    assert config["eligibleBlockIds"] == [
        *(str(b[name].id) for name in ("heading", "section", "text", "grid", "card")),
        str(second_card.id),
        str(b["note"].id),
    ]
    assert config["currentUser"] == editor.username
    assert config["comments"][str(b["card"].id)][0]["text"] == "On the card."


def test_config_reads_block_ids_from_the_latest_draft(editor, live_page):
    live_id = str(blocks(live_page)["heading"].id)
    draft_id = _replace_body_in_draft(live_page)

    ids = _config(live_page, editor)["eligibleBlockIds"]

    assert draft_id in ids
    assert live_id not in ids
