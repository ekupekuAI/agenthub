---
name: git-commit-message
description: Write a clear, conventional commit message for the staged changes. Use when the user asks for a commit message or is about to commit.
license: MIT
metadata:
  category: git
  tags: git commit conventional-commits message
---

# Git commit message

Write one commit message that explains the staged change to a future reader.

## Gather the change

1. Run `git diff --cached --stat` to see which files are staged. The helper
   `scripts/staged-summary.sh` prints the same summary plus the current branch.
2. Run `git diff --cached` and read it. If nothing is staged, say so and stop: do not stage
   files on the user's behalf.
3. Look at `git log --oneline -10` to match the project's existing style.

## Format

Follow the Conventional Commits shape unless the history clearly uses another style:

```
<type>(<optional scope>): <summary in the imperative, max 72 chars>

<body: what changed and why, wrapped at 72 columns>

<footer: BREAKING CHANGE: ..., Refs: #123>
```

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`.
- The summary says what the commit does ("add retry to upload client"), not what you did
  ("added", "fixing").
- The body explains *why*. The diff already shows *how*.
- Mention user-visible behaviour changes and anything a reviewer must check.
- One logical change per commit. If the diff mixes unrelated changes, suggest splitting it.

## Output

Show the message in a code block. Do not run `git commit` unless the user asks you to.
