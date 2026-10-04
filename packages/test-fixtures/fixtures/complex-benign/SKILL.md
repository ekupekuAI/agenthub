---
name: complex-benign
description: Builds a short project status report from git and the local toolchain. Use when the user asks for a build or status report.
license: Apache-2.0
compatibility: Needs git, Node.js 22+ and Python 3.10+ on PATH.
metadata:
  author: agenthub fixtures
  version: "2.0.1"
---

# Status report

1. Check that the working tree is clean:

   ```bash
   python scripts/check.py
   ```

2. Build the report bundle:

   ```bash
   node scripts/build.mjs
   ```

3. Summarize `dist/report.json` for the user, using the layout in
   [the report guide](references/guide.md). Put the logo from `assets/logo.svg` at the top
   of any HTML output.

Set `COMPLEX_BENIGN_MODE=lenient` to allow uncommitted changes.
