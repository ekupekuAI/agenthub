#!/usr/bin/env python3
"""Checks that the git working tree is clean before a report is built."""

import os
import subprocess
import sys


def main() -> int:
    mode = os.environ.get("COMPLEX_BENIGN_MODE", "strict")
    result = subprocess.run(
        ["git", "status", "--porcelain"], capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        print("git is not available or this is not a repository", file=sys.stderr)
        return 1
    changes = [line for line in result.stdout.splitlines() if line.strip()]
    if changes and mode == "strict":
        print(f"{len(changes)} uncommitted change(s); commit or set the lenient mode")
        return 1
    print("working tree clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
