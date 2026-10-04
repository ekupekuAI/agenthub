# Troubleshooting

Start with `agenthub doctor`. It reports most of the problems below and changes nothing.
Add `--verbose` to any command for more detail, or `--json` for machine-readable output.

## The agent does not show the skill

- Run `agenthub list` and `agenthub verify` to confirm the files are in place.
- A new skills folder may need a reload:
  - Claude Code: run `/reload-skills` in an open session.
  - Copilot CLI: run `/skills reload`.
  - Cursor: restart it.
- Check that `doctor` lists the agent. An agent that isn't detected can still be targeted
  with `--agent <id>`.

## Cursor or VS Code lists the skill twice

This is expected when you install for all four agents. Claude Code and Codex read different
folders, and Cursor and VS Code read both. The two copies are identical. To avoid it,
install for fewer agents, for example `--agent claude-code,cursor,vscode`.

## "no supported agents detected"

agenthub found no agent on this machine. Install for specific agents with
`--agent claude-code,codex,cursor,vscode`.

## The install was blocked (exit code 3)

The plan names the rule, file and line. If you wrote the skill, fix the behavior or declare
the permission in `agenthub.yaml`. Some behaviors are blocked even when declared; see the
[security model](security.md).

## "incompatible" (exit code 5)

The skill requires a runtime or command you don't have, or doesn't support any of your
agents. The message names the exact requirement, for example
`requires node >=22, found 20.11.0`.

## `verify` reports drift (exit code 4)

A file was changed, added or removed after installation.

- To restore the recorded version: `agenthub install <skill> --force`.
- To keep an intentional edit, publish it as a new version and install that.

Line-ending conversion by git (LF to CRLF) is not reported as drift.

## "another program may have a file open" (Windows)

An editor or agent is holding a file in the skill folder. agenthub retries for a few
seconds, then stops and restores the previous state. Close the program and run the command
again.

## A folder already exists and is not managed by agenthub

Another tool, or you, created a skill folder with the same name. agenthub will not overwrite
it. Move it away, or pass `--force` to replace it. If the folder is a link created by
another tool, `--force` removes only the link, never what it points to.

## An interrupted install

If agenthub is stopped in the middle of an install, the next command finishes the cleanup
and tells you what it did. Nothing is left half-installed.

## A version was revoked

`update --check` and `doctor` flag it. Update to a newer version or roll back to the
previous one.

## The registry cannot be reached

Check `agenthub config get registry`. Remote registries must use `https://`; `http://` is
accepted only for `localhost`. Skills that were installed before are cached and can be
reinstalled offline.

## Where agenthub keeps things

| Location | Contents |
|---|---|
| `<project>/.agenthub/agenthub.lock` | Project lockfile (commit it) |
| `<project>/.agenthub/config.json` | Project settings |
| `~/.agenthub/agenthub.lock` | Lockfile for `-g` installs |
| `~/.agenthub/cache/` | Downloaded packages, by digest |
| `~/.agenthub/snapshots/` | Previous versions, for rollback |
| `~/.agenthub/audit.log` | History of installs, updates, removals and overrides |

Set `AGENTHUB_HOME` to move `~/.agenthub`.
