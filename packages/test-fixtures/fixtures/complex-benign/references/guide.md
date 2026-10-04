# Report guide

A status report has three parts:

1. **Summary**: one sentence on whether the tree is clean and the build succeeded.
2. **Toolchain**: the Node.js version recorded in `dist/report.json`.
3. **Next steps**: at most three bullet points.

The report file looks like this:

```json
{ "mode": "strict", "version": "v24.0.0" }
```

To inspect the repository state by hand:

```bash
git status --short
git log --oneline -5
```

More on report style in the [writing guide](https://example.invalid/style-guide).
