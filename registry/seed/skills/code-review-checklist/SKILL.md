---
name: code-review-checklist
description: Review a code change with a structured checklist covering correctness, security, tests, readability and operability. Use when asked to review a diff, branch or pull request.
license: MIT
metadata:
  category: code-review
  tags: review pull-request quality checklist
---

# Code review checklist

Review the change for problems that matter, in priority order, and say plainly when it looks
good.

## 1. Understand the intent

Read the description, linked issue and the full diff before commenting. State in one sentence
what the change is meant to do. If you cannot, ask.

## 2. Correctness

- Does the code do what the description says, including edge cases: empty input, nulls,
  very large input, concurrent calls, time zones, and non-ASCII text?
- Are errors handled, or at least surfaced? Look for swallowed exceptions.
- Are resources (files, connections, timers) released on every path?

## 3. Security

- Is all external input validated before use?
- Queries, shell commands and HTML are built safely: parameters, argument arrays, escaping.
- Authorization is checked on the server for every new route or action.
- No credentials, tokens or keys are committed, logged or sent to the client.

## 4. Tests

- New behaviour has tests, including at least one failure path.
- Tests would actually fail if the change were reverted.
- No sleeps, network calls or order dependence in unit tests.

## 5. Readability and design

- Names say what things are. Functions do one thing.
- The change follows the patterns already used in the codebase.
- Dead code, debug output and commented-out blocks are removed.

## 6. Operability

- Logs and metrics are enough to debug this in production, without logging personal data.
- Migrations and configuration changes are backward compatible or called out.

## Output

Group comments as **Blocking**, **Should fix** and **Nit**. Each comment names the file and
line, explains the problem, and suggests a fix. End with a one-line overall verdict.
