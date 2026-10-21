from wagtail import blocks
from wagtail.fields import StreamField
from wagtail.models import Page


class CardBlock(blocks.StructBlock):
    headline = blocks.CharBlock()
    link_text = blocks.CharBlock(required=False)

    class Meta:
        template = "testapp/blocks/card.html"


class CardGridBlock(blocks.StructBlock):
    cards = blocks.ListBlock(CardBlock())

    class Meta:
        template = "testapp/blocks/card_grid.html"


class SectionBlock(blocks.StructBlock):
    style = blocks.ChoiceBlock(choices=[("plain", "Plain"), ("tinted", "Tinted")], default="plain")
    content = blocks.StreamBlock(
        [
            ("text", blocks.RichTextBlock(template="testapp/blocks/text.html")),
            ("card_grid", CardGridBlock()),
        ]
    )

    class Meta:
        template = "testapp/blocks/section.html"


class DemoPage(Page):
    """Two StreamFields, so comments must not assume one called ``body``."""

    body = StreamField(
        [
            ("heading", blocks.CharBlock(template="testapp/blocks/heading.html")),
            ("section", SectionBlock()),
        ],
        blank=True,
    )
    sidebar = StreamField(
        [("note", blocks.TextBlock(template="testapp/blocks/note.html"))],
        blank=True,
    )

    content_panels = [*Page.content_panels, "body", "sidebar"]
