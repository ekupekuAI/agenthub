# Getting started

This guide takes you from nothing to a skill installed in your agents, verified, updated and
rolled back. You don't need to know how Agent Skills work internally.

## 1. Install and check your machine

agenthub needs Node.js 22 or newer.

```bash
npm install
npm run build
```

The examples below use `agenthub` for `node packages/cli/dist/agenthub.mjs`.

```bash
agenthub doctor
```

`doctor` changes nothing. It lists the agents it found (Claude Code, Codex, Cursor,
VS Code + Copilot), how confident it is about each, the folders each one reads skills from,
and any problems with existing installs.

## 2. Choose where skills come from

Point agenthub at a registry. This can be a hosted registry or a folder of `.skillpkg` files.

```bash
agenthub config set registry http://localhost:3000     # the registry from this repo
agenthub config set registry file:../my-skills         # a local folder
```

You can also skip the registry and install straight from a folder or a package file.

## 3. Find a skill

```bash
agenthub search testing
agenthub info web-testing
```

`info` shows the versions, the supported agents, what the skill requires, what it is allowed
to do, and what the scanner found.

## 4. Install

```bash
agenthub install web-testing            # from the registry
agenthub install web-testing@^1.2       # a version range
agenthub install ./my-skill             # from a folder
agenthub install ./my-skill-1.0.0.skillpkg
```

agenthub prints a plan before it writes anything:

- the skill, version and digest;
- every folder it will write, and which agents read it;
- safety findings, each marked `INFO`, `WARN` or `BLOCK`;
- requirements it checked on your machine.

| Mark | Meaning | What happens |
|---|---|---|
| `INFO` | Behavior the skill declared | Shown for your information |
| `WARN` | Risky behavior the skill did not declare, or a declared high-risk permission | You must confirm |
| `BLOCK` | Dangerous behavior | The install stops |

Useful flags: `--dry-run` (show the plan only), `--yes` (skip the confirmation),
`--agent claude-code,cursor` (choose agents), `-g` (install for your user, in every project),
`--json` (machine-readable output).

### Project or user scope

Inside a project, skills install into the project and are recorded in
`.agenthub/agenthub.lock`. Commit the lockfile and the installed skill folders: teammates get
the same skills as soon as they clone. With `-g`, skills install under your home folder and
are available everywhere.

### Two folders for four agents

Claude Code reads `.claude/skills`. Codex reads `.agents/skills`. Cursor and VS Code read
both. Installing for all four therefore writes two identical copies, and Cursor and VS Code
will list the skill twice. The plan tells you when this happens.

## 5. Check what is installed

```bash
agenthub list
agenthub verify
```

`verify` re-hashes every installed file and compares it with the lockfile. It exits with
code 4 if a file was changed, added or removed. It also rescans each skill and prints its
approval state; `list` shows an `APPROVAL` column read from the lockfile.

To approve the installed version's inventory yourself (for example after upgrading agenthub
or after a teammate's lockfile change):

```bash
agenthub approve web-testing --note "reviewed in PR 12"
```

## 6. Update safely

```bash
agenthub update --check          # what is available, and whether it can do more; changes nothing
agenthub diff web-testing        # capability and file changes of the next version; changes nothing
agenthub update web-testing      # show the plan, confirm, update
agenthub update --safe           # apply only updates that need no new approval
```

When you install a skill, agenthub records its **capability inventory** in the lockfile:
the programs it runs, the hosts it contacts, the environment variables and secrets it reads,
and its outbound references (URLs, git repositories, npm/PyPI/crates packages, MCP servers,
each marked pinned or unpinned). Confirming the install approves that inventory.

An update whose inventory goes beyond what you approved — a new host, a new program, a new
or loosened external reference — is refused until you approve it:

```text
Capabilities  web-testing 1.0.0 → 1.1.0
  + exec     uvx
  + network  telemetry.example.invalid
  + external https://setup.example.invalid/setup.md (unpinned, remote instructions)
This update can do more than the version you approved.
```

- At a terminal you are asked `Approve 3 new capabilities and update …? [y/N]` (default No).
- `--yes` alone never approves new capabilities: it exits with code 3 and changes nothing.
  Review with `agenthub diff <skill>`, then re-run with `--yes --approve-capabilities`.
- `--safe` applies an update only when it adds no capability, the current approval still
  holds, and the policy outcome is no worse than the installed version's.

The inventory comes from static analysis. It is not a safety verdict, and a change that only
rewords the instructions in SKILL.md cannot show up in it: the plan and `diff` print the
SKILL.md line change so you can read it.

`--safe` also skips any update that is incompatible, revoked or would overwrite local edits.

Every update keeps a snapshot of the version it replaced. If the new version fails
validation, the previous one is restored automatically.

## 7. Roll back

```bash
agenthub rollback web-testing
```

## 8. Remove

```bash
agenthub remove web-testing
```

Only files agenthub installed are removed. Files you added or changed are kept and listed.

## Interactive mode

Run `agenthub` with no command in a terminal to open the interactive app. It does everything
the commands below do, through the same engine, policy and approval rules, with the plan,
findings and capability changes laid out as cards.

```bash
agenthub              # interactive mode
agenthub -g           # start in the user scope
agenthub --no-color   # without colors
```

Type a few words and press Enter to search the registry, or type `/` to open the command
palette. It filters as you type; ↑↓ select, Tab completes (including installed skill names),
Enter runs.

| Command | What it does |
|---|---|
| `/search <query>` | Results with verdict (✔ allow, ⚠ warn, ✖ block), agents and summary |
| `/install <name[@range] | ./folder | file.skillpkg>` | Plan → review → confirm → staged install |
| `/remove <skill>` | Shows what would be deleted, then asks |
| `/list` | Installed skills with status, approval and agents |
| `/update [skill]` | Candidates with the CHANGE column; Enter expands the new capabilities |
| `/diff <skill>` | What the next version can do that the installed one cannot |
| `/approve <skill>` | Review and approve the installed capability inventory |
| `/rollback <skill>` | Restore the previous snapshot |
| `/verify [skill]` | Per-file drift against the lockfile |
| `/doctor` | Agents, folders, locks, approvals and problems, check by check |
| `/agents` | Choose target agents for this session (space toggles) |
| `/scope [project|user]` | Switch scope |
| `/registry [set <url> | reset]` | Show the registry, or use another one for this session |
| `/theme [dark|light|mono]` | Switch the color theme |
| `/help`, `/clear`, `/quit` | Help, back to home, leave |

Screens:

- **Search** — Enter opens the detail, `i` plans an install, `d` shows the diff; Tab lets you
  refine the query live.
- **Skill detail** — the trust receipt (digests, scanner, verdict stamp), declared permissions,
  the capability inventory, findings grouped BLOCK / WARN / INFO, requirements. Enter installs.
- **Install** — the plan shows which agents read each target folder, the safety findings,
  requirements and capabilities. Plans with WARN findings default to No. A blocked plan shows
  the rule and `file:line` evidence and writes nothing. After you confirm, the install runs
  through Scanning → Staging → Swapping → Verifying → Committed and ends with reload hints.
- **Update** — when a version can do more than the one you approved, its new capabilities are
  shown first and must be approved explicitly: press `a`, then answer the second question.
  A plain `y` never approves new capabilities. Press `r` on the result to roll back.
- **Installed** (`/list`) — `v` verify, `a` approve, `d` diff, `u` update, `b` roll back,
  `x` remove.

Keys: Esc goes back (or closes the palette), `?` opens help, `q` twice quits from the home
screen, Ctrl+C quits from anywhere (a running install finishes first).

| Variable | Effect |
|---|---|
| `NO_COLOR` | No colors (also `--no-color`, or `/theme mono`) |
| `FORCE_COLOR=1|2|3` | Force 16, 256 or 24-bit colors (detected otherwise) |
| `AGENTHUB_REDUCED_MOTION=1` | No animation: every screen renders its final state at once |
| `AGENTHUB_ASCII=1` | ASCII borders, symbols and spinners only |
| `AGENTHUB_UNICODE=1` | Full symbol set on the classic Command Prompt |
| `AGENTHUB_NO_TUI=1` | Never open the interactive mode |

The interactive mode opens only when both input and output are a terminal, outside CI and with
no command. Scripts, pipes and every command (`agenthub install x --json`, …) keep the classic
output. Windows Terminal, PowerShell and VS Code get the full symbol set; the classic Command
Prompt gets symbols every console font has, unless `AGENTHUB_UNICODE=1`.

## Command reference

| Command | What it does |
|---|---|
| `doctor` | Health report for agents, folders and installs |
| `search <query>` | Search the registry (`--agent`, `--category`) |
| `info <skill>` | Versions, trust evidence, requirements |
| `install [target]` | Install a skill; with no target, restore everything in the lockfile |
| `list` | Installed skills and their status |
| `verify [skill]` | Compare installed files with the lockfile |
| `update --check` / `update <skill>` / `update --safe` | Check for and apply updates (`--approve-capabilities` to approve new capabilities) |
| `diff <skill> [--to <version>]` | Capability and file changes against a registry version (read-only) |
| `approve <skill> [--note <text>]` | Approve the installed version's capability inventory |
| `rollback <skill>` | Restore the previous snapshot |
| `remove <skill>` | Remove an installed skill |
| `pack <dir>` | Build a `.skillpkg` from a skill folder |
| `config [get\|set\|unset]` | Show or change settings |

Exit codes: `0` ok · `1` error or problems found · `2` usage · `3` blocked by policy or new
capabilities need approval ·
`4` integrity or drift · `5` incompatible · `130` cancelled.
