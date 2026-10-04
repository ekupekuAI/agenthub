#!/bin/sh
# Prints the current branch and a summary of staged changes. Read-only.
set -eu
printf 'branch: %s\n' "$(git rev-parse --abbrev-ref HEAD)"
git diff --cached --stat
