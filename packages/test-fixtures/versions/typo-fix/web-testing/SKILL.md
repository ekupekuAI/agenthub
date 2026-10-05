---
name: web-testing
description: Runs the project's Playwright end-to-end tests and summarizes failures. Use when the user asks to test the web app in a browser.
license: MIT
---

# Web testing

Run the Playwright suite with the bundled script:

```bash
bash scripts/run.sh
```

Pass a file or a `--grep` pattern to narrow the run. See the
[Playwright docs](https://playwright.dev/docs/intro) for test syntax.

When tests fail:

1. List each failing test with its file and line.
2. Quote the first failing assertion.
3. Suggest the smallest change that would make it pass.
