# Security model

A skill is not safe because it is Markdown. Skills can bundle scripts, and they instruct an
agent that acts with your permissions. agenthub treats every skill as a supply-chain
artifact.

## What agenthub guarantees

| Control | How |
|---|---|
| **Integrity** | Every version has a content digest: SHA-256 over the sorted list of per-file SHA-256 hashes. It is checked after download, after extraction and after install, and recorded in the lockfile. The archive itself has a second digest for download integrity. |
| **Immutable releases** | The registry stores packages by digest and never overwrites a version. |
| **Scan before install** | The package is scanned before any file is written. The registry runs the same scanner on every upload. |
| **Declared permissions** | Findings are compared with what the skill declared in `agenthub.yaml`. |
| **No code execution** | agenthub never runs a skill's scripts or tests, at install time or any other time. |
| **Contained writes** | Every write goes through a guard that allows only the planned skill folders and agenthub's own state folders. |
| **Safe extraction** | Archives may contain regular files only. Symlinks, hard links, absolute paths, `..`, Windows reserved names, case-colliding names and oversized or over-compressed archives are rejected. |
| **All or nothing** | An install is one transaction. A failure restores the previous state, including after a crash. |
| **Revocation** | Revoked versions cannot be downloaded or installed. |
| **Capability-gated updates** | Each lockfile entry records a capability inventory, its digest, the scanner ruleset digest and an approval bound to all three. The install engine itself refuses an update that can do more than the approved version unless the approval is explicit (exit 3, nothing written). `--yes` alone never approves new capabilities. |
| **Lockfile as untrusted input** | The lockfile is validated strictly (unknown keys are rejected, never stripped), every capability block must hash to its recorded digest, and a lockfile from a newer agenthub is refused without being rewritten. The recorded inventory is never trusted on its own: the approved baseline is the record intersected with a fresh scan of the installed bytes, and a missing approval means an empty baseline. |
| **Audit trail** | Installs, updates, approvals, removals, rollbacks and policy overrides are appended to `~/.agenthub/audit.log`, with how each approval was given (prompt, flag, carried forward). |

## Install policy

| Finding | Not declared | Declared |
|---|---|---|
| Medium risk: network access, running programs, reading environment variables, installing packages at run time, suspicious instructions, unexpected binaries | **WARN**: you must confirm | **INFO** |
| High risk: reading credentials or secret files | **BLOCK** | **WARN**: you must confirm |
| Never allowed: download-and-run, obfuscated payloads, dynamic code fed by network or encoded data, hidden instructions, persistence | **BLOCK** | **BLOCK** |

`--dev` turns a BLOCK into a warning for local development. It prints a notice and records
an `override` event in the audit log. Do not use it on skills you did not write.

## Scanner rules

| Rule | Detects |
|---|---|
| `exec.shell` | Running programs or shells |
| `net.access` | HTTP clients, sockets, `curl`, `wget` |
| `net.download-exec` | Downloaded content piped into an interpreter or executed |
| `secrets.read` | `.env`, cloud and SSH credentials, keychains, browser profiles |
| `env.read` | Reading environment variables |
| `code.dynamic` | `eval`, `new Function`, executing strings |
| `code.obfuscated` | Large encoded payloads decoded at run time |
| `fs.persistence` | Shell startup files, scheduled tasks, startup folders, git hooks |
| `deps.remote` | Installing packages or pulling code at run time |
| `prompt.injection` | Instructions to ignore rules, hide actions, reveal secrets or disable approvals |
| `prompt.hidden` | Zero-width, bidirectional and tag characters; instructions inside HTML comments |
| `file.binary` | Executables and nested archives |
| `ext.remote-instructions` | Text that tells the agent to fetch and follow instructions from a URL |

Every finding names the rule, file and line, and shows the evidence.

### Remote instructions and outbound references

The scanner also inventories outbound references without fetching anything: URLs in scripts
and in SKILL.md or reference text, git repositories, packages run or installed with
`npx`/`uvx`/`pipx`/`pip`/`npm`/`cargo`, `curl`/`wget`/`iwr` targets and MCP server URLs. Each
is marked pinned (sha256 checksum, full git commit, exact version) or unpinned (anything that
can change after you approve it: branches, tags, ranges, plain URLs).

| Remote instructions | Host not in `permissions.network` | Host declared |
|---|---|---|
| Unpinned | **BLOCK** | **WARN** (the content can change after approval) |
| Pinned to a commit or checksum | **WARN** | **INFO** |

A new reference, a loosened pin, a changed pin value or a stronger use (e.g. from a link to
something that is run) counts as a capability expansion on update.

### Approvals

- A fresh install's confirmation is its approval. An update that adds nothing carries the
  approval forward. An update that adds anything needs an explicit approval.
- `update --safe` never approves anything.
- `rollback` restores the snapshot's own approval; it is never gated.
- When agenthub's scanner rules change, an approval recorded under the old rules is rechecked
  against a fresh scan of the same bytes: if nothing new is seen it is carried; otherwise
  `verify` and `doctor` report it as stale until you run `agenthub approve <skill>`.
- Approvals are self-asserted (`AGENTHUB_APPROVED_BY` is free text). The evidence is the
  reviewed commit that changes `.agenthub/agenthub.lock`; protect it with code review.

## What agenthub does not guarantee

- A static scanner cannot prove a skill is safe. A clean scan means no known risky pattern
  was found.
- agenthub does not sandbox your agent. Once a skill is installed, the agent follows it with
  the agent's own permissions. Keep your agent's approval prompts on.
- Releases are not cryptographically signed yet. Integrity relies on digests pinned in the
  lockfile and on the registry's immutable storage.
- A capability inventory only lists what static analysis recognizes. A change that only
  rewords SKILL.md, code assembled at run time, and languages the scanner does not analyze
  are not seen. `exec` names launchers (`npx`, `uvx`, `python`, shells), not every command.
- An approved unpinned reference or remote instruction can change after approval; agenthub
  does not re-fetch it.
- Remote-instruction detection is a heuristic over verbs and nouns; other phrasings are
  recorded as plain references.

## Registry security

- Publishing requires a publisher token. Tokens are shown once and stored only as a hash.
- Administration requires a separate secret and a signed, short-lived session.
- Every input is validated; uploads are size-limited; requests are rate-limited.
- Skill content is never rendered as HTML.
- Responses carry a strict Content-Security-Policy, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff` and related headers.

## Reporting a problem

To report a malicious skill or a vulnerability in agenthub, contact the registry
administrator with the skill name, version and digest. Administrators can quarantine or
revoke a version immediately.
