---
name: release-checklist
description: Walk through a pre-release checklist covering version, changelog, tests, tagging and a rollback plan. Use when the user is about to cut a release or publish a package.
license: MIT
metadata:
  category: release
  tags: release versioning semver tag checklist rollback
---

# Release checklist

Guide the user through a release one step at a time. Report the status of each item and stop
at the first blocker.

## Before the release

- [ ] The working tree is clean and on the release branch (`git status`).
- [ ] CI is green for the exact commit being released.
- [ ] The version follows semantic versioning: breaking change means a major bump, new
      feature means minor, fix only means patch.
- [ ] The version is updated everywhere it appears (manifest files, docs, constants).
- [ ] `CHANGELOG.md` has an entry for this version with today's date.
- [ ] Migrations, feature flags and configuration changes are listed in the release notes.
- [ ] Someone other than the author has reviewed the final diff.

## Cutting the release

- [ ] Create an annotated tag: `git tag -a v1.4.0 -m "v1.4.0"`.
- [ ] Ask the user before pushing the tag or publishing anything; these steps are public and
      hard to undo.
- [ ] Build artifacts from the tagged commit, not from a dirty tree.

## After the release

- [ ] Smoke-test the published artifact the way a user would install it.
- [ ] Watch errors and key metrics for the first hour.
- [ ] Write down the rollback plan: which previous version to restore and how. Published
      versions are usually immutable, so the fix for a bad release is a new patch release
      or a revocation, not an overwrite.

## Output

Return the checklist with each item marked done, skipped (with reason) or blocked.
