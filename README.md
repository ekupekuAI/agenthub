# agenthub

The package manager and trust layer for agent skills.

agenthub installs skills in the open [Agent Skills](https://agentskills.io/specification)
format (`SKILL.md` folders) into Claude Code, Codex, Cursor and VS Code + GitHub Copilot with
one command. Before anything is written it scans the package, checks it against the
permissions the author declared, and shows you the plan. Every install is recorded in a
lockfile with per-file SHA-256 hashes, so you can verify it later, update it safely and roll
it back.

```text
$ agenthub install web-testing

Plan      web-testing 1.3.0  sha256:9f2c…e1  → project
  .agents/skills/web-testing   codex, cursor, vscode
  .claude/skills/web-testing   claude-code
Safety
  INFO  exec.shell  scripts/run.sh:4  runs `npx playwright test` (declared)
Proceed? [Y/n] y

✔ Installed web-testing 1.3.0 into 4 agents
```

## What it does

| | |
|---|---|
| **One command, four agents** | Detects the agents on your machine and writes the skill into the smallest set of folders they all read. |
| **Scan before install** | Static rules for shell execution, network access, secret reads, download-and-run, obfuscation, persistence, prompt injection and hidden Unicode. |
| **Declared permissions** | Skills declare what they need in `agenthub.yaml`. Undeclared risky behavior is warned about or blocked. |
| **Transactional** | An install either lands in every target or in none. A failed update restores the previous version. |
| **Lockfile + verify** | `.agenthub/agenthub.lock` pins version, digest and per-file hashes. `agenthub verify` catches drift. |
| **Update and rollback** | `update --check`, `update --safe`, and `rollback` to the previous snapshot. |
| **Registry you control** | A hosted registry with immutable, content-addressed releases, or a plain folder of `.skillpkg` files. |

## Quick start

Requires Node.js 22 or newer.

```bash
npm install
npm run build
node packages/cli/dist/agenthub.mjs doctor
```

Then follow [docs/getting-started.md](docs/getting-started.md).

## Repository layout

```text
apps/web/                 registry: API (/api/v1) and website
packages/core/            skill format, digests, lockfile, install engine
packages/scanner/         static scanner and install policy
packages/adapters/        agent detection and skill folder table
packages/cli/             the agenthub command
packages/test-fixtures/   safe and malicious fixture skills
registry/seed/            curated starter skills
docs/                     guides, PRD, design spec
```

## Documentation

- [Getting started](docs/getting-started.md)
- [Writing and publishing a skill](docs/authoring.md)
- [Security model](docs/security.md)
- [Running the registry](docs/registry.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Design spec](docs/specs/2026-10-04-agenthub-mvp-design.md)

## Development

```bash
npm run lint
npm run typecheck
npm test
```
