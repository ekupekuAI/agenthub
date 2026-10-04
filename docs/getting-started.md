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
code 4 if a file was changed, added or removed.

## 6. Update safely

```bash
agenthub update --check          # what is available; changes nothing
agenthub update web-testing      # show the plan, confirm, update
agenthub update --safe           # update everything that passes every check
```

`--safe` skips any update that is incompatible, revoked, has findings that need a decision,
or would overwrite local edits.

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

## Command reference

| Command | What it does |
|---|---|
| `doctor` | Health report for agents, folders and installs |
| `search <query>` | Search the registry (`--agent`, `--category`) |
| `info <skill>` | Versions, trust evidence, requirements |
| `install [target]` | Install a skill; with no target, restore everything in the lockfile |
| `list` | Installed skills and their status |
| `verify [skill]` | Compare installed files with the lockfile |
| `update --check` / `update <skill>` / `update --safe` | Check for and apply updates |
| `rollback <skill>` | Restore the previous snapshot |
| `remove <skill>` | Remove an installed skill |
| `pack <dir>` | Build a `.skillpkg` from a skill folder |
| `config [get\|set\|unset]` | Show or change settings |

Exit codes: `0` ok · `1` error or problems found · `2` usage · `3` blocked by policy ·
`4` integrity or drift · `5` incompatible · `130` cancelled.
