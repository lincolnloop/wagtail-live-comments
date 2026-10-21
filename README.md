# Wagtail Live Comments

Editors comment on blocks of the live (or previewed) page, from the Wagtail userbar.
Comments are ordinary Wagtail page comments: they show up in the page editor's comment
sidebar, with replies, resolving and @mentions, and editor comments show up on the live
page as pins.

- **Add a Comment** in the userbar: pick a block (top-level or nested) and write.
- Pins sit where you clicked; click one to read, reply, edit, delete or resolve.
- `@username` and `@[Group name]` mention people and groups who can edit the page
  (highlight-only; nothing is sent).
- Each comment links into the page editor at the block's panel.

Only users who can edit the page see any of it. Anonymous and non-editor responses are
unchanged.

## Requirements

Python 3.12+, Django 4.2+, Wagtail 7.3+ (the first release whose userbar items carry
their own `Media`), with Wagtail comments on (`WAGTAILADMIN_COMMENTS_ENABLED`, the
default).

## Install

```sh
uv add "wagtail-live-comments @ https://github.com/lincolnloop/wagtail-live-comments/releases/download/v0.1.0/wagtail_live_comments-0.1.0-py3-none-any.whl"
```

```python
INSTALLED_APPS = [
    # ...
    "wagtail.admin",
    "wagtail",
    "wagtail_live_comments",
]
```

Then run `python manage.py migrate`. That's all: the endpoints register under the
Wagtail admin URLs (`<admin>/live-comments/`), and the userbar item brings its own
script, stylesheet and page config. No template changes.

Your page templates need `{% wagtailuserbar %}` and must render StreamField blocks with
`{% include_block %}` (or `{{ block }}`). A block can be commented on when its template
has a root element: the package adds `data-block-id` and `data-block-type` to that
element for editors.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `WAGTAIL_LIVE_COMMENTS_ENABLED` | `WAGTAILADMIN_COMMENTS_ENABLED` | Turn the feature off without turning off editor comments. |
| `WAGTAIL_LIVE_COMMENTS_LABEL_FIELDS` | `("text", "title", "headline", "placeholder", "label", "fineprint", "body", "description", "eyebrow")` | Struct child names preferred as the field a comment pins to in the editor. |

## How it works

- **Block ids.** For editors, `Page.serve` and `serve_preview` render with
  `data-block-id` / `data-block-type` injected into the first tag of each block, nested
  stream and list children included. Nothing wraps the block, so grid and flex layouts
  are untouched.
- **Comments.** Creating a comment stores a Wagtail `Comment` whose `contentpath` points
  at a field inside the block on the latest draft. No revision is created. The pin point
  is kept in `CommentAnchor`, because the page editor rewrites `Comment.position` on
  save.
- **Errors.** Endpoints answer `{"ok": false, "error": "auth" | "stale_block" |
  "validation", "message": "..."}`. If the answer isn't JSON (a CSRF failure or an
  expired admin session), the script reports a session error.

## Using with wagtail-inspect

Both packages can be installed together. Each one leaves output alone if it already
carries `data-block-id`, so they don't stamp the same block twice, whatever order the
apps are in. This package doesn't depend on wagtail-inspect: the few helpers they share
are copied here and marked `Duplicated from wagtail-inspect`.

## Development

```sh
just install           # uv sync --extra testing && bun install
just install-browsers  # Playwright Chromium, once
just run               # migrate, seed /demo/ and admin/admin, runserver
just test-all          # backend, frontend (Bun) and E2E (Playwright)
just tox               # backend across Django/Wagtail versions
```
