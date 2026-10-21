from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand
from wagtail.models import Page, Site

from testapp.factories import demo_stream


class Command(BaseCommand):
    help = "Create an admin/admin superuser and a demo page at /demo/ (idempotent)."

    def handle(self, *args, **options):
        from testapp.models import DemoPage

        user_model = get_user_model()
        if not user_model.objects.filter(username="admin").exists():
            user_model.objects.create_superuser("admin", "admin@example.com", "admin")

        home = Site.objects.get(is_default_site=True).root_page
        if DemoPage.objects.filter(slug="demo").exists():
            self.stdout.write("Demo page already exists at /demo/")
            return
        page = DemoPage(title="Demo", slug="demo", **demo_stream())
        Page.objects.get(pk=home.pk).add_child(instance=page)
        page.save_revision().publish()
        self.stdout.write(self.style.SUCCESS("Demo page at /demo/ (log in as admin/admin)"))
