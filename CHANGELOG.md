# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Loading a page's comments no longer runs a query per comment author for avatars,
  and builds the latest draft once instead of twice.

## [0.1.0]

### Added

- First release.
- "Add a Comment" userbar item on live and preview pages, for users who can edit the
  page.
- Comments on top-level and nested StreamField blocks in any StreamField on the page.
  They are stored as native Wagtail comments, and the editor links back to the block's
  panel.
- Pin points (`CommentAnchor`), replies, editing, deleting and resolving.
- `@user` / `@[Group]` mentions, in the live-page dialog and in the page editor's
  comment sidebar.
- JSON endpoints under the Wagtail admin (`<admin>/live-comments/`).
- Block marking through wagtail-block-ids, shared with wagtail-inspect.
