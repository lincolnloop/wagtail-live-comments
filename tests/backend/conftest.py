import pytest
from django.contrib.auth import get_user_model
from django.test import Client
from testapp.factories import demo_stream
from testapp.models import DemoPage
from wagtail.models import Locale, Page, Site

from tests.backend.helpers import XHR

# pytest-django reads DJANGO_SETTINGS_MODULE from pyproject.toml [tool.pytest.ini_options]

User = get_user_model()


@pytest.fixture
def root_page(db):
    Locale.objects.get_or_create(language_code="en")
    root = Page.add_root(title="Root", slug="root")
    Site.objects.create(hostname="localhost", root_page=root, is_default_site=True)
    return root


@pytest.fixture
def editor(db):
    return User.objects.create_superuser(username="editor", email="editor@example.com", password="password")


@pytest.fixture
def live_page(root_page):
    page = root_page.add_child(instance=DemoPage(title="Demo", slug="demo", **demo_stream()))
    page.save_revision().publish()
    page.refresh_from_db()
    return page


@pytest.fixture
def editor_client(editor):
    client = Client(**XHR)
    client.force_login(editor)
    return client
