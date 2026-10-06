# agenthub

The package manager and trust layer for agent skills.

agenthub installs skills in the open [Agent Skills](https://agentskills.io/specification)
format (`SKILL.md` folders) into Claude Code, Codex, Cursor and VS Code + GitHub Copilot with
one command. Every package is scanned and checked against the permissions its author declared
before anything is written, and every install is recorded in a lockfile so you can verify it,
update it safely and roll it back.

## Install

Works on Windows, macOS and Linux. Requires Node.js 22 or newer (on macOS: `brew install node`).

```bash
npm install -g @ekupekuai/agenthub
agenthub doctor
```

Or run it without installing:

```bash
npx @ekupekuai/agenthub search testing
```

Out of the box agenthub uses the public registry at
<https://agenthub-registry.vercel.app>. To use another one:

```bash
agenthub config set registry https://registry.example.com -g   # a hosted registry
agenthub config set registry file:./my-skills -g               # a folder of .skillpkg files
```

`AGENTHUB_REGISTRY` overrides the setting for one run.

## Interactive mode

Run `agenthub` with no command in a terminal to open the interactive app. Type a few words to
search, or `/` for the command palette. Plans, findings and capability changes are shown as
cards, with the same rules as the commands below. Scripts, pipes and CI always get the classic
output (`--json` for machine-readable output).

## Commands

| Command | What it does |
|---|---|
| `agenthub doctor` | Agents found, the folders they read, problems with existing installs |
| `agenthub search <query>` | Search the registry (`--agent`, `--category`) |
| `agenthub info <skill>` | Versions, permissions, requirements and scan findings |
| `agenthub install <skill[@range]>` | Plan, review, confirm, install (`--dry-run`, `--yes`, `-g`) |
| `agenthub install ./my-skill` | Install from a local folder or `.skillpkg` file |
| `agenthub list` | Installed skills, status and approval |
| `agenthub verify` | Re-hash installed files against the lockfile (exit 4 on drift) |
| `agenthub update --check` | Available updates and whether they can do more; changes nothing |
| `agenthub diff <skill>` | Capability and file changes of the next version (read-only) |
| `agenthub rollback <skill>` | Restore the previous version from its snapshot |
| `agenthub remove <skill>` | Remove a skill; files you changed are kept |

Run `agenthub --help` for every command and option.

## Safety model

- **Scanned before install.** Static rules look for shell execution, network access, secret
  reads, download-and-run, obfuscation, persistence, prompt injection and hidden Unicode.
  Nothing a package contains is executed at install time.
- **Capability-gated.** Skills declare what they need. Undeclared risky behavior is a warning
  you must confirm or a block that stops the install.
- **Approved inventories.** The lockfile records what each skill can do: programs, hosts,
  secrets and external references. An update that can do more is refused until you approve
  it; `--yes` alone never approves new capabilities.
- **Reversible.** Installs are transactional, every update keeps a snapshot, and
  `rollback` restores it. `remove` deletes only the files agenthub wrote.
- **No silent registries.** A cloned repository cannot choose where packages come from: a
  registry in a project's config is ignored until you trust it.

## Links

- Website and skill catalog: <https://agenthub-registry.vercel.app>
- Publishing guidelines: <https://agenthub-registry.vercel.app/guidelines>
- Source and issues: <https://github.com/ekupekuAI/agenthub>

## License

MIT
