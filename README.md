<p align="center"><img src="docs/readme/banner.svg" width="100%" alt="agenthub: install agent skills you can trust"></p>

<p align="center">
  <a href="https://github.com/ekupekuAI/agenthub/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/ekupekuAI/agenthub/ci.yml?branch=main&label=CI&style=flat-square"></a>
  <a href="https://www.npmjs.com/package/@ekupekuai/agenthub"><img alt="npm" src="https://img.shields.io/npm/v/@ekupekuai/agenthub?style=flat-square&color=c5f04a&labelColor=16191d"></a>
  <img alt="Node.js 22+" src="https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Windows, macOS, Linux" src="https://img.shields.io/badge/Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-tested-16191d?style=flat-square">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/ekupekuAI/agenthub?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://agenthub-registry.vercel.app"><b>Live registry</b></a> ·
  <a href="docs/getting-started.md">Getting started</a> ·
  <a href="docs/authoring.md">Publish a skill</a> ·
  <a href="docs/security.md">Security model</a> ·
  <a href="docs/guide/agenthub-guide.pdf">One-page guide (PDF)</a>
</p>

<p align="center">
  <img src="https://skillicons.dev/icons?i=ts,nodejs,react,nextjs,tailwind,postgres,vercel,vitest&theme=dark" alt="TypeScript, Node.js, React, Next.js, Tailwind CSS, Postgres, Vercel, Vitest">
</p>

---

**agenthub is the package manager and trust layer for agent skills.** It installs skills in the
open [Agent Skills](https://agentskills.io/specification) format (`SKILL.md` folders) into
**Claude Code, Codex, Cursor and VS Code + GitHub Copilot** with one command.

A skill can ship scripts and instructions your agent will follow, so agenthub treats every one
like third-party code: it scans the package before writing anything, compares what it finds with
the permissions the author declared, shows you the plan, and records the SHA-256 of every file in
a lockfile. Later you can verify that nothing drifted, update safely, and roll back. Skill scripts
are copied, never run, at install time.

## Features

| | Feature | What it does |
|---|---|---|
| 🔍 | **Scan before install** | 13 static rules over JS/TS, Python, shell, PowerShell, batch and Markdown: shell execution, network access, download-and-run, secret and env reads, dynamic code, obfuscation, persistence, remote dependencies, prompt injection, hidden Unicode, binaries and remote instructions. |
| 📜 | **Declared permissions** | Skills declare what they need in `agenthub.yaml`. Declared behavior is reported as info, undeclared behavior is a warning, and dangerous findings block the install (exit code 3). |
| 🔒 | **Lockfile with per-file hashes** | `.agenthub/agenthub.lock` pins each skill's version, content digest and the SHA-256 of every file. |
| ✅ | **Verify** | `agenthub verify` re-hashes installed files against the lock and exits 4 on any drift. |
| ⬆️ | **Capability-gated updates** | `update --check` shows what's available. An update that can do more than the version you approved (new hosts, programs, unpinned remote instructions) is refused until you approve it explicitly. |
| ⏪ | **Rollback** | Updates keep a snapshot; `agenthub rollback <name>` restores the previous version. |
| ⚛️ | **Transactional installs** | Staging, atomic swap, a journal and crash recovery: an install lands in every target folder or in none. |
| 🛡️ | **Hostile-archive safe** | `.skillpkg` archives are read in memory. Only regular files are accepted; `..`, absolute paths, drive letters, links, Windows-reserved names, invisible characters and hidden padding are rejected. |
| 🤖 | **Four agents, fewest folders** | Detects the agents on your machine and writes to the smallest set of folders they all read: `.claude/skills` and `.agents/skills`. |
| 🖥️ | **Interactive mode** | Run `agenthub` with no arguments on a terminal for a full-screen app with a `/` command palette. Scripts and CI always get plain output (or `--json`). |
| 🌐 | **A registry you control** | The hosted registry with immutable, content-addressed, scanned releases, or a plain folder of `.skillpkg` files. |

### Supported agents

| Agent | Skill folders it reads | Written by agenthub |
|---|---|---|
| Claude Code | `.claude/skills` | `.claude/skills` |
| Codex | `.agents/skills` | `.agents/skills` |
| Cursor | `.claude/skills` and `.agents/skills` | covered by the two above |
| VS Code + GitHub Copilot | `.claude/skills` and `.agents/skills` | covered by the two above |

Folders are relative to the project, or to your home folder with `-g`.

## How it works

```mermaid
flowchart LR
    A["agenthub install &lt;skill&gt;"] --> B["Resolve<br/>folder · .skillpkg · name@range"]
    B --> C["Validate<br/>SKILL.md · agenthub.yaml · safe paths"]
    C --> D["Scan<br/>13 static rules"]
    D --> E{"Policy vs<br/>declared permissions"}
    E -- block --> X["Refused · exit 3"]
    E -- allow / confirm --> F["Plan + consent<br/>targets · findings · capabilities"]
    F --> G["Stage + atomic swap<br/>.claude/skills · .agents/skills"]
    G --> H["Lock<br/>version · digest · SHA-256 per file"]
    H --> I["agenthub verify<br/>re-hash against the lock"]
    I -- match --> J["ok · exit 0"]
    I -- drift --> K["drift · exit 4"]
```

## See it

Real output from the commands shown (only the project path is shortened).

**Install: plan, safety findings, capability inventory, result**

<p align="center"><img src="docs/readme/cli-install.png" width="820" alt="agenthub install output"></p>

<details>
<summary><b>A skill that downloads and runs a script is blocked</b></summary>
<br>
<p align="center"><img src="docs/readme/cli-blocked.png" width="820" alt="agenthub blocking a download-and-run skill"></p>
</details>

<details>
<summary><b><code>verify</code> catches an edited file; <code>update --check</code> lists updates</b></summary>
<br>
<p align="center"><img src="docs/readme/cli-verify.png" width="560" alt="agenthub verify reporting drift"></p>
<p align="center"><img src="docs/readme/cli-update-check.png" width="820" alt="agenthub update --check"></p>
</details>

**The registry** at [agenthub-registry.vercel.app](https://agenthub-registry.vercel.app)

<p align="center"><img src="docs/readme/web-home.png" width="820" alt="agenthub registry home page"></p>

<table>
  <tr>
    <td width="72%"><img src="docs/readme/web-skill.png" alt="Skill page with install command and trust evidence"></td>
    <td width="28%"><img src="docs/readme/web-mobile.png" alt="Registry home page on a phone"></td>
  </tr>
  <tr>
    <td align="center"><sub>Skill page: SKILL.md, install command, trust receipt</sub></td>
    <td align="center"><sub>Phone layout</sub></td>
  </tr>
</table>

## Quickstart

Requires **Node.js 22 or newer** on Windows, macOS or Linux.

```bash
npm install -g @ekupekuai/agenthub
agenthub doctor                 # which agents are installed, which folders they read
agenthub search testing         # browse the registry
agenthub install web-testing    # scan, show the plan, ask, install
agenthub verify                 # re-hash installed files against the lock
```

Or without installing: `npx @ekupekuai/agenthub doctor`. Platform notes (Homebrew, nvm, the
macOS `EACCES` fix) are in [docs/getting-started.md](docs/getting-started.md).

The CLI uses the public registry at **https://agenthub-registry.vercel.app** unless you
configure another one. A local skill folder works without any registry:

```bash
agenthub install ./path/to/my-skill
```

## Commands

| Command | What it does |
|---|---|
| `agenthub` | Interactive mode (on a terminal, with no command) |
| `doctor` | Check agents, scopes, the lock and leftovers (read-only) |
| `search <query>` | Search the registry (`--agent`, `--category`) |
| `info <name>` | Versions, digests, permissions, requirements and scan findings |
| `install [target]` | Install a skill folder, a `.skillpkg` or `name[@range]`; no argument restores the lock |
| `list` | Installed skills in the project and user scope (`-g` for user only) |
| `verify [name]` | Re-hash installed files against the lock (exit 4 on drift) |
| `update [name]` | Update skills; `--check` only reports, `--safe` applies only updates with no capability expansion |
| `diff <name>` | Capability and file changes between the installed version and a registry version (`--to`) |
| `approve <name>` | Record that you reviewed the installed version's capabilities (`--note`) |
| `rollback <name>` | Restore the previous version from its snapshot |
| `remove <name>` | Remove a skill (modified files are kept unless `--force`) |
| `pack <dir>` | Validate a skill folder and build a `.skillpkg` (`-o`, `--version`) |
| `config [action] [key] [value]` | Show the effective config, or `get` / `set` / `unset` / `trust-registry` |

**Global flags:** `--json` · `-y, --yes` · `--dry-run` · `-g, --global` · `--agent <ids>` ·
`--dev` · `--force` · `--verbose` · `--no-color` (plus `--approve-capabilities` on `install` and `update`)

**Exit codes:** `0` ok · `1` error · `2` usage · `3` blocked by policy or approval needed ·
`4` integrity / drift · `5` incompatible · `130` cancelled

## Configuration

### CLI

| Variable | Effect |
|---|---|
| `AGENTHUB_REGISTRY` | Registry for this run: `https://…` or `file:<folder>` (overrides config) |
| `AGENTHUB_CHANNEL` | Release channel: `stable` or `beta` |
| `AGENTHUB_HOME` | Machine-local state folder (default `~/.agenthub`) |
| `AGENTHUB_USER_HOME` | Home folder used for the user scope (default: your home folder) |
| `AGENTHUB_NO_TUI` | Never open the interactive mode |
| `NO_COLOR` / `FORCE_COLOR` | Disable colors / force 16, 256 or 24-bit color |
| `AGENTHUB_REDUCED_MOTION` | Interactive mode without animation |
| `AGENTHUB_ASCII` / `AGENTHUB_UNICODE` | ASCII-only symbols / full symbols on the classic Command Prompt |
| `AGENTHUB_AGENTS` | Testing and CI only: replaces agent detection, e.g. `claude-code,codex:medium` |

### Registry (`apps/web`)

Nothing is required for a local run: without a database URL and a Blob token the registry uses an
embedded Postgres (PGlite) and a local folder. Every variable is documented in
[`apps/web/.env.example`](apps/web/.env.example).

| Variable | Needed for | Where to get it |
|---|---|---|
| `DATABASE_URL` | Hosted deploy | Pooled connection string from the [Neon](https://neon.tech) console |
| `BLOB_READ_WRITE_TOKEN` | Hosted deploy | Added by Vercel when you connect a Blob store |
| `AGENTHUB_ADMIN_TOKEN` | `/admin` and the admin API | Any random value of 32+ characters |
| `AGENTHUB_SESSION_SECRET` | Optional | 32+ random characters; signs admin session cookies |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Publisher sign-in | A GitHub OAuth app (github.com/settings/developers) |
| `AGENTHUB_PUBLIC_URL` | Sign-in outside localhost | The registry's public origin |
| `AGENTHUB_TRUST_PROXY` | Per-client rate limits behind a proxy | Number of trusted proxies (Vercel: `1`) |
| `AGENTHUB_DATA_DIR` | Optional | Local database and package folder (default `apps/web/.data`) |
| `AGENTHUB_SCAN_TIMEOUT_MS` / `AGENTHUB_SCAN_CONCURRENCY` | Optional | Upload scan budget (default 15000 ms) and parallel scans (default 2) |

Deployment steps: [docs/deploy-vercel.md](docs/deploy-vercel.md) and [docs/registry.md](docs/registry.md).

## Develop from source

```bash
npm install
npm run build                                # CLI → packages/cli/dist/agenthub.mjs
node packages/cli/dist/agenthub.mjs doctor

npm run lint && npm run typecheck && npm test

npm run seed -w apps/web                     # demo registry data
npm run dev -w apps/web                      # registry at http://localhost:3000
```

CI runs lint, typecheck, the tests and the build on Windows, macOS and Linux with Node 22 and 24.

<details>
<summary><b>Repository layout</b></summary>

```text
apps/web/                 registry: API (/api/v1), website, publishing, moderation (Next.js)
packages/core/            skill format, .skillpkg archives, digests, lockfile, install engine
packages/scanner/         static scanner (13 rules) and install policy
packages/adapters/        agent detection and the skill-folder table
packages/cli/             the agenthub command and its interactive mode (Ink)
packages/test-fixtures/   safe and malicious fixture skills used by the tests
registry/seed/            curated starter skills for the registry
docs/                     guides, PRD, design specs, one-page guide
```

</details>

## Documentation

- [Getting started](docs/getting-started.md) · [Writing and publishing a skill](docs/authoring.md)
- [Security model](docs/security.md) · [Running the registry](docs/registry.md) · [Deploying on Vercel](docs/deploy-vercel.md)
- [Troubleshooting](docs/troubleshooting.md) · [Design spec](docs/specs/2026-10-04-agenthub-mvp-design.md) · [PRD](docs/PRD.md)

## Limits worth knowing

- Static analysis has a ceiling: a clean scan is not a safety verdict, and a behavior change
  written only in prose won't show up in a capability diff.
- Releases are not signed yet; integrity rests on the digests pinned in the lockfile and on
  immutable registry storage.

## Future development

- **`agenthub adopt`**: bring skills installed by other tools under the lock without changing a byte.
- **`agenthub ci`**: frozen verify, approvals and capability budgets as a pull-request check, with SARIF output.
- **Signed releases** with signer continuity (the lock already reserves the fields).
- **Private registries, teams and `@publisher/` namespaces.**
- **Capability diff on the website** and an `agenthub audit` view of what each agent actually loads.

## License

[MIT](LICENSE)
