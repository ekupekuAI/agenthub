---
name: web-testing
description: Write and debug reliable end-to-end browser tests with Playwright. Use when adding UI tests, fixing flaky tests, or reproducing a bug in a real browser.
license: MIT
compatibility: Requires Node.js 20+ and Playwright installed in the project.
metadata:
  category: testing
  tags: playwright e2e browser flaky ui
---

# Web testing

Use this skill to add end-to-end coverage for a user flow or to stabilise a flaky browser test.

## Before writing a test

1. Find the existing setup: look for `playwright.config.ts` and the folder named in its `testDir`.
2. Read one or two existing specs and copy their conventions (fixtures, naming, page objects).
3. Confirm how the app is started for tests (`webServer` in the config, or a separate command).

## Writing the test

- Describe the flow from the user's point of view: one `test()` per behaviour.
- Locate elements the way a user perceives them, in this order of preference:
  `getByRole`, `getByLabel`, `getByText`, `getByTestId`. Avoid CSS chains and XPath.
- Never use fixed sleeps. Rely on web-first assertions such as
  `await expect(locator).toBeVisible()`, which retry until the timeout.
- Keep each test independent: create the data it needs and do not rely on test order.
- Assert on outcomes the user can see, not on implementation details.

## Running

Run a single file while iterating, then the whole suite:

```
npx playwright test tests/checkout.spec.ts --project=chromium
npx playwright test
```

Use `--headed` or `--debug` only locally. The script `scripts/list-specs.mjs` prints the spec
files Playwright will pick up, which helps when a test is silently skipped.

## Fixing a flaky test

1. Reproduce it: `npx playwright test path/to.spec.ts --repeat-each=20`.
2. Open the trace of a failed run (`--trace on`) and find the first step that diverges.
3. Typical causes: an assertion that does not wait, shared state between tests, animations,
   or a network response that arrives late. Fix the cause; do not raise timeouts.
4. Run the repeat command again and only call it fixed after a clean run.

## Report back

Summarise which flows are covered, the command to run them, and any flakiness you could not
remove together with the evidence from the trace.
