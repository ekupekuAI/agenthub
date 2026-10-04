# agenthub — MVP Design

Status: **Draft for approval** · Date: 2026-10-04 · Owner: Ekansh

This document records the design decisions the build pack left open and the technical
design used to build the MVP. Requirements stay in the build pack:
[PRD](../PRD.md), [MVP spec](../MVP.md), [Build handoff](../BUILD_HANDOFF.md),
[Research](../RESEARCH.md). Where this document is more specific, it wins.

---

## 1. Scope and delivery

The MVP from the build handoff (§3 deliverables) is built in four stages. Each stage ends
runnable, tested and committed before the next begins.

| Stage | Delivers |
|---|---|
| 1. Local Core | Offline CLI: `doctor`, `pack`, `install`, `list`, `remove`, `verify`, `config`. SKILL.md validator, `agenthub.yaml`, `.skillpkg` packer + digests, lockfile, transactional install engine, 4 agent adapters, local scanner + policy, local folder registry, fixtures, CI. |
| 2. Registry | Next.js app with `/api/v1` routes, Postgres schema (Drizzle), artifact storage, publish + scan pipeline, revocation, seed skills. |
| 3. Connected CLI | `search`, `info`, install from the registry, `update --check`, `update <skill>`, `update --safe`, `rollback`, offline cache. |
| 4. Finish | Web UI (search, detail, publish, dashboard, admin), Playwright tests, real-agent verification on this machine, docs, completion report (handoff §10). |

**Non-goals for the MVP:** signed releases (PRD roadmap Phase 2), teams and orgs, format
adapters and MCP bridge (modeled in data, not implemented), IDE extensions, AI-generated
trust scores, automatic updates.

## 2. Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Install scopes | **Project** scope by default inside a repo; **user** scope with `-g`. Outside any repo, install defaults to user scope and says so in the plan. |
| D2 | Security policy | **Declared vs undeclared** (tiers in §8.2). |
| D3 | Default targets | Every **detected** compatible agent, shown in a plan, one confirmation (`--yes` skips, `--agent` narrows, config can pin a list). |
| D4 | Repo | `E:\AgentHub\agenthub`. Build pack stays untouched. |
| D5 | Git | Local commits at each checkpoint. Never push without asking. |
| D6 | Vendoring | Project-scope skill folders are **committed to git**, so installs are always **real file copies**, never links. |
| D7 | Integrity | SHA-256 **content digest** is the identity of a version. Signatures are Phase 2. |
| D8 | Post-install validation | Structural only (hashes, parse, adapter check). agenthub **never runs skill code**. |
| D9 | Tooling | pnpm workspaces, strict TypeScript (ESM), Node ≥ 22, `tsc -b`, Vitest, Biome, GitHub Actions. |
| D10 | Lock contents | The lock carries relative target folders and per-file hashes, so `verify` and `remove` work for a teammate who only cloned the repo. (Refines D1: no separate machine-local receipts file.) |

Decisions owned by later stages, with the default that will be proposed at stage start:
publisher auth (Auth.js with GitHub OAuth + email link), deployment target (Vercel +
managed Postgres + S3-compatible storage), telemetry (opt-in, off by default), seed skills
(10 original skills written for this project).

## 3. Landscape update (verified 2026-09-28)

The build pack's research predates several launches. None change the MVP scope, but they
change what is distinctive:

- **skills.sh / `skills` CLI 1.7**: installs to ~79 agents, canonical `.agents/skills` +
  symlinks (junctions on Windows), `skills-lock.json` with SHA-256, update/remove, partner
  security audits (Gen, Socket, Snyk) shown before install.
- **`gh skill`** (GitHub CLI): search/install/update/publish with `--pin`, provenance in
  frontmatter.
- **Microsoft APM**: manifest + lockfile with content hashes, `apm audit`, hidden-Unicode scan.
- **Tessl**: registry + CLI with private workspaces. **Snyk Agent Scan**, **Cisco
  skill-scanner**: standalone scanners.

What remains distinctive here, and gets the most care: **transactional installs with
snapshot + rollback**, **install-time enforcement of declared permissions**, **runtime and
agent compatibility resolution**, and a **registry that is not GitHub** with immutable,
content-addressed, revocable releases.

## 4. Repository and tooling

```text
agenthub/
├── apps/web/                  # Stage 2+4: Next.js registry UI + /api/v1
├── packages/
│   ├── core/                  # types, skill validation, manifest, pack/digest, lock, engine, policy, resolver
│   ├── scanner/               # static rules → findings (pure; never executes anything)
│   ├── adapters/              # claude-code, codex, cursor, vscode + detection + path table
│   ├── cli/                   # the `agenthub` binary
│   └── test-fixtures/         # fixture skills and broken archives
├── registry/{schema,seed}/    # Stage 2
├── docs/                      # PRD, MVP, RESEARCH, BUILD_HANDOFF, specs/, plans/
└── .github/workflows/ci.yml
```

- Dependency direction: `core` ← `scanner`, `adapters` ← `cli`. `core` depends on neither.
- Runtime dependencies kept deliberately few: `commander`, `yaml`, `zod`, `semver`, `tar`.
- Tests run against real temporary directories (not an in-memory filesystem), because the
  Windows filesystem edge cases are the point.
- CI matrix: Windows, macOS, Ubuntu × Node 22, 24 → lint, typecheck, test.
- `.gitattributes` forces LF in the repo so fixtures hash identically on every OS.

## 5. Skill package format

### 5.1 SKILL.md validation (Agent Skills spec, verified at agentskills.io/specification)

| Field | Rule | On violation |
|---|---|---|
| `name` | required; 1–64 chars; `a-z`, `0-9`, `-`; no leading/trailing `-`; no `--`; must equal the folder name | error |
| `description` | required; 1–1024 chars | error |
| `license` | optional string | error if not a string |
| `compatibility` | optional; 1–500 chars | error |
| `metadata` | optional map of string → string | warning for non-string values |
| `allowed-tools` | optional, experimental; space-separated string | warning if a list (Claude Code/Copilot accept lists) |
| any other top-level key | vendor extension (Claude Code, VS Code use several) | warning, kept as-is |

Also: SKILL.md must start with a `---` frontmatter block; a body over 500 lines produces a
warning (spec guidance). The official `skills-ref` validator is Python and marked
"demonstration only", so `core` implements these rules itself and tests them against the
spec's examples.

### 5.2 `agenthub.yaml` (optional platform metadata, schema 1)

Kept outside SKILL.md so the canonical file stays standard.

```yaml
schema: 1
version: 1.3.0                  # semver; required to pack (or pass --version)
targets:                        # optional; default = every agent that reads Agent Skills
  - claude-code
  - cursor
requires:
  runtimes: { node: ">=22", python: ">=3.10" }   # checked against local probes
  commands: [git, npx]                            # must be on PATH
  mcp: [playwright]                               # reported by doctor; not enforced
permissions:
  network: true                 # true | false | [hosts]
  exec: [npx, node]             # commands scripts may run
  env: [PLAYWRIGHT_BROWSERS_PATH]
  secrets: []                   # named credential files/vars the skill legitimately reads
  fs: { write: [project, temp] }  # project | home | temp
channel: stable                 # stable | beta
```

- Validated with a strict `zod` schema; unknown keys are errors (catches typos).
- No `agenthub.yaml` means **nothing is declared**: every risky behavior found is
  "undeclared" (§8.2), and the version is `0.0.0-local+<digest8>`.

### 5.3 `.skillpkg` archive

- gzip-compressed POSIX ustar tar; entries are the skill's files relative to the skill root.
- Normalized: entries sorted by UTF-8 path; no directory entries; mtime 0; uid/gid 0; empty
  owner names; mode `0755` if the file starts with `#!`, else `0644`; gzip header mtime 0 and
  OS byte fixed, so the same input gives the same bytes on every OS.
- Text files (valid UTF-8, no NUL byte) are stored with LF line endings; binary files are
  byte-exact.
- Excluded when packing: `.git/`, `node_modules/`, `.agenthub/`, `.DS_Store`, `Thumbs.db`.
- Limits (configurable for dev): ≤ 500 files, ≤ 10 MiB unpacked, ≤ 5 MiB per file, path
  ≤ 200 characters, depth ≤ 10.

### 5.4 Path safety (enforced by `pack`, and again by every extract)

Rejected: symlinks, hard links, devices/FIFOs, absolute paths, drive letters, `..`
segments, backslashes, NUL or control characters, `:` (alternate data streams), Windows
reserved names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with or without extension),
names ending in a space or dot, names that differ only by case, names not in Unicode NFC.

### 5.5 Digests

- **Content digest** (the identity of a version): `sha256:` of a manifest made of one line
  per file in sorted order: `<sha256 of normalized bytes>  <path>\n`. Recorded in the lock
  and registry, checked after every extract and by `verify`. It does not depend on
  compression, and it survives git converting LF to CRLF on checkout because text files are
  hashed LF-normalized.
- **Archive digest**: `sha256:` of the `.skillpkg` bytes, for download integrity (Stage 3).

## 6. Local state and lockfile

```text
<repo>/.agenthub/                 committed
├── agenthub.lock
├── config.json                   project overrides (registry, policy, agents)
└── .gitignore                    ignores tmp/
<repo>/.agenthub/tmp/             staging, same volume as the repo

~/.agenthub/                      machine-only ($AGENTHUB_HOME overrides, used by tests)
├── config.json
├── agenthub.lock                 user-scope installs
├── cache/sha256/<hex>.skillpkg
├── snapshots/<scope-id>/<skill>/<version>/   previous installed tree + its lock entry
├── journal/<txid>.json           in-flight transactions
├── tmp/                          staging for user scope
└── audit.log                     JSON lines: install, remove, update, rollback, override
```

`scope-id` is `user`, or the first 16 hex chars of sha256(real path of the repo root).
Project root = nearest ancestor with `.agenthub/`, else the git work-tree root.

**Lock format (lockfileVersion 1).** Keeps the spec's field names and adds `source`,
`paths` and `files`. Keys sorted, 2-space JSON, trailing newline, so diffs stay small.

```json
{
  "lockfileVersion": 1,
  "skills": {
    "web-testing": {
      "version": "1.3.0",
      "digest": "sha256:…",
      "source": "file",
      "registry": "file:../skills-dev",
      "installedTargets": ["claude-code", "codex", "cursor", "vscode"],
      "paths": {
        ".agents/skills/web-testing": ["codex", "cursor", "vscode"],
        ".claude/skills/web-testing": ["claude-code"]
      },
      "files": { "SKILL.md": "sha256:…", "scripts/run.sh": "sha256:…" },
      "installedAt": "2026-10-04T12:00:00Z"
    }
  }
}
```

In the user lock, paths are written with a `~/` prefix so the lock is portable.

**Config precedence:** CLI flags > environment (`AGENTHUB_REGISTRY`, `AGENTHUB_HOME`, …) >
project config > user config > defaults. `agenthub config` prints the effective value and
where each one came from.

## 7. Agent adapters

### 7.1 Where each agent reads skills (verified from official docs, 2026-09-28)

| Agent id | Project folders read | User folders read |
|---|---|---|
| `claude-code` | `.claude/skills` (cwd up to repo root) | `~/.claude/skills` (moves with `CLAUDE_CONFIG_DIR`) |
| `codex` | `.agents/skills` (cwd up to repo root) | `~/.agents/skills` |
| `cursor` | `.agents/skills`, `.cursor/skills`, `.claude/skills`, `.codex/skills` | `~/.agents/skills`, `~/.cursor/skills`, `~/.claude/skills`, `~/.codex/skills` |
| `vscode` (VS Code + Copilot) | `.github/skills`, `.claude/skills`, `.agents/skills` | `~/.copilot/skills`, `~/.claude/skills`, `~/.agents/skills` |

- Codex still loads the legacy `.codex/skills` and `$CODEX_HOME/skills`, but its source marks
  them deprecated. **agenthub never writes there.**
- Claude Code does **not** read `.agents/skills`; Codex does **not** read `.claude/skills`.
- VS Code skips a skill whose `name` differs from its folder, so the installed folder is
  always named exactly after the skill.
- This table lives in one data file in `packages/adapters`, with the source URL and the
  verification date on every row. `doctor` prints it.

### 7.2 Choosing folders: smallest cover

Write candidates per scope: `.agents/skills`, `.claude/skills`, `.cursor/skills`,
`.github/skills` (user: the `~/` equivalents plus `~/.copilot/skills`). For the selected
agents, pick the smallest set of folders such that every agent reads at least one. Ties go
to `.agents/skills`, then `.claude/skills`, then agent-specific folders.

| Selected agents | Folders written |
|---|---|
| claude-code, cursor, vscode | `.claude/skills` |
| codex, cursor, vscode | `.agents/skills` |
| cursor only | `.agents/skills` |
| all four | `.agents/skills` + `.claude/skills` |

With all four agents selected, Cursor and VS Code see two identical copies. The plan says
so, and `doctor` reports it. What each agent does with the duplicate is recorded during
Stage 4's real-agent checks.

### 7.3 Detection (read-only)

| Agent | Executable + version | Folder evidence |
|---|---|---|
| claude-code | `claude --version` (documented) | `~/.claude/` or `$CLAUDE_CONFIG_DIR` |
| codex | `codex --version` (from source; not documented) | `~/.codex/` or `$CODEX_HOME` |
| cursor | `cursor --version` (not documented; works on this machine) | `~/.cursor/` |
| vscode | `code --version` (documented) | Copilot Chat extension under `~/.vscode/extensions/` |

- PATH lookup honors `PATHEXT` on Windows (`.exe`, `.cmd`, `.bat` shims); commands run
  without a shell, with a 5-second timeout.
- Confidence: **high** = executable answers with a version (and, for vscode, Copilot Chat is
  present); **medium** = executable or folder evidence only; **low** = only a project folder
  hints at the agent. Default targets (D3) are high and medium.
- An adapter whose paths cannot be confirmed in official docs is marked **experimental**:
  left out of default targets, installable with `--agent`, with the limitation printed.
  All four adapters are currently verified for paths.

### 7.4 Next-step hints

When an install creates a skills folder that did not exist before, the CLI prints the
reload step: Claude Code `/reload-skills`, Copilot CLI `/skills reload`, Cursor CLI restart.

## 8. Install engine (`core`)

### 8.1 Plan (no writes)

source → load (folder, `.skillpkg`, or `name[@range]` from the configured registry) →
validate SKILL.md + `agenthub.yaml` → content digest → scan → policy decision → detect
agents → select targets (flags / config / D3) → compatibility (declared targets; missing
required runtime or command blocks with the exact requirement; unknown agent version warns)
→ smallest cover → action per folder (create / replace / unchanged).

`--dry-run` stops here and prints the plan (or JSON).

**Local folder registry (FR-12):** `registry: "file:<dir>"` points at a folder of
`.skillpkg` files. The index is built by reading each package; an optional
`revocations.json` lists revoked `name@version` with a reason. Revoked versions are never
installed.

### 8.2 Policy tiers (D2)

| Finding | Undeclared | Declared |
|---|---|---|
| Medium risk: network, shell/exec, env reads, runtime package installs, suspicious prompt phrases, unexpected binaries | WARN (confirm) | INFO |
| High risk, declarable: secret/credential reads | BLOCK | WARN (confirm) |
| High risk, never declarable: download-and-run, obfuscated payloads, dynamic code fed by network or encoded data, hidden-Unicode instructions, persistence (shell rc, startup, cron, registry Run keys, git hooks, other agents' config) | BLOCK | BLOCK |

Declared high-risk behavior still needs your confirmation, as the PRD requires for skills
with elevated needs. Only `--dev` overrides a BLOCK. It prints a banner and writes an
`override` event to the audit log.

### 8.3 Confirm

On a terminal, the prompt is `[Y/n]` with no warnings and `[y/N]` with warnings. Without a
terminal, or with `--json`, `--yes` is required. A blocked plan exits with code 3.

### 8.4 Apply (one transaction, all targets or none)

1. Write the journal `~/.agenthub/journal/<txid>.json`.
2. Stage one copy per target in the scope's `.agenthub/tmp/<txid>/`, which must be on the
   same volume as the target. If it is not, stage next to the skills folder
   (e.g. `.claude/.agenthub-tmp-<txid>`), never inside it.
3. Re-hash the staged files against the content digest.
4. For each target: move any existing folder to `tmp/<txid>/old/`, then rename the staged
   copy into place. On Windows, `EPERM`/`EBUSY`/`EACCES` from a rename is retried with
   backoff for up to about 3 seconds, then the transaction fails and names the path and the
   likely cause ("another program has a file open").
5. Validate each target (D8): file hashes match, SKILL.md parses, name equals the folder,
   and the agent reads that folder.
6. **Commit point:** write the lock (temp file + rename), save the previous tree as a
   snapshot (keep the last one per scope and skill), cache the package by digest, append
   the audit event, delete tmp and the journal.

Any failure before the commit point undoes completed steps in reverse and leaves the
previous state exactly as it was. After a crash, the next CLI command finds the journal and
finishes the rollback (or the cleanup, if the commit point had passed), then reports what
it did.

**Safety rules:**

- Every write goes through a guard that only allows the scope's `.agenthub/`,
  `~/.agenthub/` and the planned target folders (handoff security test 7).
- Targets are checked with `lstat`. A symlink or junction at a target (skills.sh creates
  these) is **unmanaged**. `--force` removes the link itself, never anything it points to.
- Installing over a managed skill whose files differ from the lock (hand edits) is blocked
  unless `--force`. The plan lists the changed files.
- Installing where an unmanaged folder of the same name exists is blocked unless `--force`.

### 8.5 Other local commands

- **`remove <skill>`**: deletes only files listed in the lock whose hashes still match.
  Modified or extra files stay and are reported; `--force` removes the managed folder
  entirely. Updates the lock, keeps a snapshot, writes an audit event.
- **`verify [skill]`**: re-hashes every lock path and reports ok / modified / missing /
  extra per file. Exit 4 on any drift.
- **`list`**: skill, version, scope, agents, source, status. `--json` available.
- **`doctor`** (read-only): agents with version, confidence and folders read; the path table
  version; scope roots; config validity; lock-vs-disk check; skills an agent sees twice;
  the same skill at user and project scope with different digests (agents disagree on which
  wins); leftover journals or tmp folders; unmet runtime requirements; cache size. Exit 1
  if any problem is found.

## 9. Scanner (`packages/scanner`)

Pure function: files in, findings out. Every finding has a rule id, category, severity,
file, line, and a short evidence excerpt. It never claims a skill is safe, only what it
found.

| Rule | Detects | Severity |
|---|---|---|
| `exec.shell` | `child_process`, `subprocess`, `os.system`, `Invoke-Expression`, `sh -c`, backticks | medium |
| `net.access` | `fetch`, `http(s).request`, `axios`, `requests`, `urllib`, sockets, `curl`, `wget`, `Invoke-WebRequest` | medium |
| `net.download-exec` | download chained into execution: `curl … \| sh`, `iwr … \| iex`, fetch → eval, write-then-run | high (never declarable) |
| `secrets.read` | `.env`, `~/.aws`, `~/.ssh`, `~/.config/gcloud`, `.npmrc`, `.netrc`, keychains, browser profiles; bulk env dumps | high |
| `env.read` | specific environment variables not declared | medium |
| `code.dynamic` | `eval`, `new Function`, `vm.run*`, `exec()` of strings | medium; high when combined with network or encoded data |
| `code.obfuscated` | long base64/hex blobs decoded at runtime, char-code arrays, packed JS | high (never declarable) |
| `fs.persistence` | writes to shell rc files, startup folders, cron/launchd/systemd, registry Run keys, git hooks, agent config | high (never declarable) |
| `deps.remote` | runtime `npm i` / `pip install`, git or URL dependencies, install hooks | medium |
| `prompt.injection` | "ignore previous/system instructions", "do not tell the user", requests to reveal secrets, disable approvals or safety | medium |
| `prompt.hidden` | zero-width, bidi-override and Unicode tag characters; instructions inside HTML comments | high (never declarable) |
| `file.binary` | ELF, PE or Mach-O executables, nested archives, unexpected file types | medium |

Language-aware patterns cover JavaScript/TypeScript, Python, shell, PowerShell, batch and
Markdown.

**Fixtures** (`packages/test-fixtures`, harmless payloads, fake secrets), each with an
expected-findings file the tests assert exactly:

| Fixture | Expected |
|---|---|
| `hello-skill` (SKILL.md only), `web-testing` (declares network + `npx`), `complex-benign` | allow |
| `secret-reader`, `download-exec`, `obfuscated`, `hidden-unicode`, `persistence` | BLOCK |
| `prompt-injection` | WARN |
| `needs-node-99` | incompatible (exit 5) |
| broken archives: traversal, absolute path, symlink, reserved name, case clash, digest mismatch, oversized | rejected |

## 10. CLI contract

| Command | Notes |
|---|---|
| `agenthub doctor` | read-only health report |
| `agenthub pack <dir> [-o file] [--version x]` | prints content + archive digests |
| `agenthub install [name[@range] \| <dir> \| <file.skillpkg>]` | no argument: restore everything in the scope's lock |
| `agenthub list` | |
| `agenthub remove <name>` | |
| `agenthub verify [name]` | |
| `agenthub config [get \| set \| unset] [key] [value]` | no argument: effective config with sources |

- **Global flags:** `--json`, `--yes`, `--dry-run`, `-g/--global`, `--agent <ids>`, `--dev`,
  `--force`, `--verbose`, `--no-color`.
- **Exit codes:** 0 ok · 1 error or problems found · 2 usage · 3 blocked by policy ·
  4 integrity or drift · 5 incompatible · 130 cancelled.
- **`--json`:** one object on stdout, `{ "ok": true, "command": "...", "data": {...} }` or
  `{ "ok": false, "command": "...", "error": { "code", "message", "details" } }`. Human
  progress goes to stderr.
- Every error names the exact adapter, path, requirement or finding (handoff UX principle
  "visible failure").

## 11. Stages 2–4 (detailed at the start of each stage)

**Stage 2: Registry.**
- `apps/web`: Next.js App Router with the eight `/api/v1` routes from MVP §12.
- Postgres via Drizzle, using the tables from MVP §5. Local dev and tests use **PGlite**
  (Postgres in-process), so Docker isn't required; production uses managed Postgres.
- An `ArtifactStore` interface with a local-filesystem driver (dev, tests) and an
  S3-compatible driver (prod). Keys are `sha256/<hex>.skillpkg`; artifacts are immutable
  and never overwritten.
- Publish flow: upload → server recomputes both digests → store → pending release →
  same `scanner` package runs inline (with a job record, so a queue can replace it later) →
  promoted to active if nothing is BLOCK; admins can quarantine or revoke.
- Anonymous read and install; publishing needs an account.

**Stage 3: Connected CLI.**
- Registry resolver (MVP §6) plus client-side checks: archive digest → content digest →
  scan → the same install engine.
- `update --check` never writes.
- `update` and `update --safe` run preview → snapshot → apply → validate → rollback on
  failure. `--safe` skips anything incompatible, revoked, blocked or drifted.
- `rollback` restores the last snapshot through the engine.
- Offline install by digest from the cache (FR-13).
- Install telemetry only if `telemetry: true`.

**Stage 4: Finish.**
- Pages: search, skill detail (compatibility matrix, trust evidence list, requirements,
  versions, changelog), publish, dashboard, admin. Keyboard navigable, WCAG AA contrast.
- Playwright tests, plus CLI end-to-end tests against a local registry.
- Real-agent verification on this machine, recorded as compatibility results.
- Docs: getting started, authoring, security model, troubleshooting.
- The completion report from handoff §10.

## 12. Testing

- **Unit:** validator rules; `agenthub.yaml` schema; path safety; pack determinism (same
  input → same digests and bytes, CRLF and LF inputs → same content digest); lock
  round-trip; smallest cover; policy tiers; every scanner rule with a positive and a
  negative case.
- **Engine integration** (real temp directories): install, replace, remove, verify; failure
  injected at every step of §8.4 (including a simulated `EBUSY` and a crash between steps)
  must leave the previous state intact.
- **CLI end-to-end:** run the built CLI with a temporary `AGENTHUB_HOME`, a fake home folder
  and a fake project; every command in human and `--json` mode; exit codes.
- **Handoff security tests §8**, mapped one to one: secret-file read blocked;
  download-and-run flagged (blocked); secret-exposure instructions flagged (warned); digest
  mismatch rejected; revoked version rejected (local registry `revocations.json` in Stage 1,
  hosted registry in Stage 3); prior version restored when validation fails; no writes
  outside declared targets (write guard + test).
- Every feature has at least one success test and one failure-path test (handoff §4.9).

## 13. Risks

| Risk | Mitigation |
|---|---|
| Agents change their folders | Path table is data with source and date; `doctor` shows it; unverified → experimental. |
| Windows file locks during rename | Retry with backoff; clear error naming the path; journal makes it recoverable. |
| Scanner false positives / negatives | Declared permissions downgrade expected findings; findings show file, line and evidence; fixtures pin behavior; no "safe" claims. |
| Duplicate listing in Cursor / VS Code when all four agents are targeted | Unavoidable with copies; disclosed in plan and `doctor`; measured in Stage 4. |
| Scope creep | Stages and non-goals in §1; anything new goes to a later stage. |
