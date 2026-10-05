# Writing and publishing a skill

## The package

```text
my-skill/
├── SKILL.md          required
├── agenthub.yaml     recommended: version, requirements, permissions
├── scripts/          optional helpers
├── references/       optional documents the agent loads on demand
└── assets/           optional templates and files
```

## SKILL.md

`SKILL.md` follows the open [Agent Skills specification](https://agentskills.io/specification).

```markdown
---
name: my-skill
description: Review SQL migrations for locking and data-loss risks. Use when a migration file changes.
license: MIT
---

# My skill

Instructions for the agent…
```

Rules agenthub enforces:

| Field | Rule |
|---|---|
| `name` | Required. 1–64 characters: lowercase letters, digits and single hyphens. Must equal the folder name. |
| `description` | Required. 1–1024 characters. Say what the skill does and when to use it. |
| `license` | Optional text. |
| `compatibility` | Optional, up to 500 characters. |
| `metadata` | Optional map of text values. |

Keep `SKILL.md` under 500 lines. Move detail into `references/` so agents only load it when
they need it.

## agenthub.yaml

```yaml
schema: 1
version: 1.0.0
targets: [claude-code, codex, cursor, vscode]   # omit to support every agent
requires:
  runtimes: { node: ">=22" }
  commands: [git, npx]
permissions:
  network: [registry.npmjs.org]   # true, false, or a list of hosts
  exec: [npx, node]               # programs your scripts run
  env: [CI]                       # environment variables your scripts read
  secrets: []                     # credential files or variables you must read
  fs: { write: [project, temp] }
channel: stable
```

Without `agenthub.yaml`, nothing is declared: every risky behavior the scanner finds counts
as undeclared.

### Declare honestly

Declared behavior is shown to the user as information. Undeclared behavior produces a
warning or blocks the install. Declare exactly what your scripts do, and nothing more.

Some things are blocked even when declared:

- downloading code and running it (`curl … | sh`, fetch then `eval`);
- obfuscated payloads (large encoded blobs decoded at run time);
- hidden instructions (zero-width or bidirectional control characters, instructions inside
  HTML comments);
- persistence (shell startup files, scheduled tasks, startup folders, git hooks, other
  agents' configuration).

## Writing a safe skill

- Keep scripts short and readable. A reviewer should understand them in a minute.
- Never ship credentials, tokens or `.env` files.
- Pin dependencies. Do not install packages at run time.
- Write only inside the project or a temporary folder.
- Do not ask the agent to ignore its instructions, hide actions from the user, reveal
  secrets, or turn off approval prompts.

## Check it locally

```bash
agenthub install ./my-skill --dry-run     # validation, scan and plan; nothing is written
agenthub pack ./my-skill                  # builds my-skill-1.0.0.skillpkg, prints digests
```

Packing the same folder always produces the same bytes and the same digests, on every
operating system.

## Publish

1. Select **Sign in with GitHub** on the registry. Your first sign-in creates your publisher.
   (On a registry without GitHub sign-in, ask the administrator for a publisher token.)
2. Upload the `.skillpkg` on the **Publish** page while signed in. For the command line or
   CI, create a named token under **Dashboard** → **CLI tokens** (it is shown once) and send
   the package to the API:

   ```bash
   curl -X POST "$REGISTRY/api/v1/publish" \
     -H "Authorization: Bearer $AGENTHUB_TOKEN" \
     -H "Content-Type: application/octet-stream" \
     --data-binary @my-skill-1.0.0.skillpkg
   ```

3. The registry validates the package, recomputes the digests and scans it. A release with
   blocking findings is quarantined until an administrator reviews it.

Publishing rules:

- **Versions are immutable.** To change anything, publish a new version.
- **Names belong to their first publisher.** Do not choose names that imitate another skill
  or publisher.
- **Revocation.** A revoked version can no longer be downloaded or installed, and `update`
  and `doctor` flag existing installs of it.
