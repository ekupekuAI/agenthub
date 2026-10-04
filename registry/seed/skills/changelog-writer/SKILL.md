---
name: changelog-writer
description: Draft a human-readable changelog entry from the commits since the last release. Use when preparing a release or updating CHANGELOG.md.
license: MIT
metadata:
  category: docs
  tags: changelog release notes keep-a-changelog
---

# Changelog writer

Turn a range of commits into an entry that users of the project can read in a minute.

## Steps

1. Find the previous release: `git describe --tags --abbrev=0`. If there are no tags, ask the
   user which commit to start from.
2. List the changes: `git log <last-tag>..HEAD --no-merges --pretty=format:'%h %s'`.
3. Read `CHANGELOG.md` (if present) and follow its format exactly. Otherwise use the
   Keep a Changelog layout below.
4. Group entries under **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed** and
   **Security**. Leave out empty groups.
5. Rewrite each entry for users: describe the effect, not the implementation. Merge commits
   that belong together and drop pure refactors, test-only and CI-only changes.
6. Put breaking changes first and say what users must do.

## Layout

```
## [1.4.0] - 2026-10-04

### Added
- Export reports as CSV from the history page.

### Fixed
- Uploads no longer fail for file names containing spaces.
```

## Rules

- Use the date format already in the file (ISO 8601 by default).
- Keep each line to one sentence. Link issue numbers if the project does.
- Do not invent changes that are not in the log. If a commit message is unclear, list it
  under a "Needs review" note for the user instead of guessing.
- Show the entry and ask before editing `CHANGELOG.md`.
