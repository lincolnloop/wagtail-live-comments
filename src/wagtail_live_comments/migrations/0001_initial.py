import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("wagtailcore", "0078_referenceindex"),
    ]

    operations = [
        migrations.CreateModel(
            name="CommentAnchor",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("x", models.FloatField()),
                ("y", models.FloatField()),
                (
                    "comment",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="+",
                        to="wagtailcore.comment",
                    ),
                ),
            ],
        ),
    ]
