#!/usr/bin/env bash
# Runs the Playwright suite for the current project and forwards any arguments.
set -euo pipefail

echo "Browsers: ${PLAYWRIGHT_BROWSERS_PATH:-default location}"
npx playwright test "$@"
