"""@mentions in live-page comments.

Mentions stay plain text in ``Comment.text`` / ``CommentReply.text`` so the
Wagtail editor's comment sidebar still reads naturally:

- a user is ``@username``
- a group is ``@[Group name]`` (group names may contain spaces)

Only people who can edit the page are mentionable, plus groups that grant that
or contain such an editor, so a mention always reaches someone who can open the
page. Mentions are highlight-only: nothing is sent to the people mentioned.
"""

from __future__ import annotations

import re
import typing as t

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.db.models import Q
from wagtail.models import GroupPagePermission
from wagtail.permission_policies.pages import PagePermissionPolicy

if t.TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

    from django.contrib.auth.models import AbstractBaseUser
    from django.db.models import QuerySet
    from wagtail.models import Page

MENTION_CANDIDATE_LIMIT = 8
# Longest username / group name a mention can carry (Django caps both at 150).
MENTION_MAX_LENGTH = 150

# Not preceded by a word character or "@", so "name@example.com" is no mention.
# MENTION_RE in static/wagtail_live_comments/js/live-comments.js must stay in step.
_MENTION_RE = re.compile(
    rf"(?<![\w@])@(?:\[(?P<group>[^\]\n]{{1,{MENTION_MAX_LENGTH}}})\]"
    rf"|(?P<user>[\w.@+-]{{1,{MENTION_MAX_LENGTH}}}))"
)


class Mention(t.TypedDict):
    type: t.Literal["user", "group"]
    id: int
    label: str
    token: str


def user_token(user: AbstractBaseUser) -> str:
    return f"@{user.get_username()}"


def group_token(group: Group) -> str:
    return f"@[{group.name}]"


def mentionable_users(page: Page) -> QuerySet[t.Any]:
    """Active users who can edit ``page`` (superusers included)."""
    return PagePermissionPolicy().users_with_permission_for_instance("change", page)


def mentionable_groups(page: Page) -> QuerySet[Group]:
    """Groups relevant to ``page``: granting edit on it, or with an editor in them.

    The second case covers teams kept as plain groups (no page permissions of
    their own) whose members edit through another group or as superusers.
    """
    granting = GroupPagePermission.objects.filter(
        page__in=page.get_ancestors(inclusive=True),
        permission__codename="change_page",
    ).values("group_id")
    with_editors = mentionable_users(page).values("groups")
    return Group.objects.filter(Q(pk__in=granting) | Q(pk__in=with_editors))


def display_name(user: AbstractBaseUser) -> str:
    """Full name, else username: how comments and mentions name a person."""
    full_name = str(getattr(user, "get_full_name", lambda: "")() or "").strip()
    return full_name or user.get_username()


def _user_mention(user: AbstractBaseUser) -> Mention:
    return {
        "type": "user",
        "id": t.cast("int", user.pk),
        "label": display_name(user),
        "token": user_token(user),
    }


def _group_mention(group: Group) -> Mention:
    return {
        "type": "group",
        "id": group.pk,
        "label": group.name,
        "token": group_token(group),
    }


def mention_candidates(
    page: Page,
    query: str = "",
    *,
    exclude_user: t.Any = None,
) -> dict[str, list[Mention]]:
    """Users and groups to offer in the ``@`` picker, best matches first."""
    query = query.strip()
    users = mentionable_users(page)
    groups = mentionable_groups(page)
    name_fields = _name_fields()
    if query:
        match = Q()
        for field in (get_user_model().USERNAME_FIELD, *name_fields):
            match |= Q(**{f"{field}__icontains": query})
        users = users.filter(match)
        groups = groups.filter(name__icontains=query)
    if getattr(exclude_user, "pk", None) is not None:
        users = users.exclude(pk=exclude_user.pk)
    return {
        "users": [_user_mention(user) for user in users.order_by(*name_fields, "pk")[:MENTION_CANDIDATE_LIMIT]],
        "groups": [_group_mention(group) for group in groups.order_by("name")[:MENTION_CANDIDATE_LIMIT]],
    }


def _name_fields() -> tuple[str, ...]:
    """``first_name`` / ``last_name`` where the user model has them."""
    names = {field.name for field in get_user_model()._meta.get_fields()}
    return tuple(name for name in ("first_name", "last_name") if name in names)


def _raw_tokens(texts: Iterable[str]) -> tuple[set[str], set[str]]:
    usernames: set[str] = set()
    group_names: set[str] = set()
    for text in texts:
        for match in _MENTION_RE.finditer(text or ""):
            if match.group("group"):
                group_names.add(match.group("group"))
            else:
                username = match.group("user")
                usernames.add(username)
                # "@luan." / "@luan," at the end of a sentence.
                usernames.add(username.rstrip(".-"))
    return usernames, group_names


def resolve_mentions(page: Page, texts: Iterable[str]) -> dict[str, Mention]:
    """Mentionable people/groups referenced in ``texts``, keyed by their token."""
    usernames, group_names = _raw_tokens(texts)
    index: dict[str, Mention] = {}
    if usernames:
        username_field = get_user_model().USERNAME_FIELD
        for user in mentionable_users(page).filter(**{f"{username_field}__in": usernames}):
            mention = _user_mention(user)
            index[mention["token"]] = mention
    if group_names:
        for group in mentionable_groups(page).filter(name__in=group_names):
            mention = _group_mention(group)
            index[mention["token"]] = mention
    return index


def mentions_in(text: str, index: Mapping[str, Mention]) -> list[Mention]:
    """Resolved mentions that appear in ``text``, in order, without repeats."""
    found: list[Mention] = []
    seen: set[str] = set()
    for match in _MENTION_RE.finditer(text or ""):
        token = match.group(0)
        if match.group("user") and token not in index:
            token = token.rstrip(".-")
        mention = index.get(token)
        if mention and token not in seen:
            seen.add(token)
            found.append(mention)
    return found
