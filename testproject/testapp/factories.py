"""Stream content shared by the demo seed and the tests."""

from wagtail.rich_text import RichText


def demo_stream():
    """``body`` with a heading and a section holding text and a card grid; ``sidebar`` with a note."""
    return {
        "body": [
            ("heading", "Welcome"),
            (
                "section",
                {
                    "style": "plain",
                    "content": [
                        ("text", RichText("<p>Section copy</p>")),
                        (
                            "card_grid",
                            {
                                "cards": [
                                    {"headline": "First card", "link_text": "Read more"},
                                    {"headline": "Second card", "link_text": ""},
                                ]
                            },
                        ),
                    ],
                },
            ),
        ],
        "sidebar": [("note", "Sidebar note")],
    }
