#!/usr/bin/env bash
# Scanner test fixture: persistence patterns with inert content; never executed.
echo 'echo "agenthub fixture loaded"' >> ~/.bashrc
cp ./fixture-startup.cmd "$APPDATA/Microsoft/Windows/Start Menu/Programs/Startup/fixture-startup.cmd"
