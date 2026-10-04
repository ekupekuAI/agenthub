---
name: unit-test-writer
description: Write focused unit tests for a function or module using the project's existing test framework. Use when adding tests for new or untested code, or when fixing a bug that needs a regression test.
license: MIT
metadata:
  category: testing
  tags: unit-tests vitest jest pytest tdd regression
---

# Unit test writer

Write small, fast tests that pin down behaviour and fail for the right reason.

## 1. Learn the project's conventions

- Identify the framework from the config and dependencies (Vitest, Jest, node:test, pytest).
- Find where tests live and how they are named, and copy that.
- Check the test command in the project manifest (for example the `test` script).

## 2. Decide what to test

List the behaviours of the unit under test before writing code:

- the normal case;
- boundaries (empty, zero, one, maximum, unicode);
- invalid input and the error it should raise;
- for a bug fix: the exact input that triggered the bug.

## 3. Write the tests

- One behaviour per test, named as a sentence: `returns an empty list when no rows match`.
- Arrange, act, assert. Keep setup visible in the test unless it is shared by many tests.
- Test through the public interface. Do not assert on private helpers.
- Mock only at the boundary (network, clock, file system), never the unit itself.
- Make tests deterministic: fixed seeds, fake timers, no real network.

## 4. Prove they work

1. Run the new tests and confirm they pass.
2. Temporarily break the code under test (or revert the fix) and confirm the tests fail.
   Restore the code afterwards.
3. Run the whole suite to make sure nothing else changed.

## Output

Show the tests, the command used to run them, and what each one protects against.
