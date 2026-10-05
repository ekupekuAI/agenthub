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

## "can do more than the version you approved" (exit code 3)

The update adds capabilities (a host, a program, an external reference or a looser pin) that
your approval does not cover, and nothing was changed. Review the change with
`agenthub diff <skill>`, then either answer `y` at the prompt or re-run with
`--yes --approve-capabilities`. `--yes` alone never approves new capabilities, and
`update --safe` skips such updates by design.

If the plan says the installed version has **no capability approval**, its lockfile entry was
written by an older agenthub or its approval was removed: run `agenthub approve <skill>`
after reviewing what it can do.

## "approval stale" or "approved under other scanner rules"

agenthub's scanner rules changed and now see something the recorded approval did not cover
(`verify` lists it). The skill's files did not change. Review the new items and run
`agenthub approve <skill>`. Restoring and reinstalling the same version is not blocked.

## "the lock's capability record does not match the installed files" (exit code 4)

Someone edited the capability block in `.agenthub/agenthub.lock` (or a merge combined two
versions of it). If the error says `LOCK_INCONSISTENT`, the block does not even match its own
digest: take one side of the merge. Then run `agenthub approve <skill>` to record what the
installed files really do.

## "written by a newer agenthub" (LOCK_TOO_NEW)

The lockfile uses a format this agenthub does not know. Upgrade agenthub; the file is not
changed. Version 2 lockfiles (capability approvals) cannot be read by agenthub releases from
before this feature, so upgrade the whole team together. A version 1 lockfile is read as is
and upgraded the next time a command changes it; `doctor` reports `lock.v1` until then.

## "quarantined in the lock"

The lockfile entry carries a `quarantine` field. Install, update, restore and approve refuse
that skill until the entry is reviewed and removed (`agenthub remove <skill>`).

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
