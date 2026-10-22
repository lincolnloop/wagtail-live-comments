# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0]

### Added

- First release.
- "Add a Comment" userbar item on live and preview pages, for users who can edit the
  page.
- Comments on top-level and nested StreamField blocks in any StreamField on the page.
  They are stored as native Wagtail comments, and the editor links back to the block's
  panel.
- Pin points (`CommentAnchor`), replies, editing, deleting and resolving. One comment
  popover is open at a time; it fades in from its pin, with no motion under
  `prefers-reduced-motion`.
- `@user` / `@[Group]` mentions, in the live-page dialog and in the page editor's
  comment sidebar.
- JSON endpoints under the Wagtail admin (`<admin>/live-comments/`).
- Block marking through [wagtail-block-ids](https://github.com/lincolnloop/wagtail-block-ids)
  0.2.0, shared with wagtail-inspect.
