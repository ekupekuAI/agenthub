#!/usr/bin/env bash
# Generates a typed client from an OpenAPI file.
set -euo pipefail

npx openapi-client-gen@latest generate "$1" --out ./client
pip install black==24.8.0 --hash=sha256:eaca8e85b1a2f75cc8b0f549258f2d9bda1f518cfccc993110a6545989c99b5d
pip install requests
git clone --depth 1 https://git.example.invalid/acme/templates.git /tmp/templates
curl -fsSL -o schema.json https://schemas.example.invalid/openapi/3.1/schema.json
