import pytest
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.test import Client
from wagtail.models import Comment, GroupPagePermission

from tests.backend.helpers import XHR, blocks, create, url
from wagtail_live_comments.comments import PageComments
from wagtail_live_comments.mentions import mention_candidates, mentions_in, resolve_mentions

User = get_user_model()


@pytest.fixture
def editors_group(live_page):
    group = Group.objects.create(name="Content Editors")
    group.permissions.add(Permission.objects.get(codename="access_admin"))
    GroupPagePermission.objects.create(group=group, page=live_page.get_parent(), permission_type="change")
    return group


@pytest.fixture
def colleague(editors_group):
    user = User.objects.create_user(username="ana.silva", password="password", first_name="Ana", last_name="Silva")
    user.groups.add(editors_group)
    return user


@pytest.fixture
def outsider(db):
    group = Group.objects.create(name="Readers")
    user = User.objects.create_user(username="reader", password="password")
    user.groups.add(group)
    return user


def _candidates(client, page, **params):
    return client.get(url("mention_candidates", page_id=page.pk), params)


@pytest.mark.usefixtures("colleague", "outsider")
def test_candidates_are_people_and_groups_who_can_edit_the_page(editor_client, live_page, editors_group):
    payload = _candidates(editor_client, live_page).json()

    assert payload["ok"] is True
    assert [user["token"] for user in payload["users"]] == ["@ana.silva"]
    assert payload["users"][0]["label"] == "Ana Silva"
    groups = {group["token"]: group["id"] for group in payload["groups"]}
    assert groups == {"@[Content Editors]": editors_group.pk}


def test_candidates_filter_by_query(editor_client, live_page, colleague, editors_group):
    by_name = _candidates(editor_client, live_page, q="silv").json()
    no_match = _candidates(editor_client, live_page, q="zzz").json()

    assert [user["id"] for user in by_name["users"]] == [colleague.pk]
    assert by_name["groups"] == []
    assert no_match["users"] == []
    assert no_match["groups"] == []


def test_candidates_require_edit_permission(live_page, outsider):
    outsider.user_permissions.add(Permission.objects.get(codename="access_admin"))
    client = Client(**XHR)
    anonymous = _candidates(client, live_page)
    client.force_login(outsider)
    reader = _candidates(client, live_page)

    assert anonymous.status_code == 403
    assert reader.status_code == 403
    assert reader.json()["error"] == "auth"


def test_candidates_endpoint_is_read_only(editor_client, live_page):
    assert editor_client.post(url("mention_candidates", page_id=live_page.pk)).status_code == 405


@pytest.mark.usefixtures("colleague", "outsider", "editors_group")
def test_only_mentionable_tokens_resolve(live_page):
    text = "Thanks @ana.silva. Looping in @[Content Editors], @reader, @[Readers] and nobody@example.com."

    found = mentions_in(text, resolve_mentions(live_page, [text]))

    assert [(m["type"], m["token"]) for m in found] == [("user", "@ana.silva"), ("group", "@[Content Editors]")]


def test_created_comment_and_config_carry_mentions(editor_client, editor, live_page, colleague, editors_group):
    heading_id = str(blocks(live_page)["heading"].id)

    created = create(editor_client, live_page, heading_id, "@ana.silva can you check?").json()["comment"]
    reply = editor_client.post(
        created["replyUrl"], data={"text": "Also @[Content Editors]"}, content_type="application/json"
    ).json()["reply"]

    assert [m["id"] for m in created["mentions"]] == [colleague.pk]
    assert [m["id"] for m in reply["mentions"]] == [editors_group.pk]
    grouped = PageComments(live_page, editor).config()["comments"][heading_id]
    assert grouped[0]["mentions"] == created["mentions"]
    assert grouped[0]["replies"][0]["mentions"] == reply["mentions"]
    # Stored as plain text, so the editor's comment sidebar reads naturally.
    assert Comment.objects.get().text == "@ana.silva can you check?"


@pytest.mark.usefixtures("colleague")
def test_editing_a_comment_returns_its_new_mentions(editor_client, live_page):
    created = create(editor_client, live_page, blocks(live_page)["heading"].id, "No mentions yet").json()["comment"]

    edited = editor_client.post(
        created["editUrl"], data={"text": "Now with @ana.silva"}, content_type="application/json"
    ).json()

    assert created["mentions"] == []
    assert [m["token"] for m in edited["mentions"]] == ["@ana.silva"]


def test_candidates_cap_results(live_page, editors_group):
    for index in range(12):
        User.objects.create_user(username=f"user{index:02}").groups.add(editors_group)

    assert len(mention_candidates(live_page)["users"]) == 8


@pytest.mark.usefixtures("outsider")
def test_groups_without_page_permissions_count_when_an_editor_is_in_them(live_page, editor):
    # A plain "team" group with no page permissions of its own.
    reviewers = Group.objects.create(name="Reviewers")
    editor.groups.add(reviewers)

    tokens = [group["token"] for group in mention_candidates(live_page, "rev")["groups"]]
    every_group = [group["token"] for group in mention_candidates(live_page)["groups"]]

    assert tokens == ["@[Reviewers]"]
    # Readers only holds someone who cannot edit the page.
    assert "@[Readers]" not in every_group


@pytest.mark.usefixtures("colleague", "editors_group")
def test_candidates_endpoint_resolves_tokens_for_the_editor(editor_client, live_page):
    payload = _candidates(
        editor_client, live_page, tokens=["@ana.silva", "@[Content Editors]", "@nobody", "@[Readers]"]
    ).json()

    assert sorted(m["token"] for m in payload["mentions"]) == ["@[Content Editors]", "@ana.silva"]
