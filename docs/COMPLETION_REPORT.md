# agenthub — completion report

Date: 2026-10-05 · Repository: `E:\AgentHub\agenthub` (branch `main`, local commits only)

## What agenthub is

The package manager and trust layer for agent skills (the open Agent Skills / `SKILL.md`
format). One command installs a skill into Claude Code, Codex, Cursor and VS Code + Copilot.
Every package is scanned before it lands, checked against the permissions it declares, and
recorded byte for byte, so it can be verified, updated and rolled back.

**Position:** the only installer whose updates are capability-gated by default.
**Tagline:** Every skill. Every agent. Nothing you didn't approve.

## Architecture implemented

| Package | Responsibility |
|---|---|
| `packages/core` | SKILL.md + `agenthub.yaml` validation (bounded safe YAML), deterministic `.skillpkg` (strict tar/gzip reader), content digests, capability inventory and diff, lock v2, transactional install engine (journal, staging, atomic swap, snapshots, rollback, crash recovery, inter-process lock, write guard), file registry, config with untrusted-project-registry protection |
| `packages/scanner` | 13 static rules over JS/TS, Python, shell, PowerShell, batch and Markdown; externals extraction with pin status; declared-vs-undeclared policy |
| `packages/adapters` | Agent detection (never runs binaries from the project), verified skill-folder table, smallest-cover target selection |
| `packages/cli` | `agenthub` command, human and `--json` output, exit codes |
| `apps/web` | Registry: `/api/v1`, embedded Postgres (PGlite) + Drizzle, content-addressed artifact store, publish with time-boxed scan worker, quarantine, revocation, admin moderation, premium website |
| `packages/test-fixtures`, `registry/seed` | 14 fixture skills (safe, malicious, version pairs) and 10 curated seed skills |

## Commands that work

`doctor`, `search`, `info`, `install` (folder, `.skillpkg`, `name@range`, or no argument to
restore the lock), `list`, `verify`, `update --check`, `update <skill>`, `update --safe`,
`diff`, `approve`, `rollback`, `remove`, `pack`, `config` (`get`/`set`/`unset`/`trust-registry`).
Global flags: `--json`, `--yes`, `--dry-run`, `-g`, `--agent`, `--dev`, `--force`,
`--approve-capabilities`, `--channel`, `--verbose`, `--no-color`.
Exit codes: 0 ok · 1 error · 2 usage · 3 policy or approval required · 4 integrity/drift ·
5 incompatible · 130 cancelled.

## Supported agents and versions verified on this machine

| Agent | Detected | Version | Folders written |
|---|---|---|---|
| Claude Code | high | 2.1.277 | `.claude/skills` |
| Codex | medium (config folder only, CLI not installed) | — | `.agents/skills` |
| Cursor | high | 3.15.6 | reads both |
| VS Code + Copilot (built-in) | high | 1.138.0 | reads both |

Folder table verified against official documentation on 2026-09-28. Installing for all four
writes two identical copies; Cursor and VS Code list the skill twice (disclosed in the plan).

## Test counts

- Packages + web unit tests (Vitest): **1013 passed**, 3 skipped (Windows symlink privilege
  and one POSIX-only test).
- Browser end-to-end (Playwright on Edge): **10 passed**.
- Typecheck (repo + web) and Biome lint: clean. Production web build: succeeds.

## Security work

An adversarial review produced 124 raw findings (92 unique: 3 critical, 22 high). Every area
was fixed with a regression test written first:

- **Critical, fixed:** detection could run a `node.cmd` planted in a cloned repo; the CLI
  executed programs named by a skill manifest; one bad byte could make a script "binary" and
  skip the scanner.
- **High, fixed (selection):** project config silently redirecting the registry; forged lock
  entries verifying as trusted; lock restore bypassing confirmation; revoked versions coming
  back through restore/rollback; concurrent processes corrupting the lock; crash recovery
  broken on Windows; YAML alias and size bombs; registry frozen by one upload; revocation
  undone by a concurrent approve; rate limits bypassed with a forged `X-Forwarded-For`;
  unbounded stored findings.

The build-pack documents themselves contained 63 hidden Unicode characters, which were
removed — the same class of content the scanner now blocks in skills.

## Known limitations

- Static analysis has a ceiling: a clean scan is not a safety verdict, and prose-only
  behavior changes are invisible to a capability diff.
- Releases are not signed yet; integrity rests on digests pinned in the lockfile and
  immutable registry storage (lock v2 reserves `signer` and `quarantine` fields).
- The registry runs on an embedded database and local disk; serverless hosting needs a
  hosted Postgres and an object store behind the existing interfaces.
- Publishing uses tokens, not user accounts. Names are flat (no `@publisher/` namespaces yet).
- The shell analyzer can take ~6 s on a 1 MiB line of nested brackets (registry scans are
  time-boxed, so this is a CLI-side slowdown only).

## Local setup

```bash
cd E:\AgentHub\agenthub
npm install
npm run build                     # CLI → packages/cli/dist/agenthub.mjs
node packages/cli/dist/agenthub.mjs doctor
npm run seed -w apps/web          # demo registry data
npm run build -w apps/web && npm run start -w apps/web   # http://localhost:3000
```

See `docs/getting-started.md`, `docs/authoring.md`, `docs/security.md`,
`docs/registry.md`, `docs/troubleshooting.md`.

## Deployment

Any Node 22+ host with a persistent disk: build, set `AGENTHUB_ADMIN_TOKEN` (32+ chars),
`AGENTHUB_TRUST_PROXY` behind a proxy, serve over HTTPS, back up `AGENTHUB_DATA_DIR`.
Details in `docs/registry.md`. Nothing has been pushed or deployed.

## Five most valuable next improvements

1. **`agenthub adopt`** — bring skills already installed by other tools under the lock
   without changing a byte (the main switching path).
2. **`agenthub ci`** — frozen verify, approvals and capability budgets as a required PR
   check, with SARIF output.
3. **Signed releases with signer continuity** (lock fields already reserved).
4. **Registry name protection** — reserved names, lookalike detection, tombstones — before
   the registry has public users.
5. **Capability diff on the website** and an `agenthub audit` view of what each agent
   actually loads.
