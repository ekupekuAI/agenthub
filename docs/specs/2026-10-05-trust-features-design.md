# agenthub — Trust Features Design (F1–F7)

Status: **Draft for approval** · Date: 2026-10-05 · Owner: Ekansh

Builds on the [MVP design](2026-10-04-agenthub-mvp-design.md) ("MVP §n") and the research plan
`differentiation-plan.raw.json` (ranks 1–4, 6, 8). Where this document is more specific, it wins.
Code is cited by symbol, not line, against the tree of 2026-10-05 (HEAD `132544b`): security fixes
and the web redesign are in flight, so hook points must be located by name.

## 0. Scope and decisions

**Built:** F1 capability lock and diff-gated updates · F2 outbound-reference lock (lock, policy,
diff; no online watchdog) · F3 `agenthub ci` (budgets, digest-bound expiring exceptions, revoked
check, SARIF 2.1.0) · F4 `agenthub adopt` · F5 `agenthub audit` (lite) · F6 registry name protection
(lite, flat names) · F7 registry and web surfaces for F1/F2.
**Reserved in lock v2, not built:** `signer`, `quarantine`.
**Not built:** watchdog, prose diff, release-age cooldown, install-time budgets, policy `extends`,
`@publisher/skill` namespaces, composition analysis, auto-exec config rules.

Decisions (continuing MVP D1–D10):

| # | Decision |
|---|---|
| D11 | The capability model, digest and diff live in **`core`** (`packages/core/src/capabilities.ts`, pure). `core` validates the lock and runs the gate and must not import the scanner; the scanner supplies findings, externals and `rulesetDigest` through the existing `SecurityPort.scan`. |
| D12 | **Gates recompute from verified bytes.** Capability fields in the lock are a reviewable record (a capability change shows up in `git diff` of the lock) and are checked for truthfulness. They are never trusted alone: the approved baseline is the recorded set *intersected with a fresh scan* (§4.2). |
| D13 | **Expansion = any added token.** Wildcards never absorb: a new concrete host is an expansion even when `*` is already present. |
| D14 | `--yes` confirms plans. It **never** approves an expansion on update or adopt. On a fresh install the plan confirmation *is* the approval. |
| D15 | No valid approval ⇒ the approved baseline is **empty** (deleting an approval from the lock yields more prompts, never fewer). |
| D16 | Same-digest operations (restore, re-target) carry the entry verbatim, so a scanner upgrade does not dirty locks. Staleness is computed at read time. |
| D17 | `.agenthub/policy.json` can only **tighten** built-in defaults; exceptions waive only violations the policy file itself created (§7.3). |
| D18 | Remote instructions use the existing tiers: unpinned = high/declarable, pinned = medium/declarable (§5.4). No new manifest key. |
| D19 | Names stay flat. `@publisher/skill` is recorded as a future one-way door (§10.5). |
| D20 | Foreign hashes are recorded, never recomputed, and nothing foreign is called "verified" (§9.3). |
| D21 | `ci` is the gate (exit 3/4). `verify` stays integrity-only. `audit` and `diff` are informational (exit 0). |

## 1. Capability model

### 1.1 Types (`packages/core/src/types.ts`)

```ts
export const CAPABILITY_KEYS = ['binaries','dynamic','env','exec','fsWrite','installers',
  'markers','network','prompt','secrets'] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export interface ExternalRef {
  kind: 'url' | 'git' | 'npm' | 'pypi' | 'crates' | 'mcp';
  id: string;                    // canonical, §5.2
  host?: string;                 // url/git/mcp only; '*' when templated
  pin: 'sha256' | 'commit' | 'version' | 'unpinned';
  pinValue: string | null;       // hash, 40-hex commit, exact version, or the mutable ref
  role: 'reference' | 'fetch' | 'install' | 'run' | 'instructions';
}
/** Sorted, unique string tokens per key, plus externals. */
export interface CapabilitySet extends Record<CapabilityKey, string[]> { externals: ExternalRef[] }
export interface CapabilityReport {
  set: CapabilitySet; digest: string /* capabilityDigest */; rulesetDigest: string;
  undeclared: string[];   // 'network:x.ngrok.io' — observed, not covered by the manifest
  unobserved: string[];   // 'network:*' — declared, no finding covered by it
}
```

`ScanResult` gains `rulesetDigest: string` and `externals: ExternalRef[]`; `FindingCategory` gains
`'remote-instructions'`. Both are additive for readers; producers (scanner, test fakes) change.

### 1.2 Observed tokens: which `Finding` fields feed which key

Only `category`, `subject` and `declarable` are read. `file`, `line`, `evidence`, `message` and
`severity` never reach the set, so moving or reformatting code does not change it. A missing
`subject` becomes `*`. Derivation uses the **strict** evaluation (`dev: false`), so `--dev` cannot
alter the set.

| Rule (category) | `subject` today | Key | Token |
|---|---|---|---|
| `exec.shell` (exec) | launcher name from `programName()`, or `*` (computed) | `exec` | lower-cased subject |
| `net.access` (network) | host from `hostFromAuthority()`, or `*` | `network` | `normalizeHost(subject)`: an exact host |
| `net.download-exec` (download-exec) | host or `*` | `markers` + `network` | `download-exec`; host token |
| `secrets.read` (secrets) | `~/.aws/credentials`, `.env`, `keychain`, `browser-profile`, `env:*` | `secrets` | `normalizeSecretPath(subject)` |
| `env.read` (env) | variable name or `*` | `env` | subject (case kept) |
| `code.dynamic` (dynamic) | `eval`, `new Function`, `vm`, `scriptblock`, … | `dynamic` (+ `markers` when `declarable === false`) | lower-cased label; marker `dynamic-untrusted` |
| `code.obfuscated` (obfuscation) | `encoded-blob`, `packed`, … | `markers` | `obfuscation:<subject>` |
| `fs.persistence` (persistence) | `~/.bashrc`, `scheduler`, `git-hooks`, `agent-config`, … | `markers` | `persistence:<subject>` |
| `prompt.hidden` (hidden) | `unicode-tags`, `invisible-unicode`, `html-comment` | `markers` | `hidden:<subject>` |
| `deps.remote` (deps) | `npm`, `pip`, `uv`, … | `installers` | subject |
| `prompt.injection` (prompt) | `override`, `concealment`, `secrets`, `approvals` | `prompt` | subject |
| `file.binary` (binary) | `elf`, `pe`, `zip`, extension, … | `binaries` | subject |
| `ext.remote-instructions` (remote-instructions, new) | host | `network` | host token (the reference itself is in `externals`) |

`markers` are **non-approvable**: every marker comes from a never-declarable finding, so the strict
policy outcome is `block` and no approval is ever written for that set (§4.3). `fsWrite` has no
scanner rule today and is declared-only. `exec` is as coarse as `exec.shell`: it names launchers
(`LAUNCHERS` in `lang/shell.ts`), not every command.

### 1.3 Declared tokens (manifest `permissions`)

| Manifest | Key | Token |
|---|---|---|
| `network: true` | `network` | `*` |
| `network: [h]` (`h` or `*.h`; `isDeclared` treats both alike) | `network` | `*.<normalizeHost(h)>` — "this domain and its subdomains" |
| `exec`, `env`, `secrets`, `fs.write` | `exec`, `env`, `secrets`, `fsWrite` | same normalization as observed |

So in `network`: `*` = any host, `*.d` = a declared grant, a bare host = an observed endpoint.

### 1.4 Combining observed and declared; mismatch

`deriveCapabilities(findings: EvaluatedFinding[], manifest, externals, rulesetDigest)` returns the
**union** of observed and declared tokens per key. A declaration is itself a grant (it downgrades
future findings), so adding one must be gated. The mismatch is reported and shown, never stored in
the lock:

- `undeclared`: tokens from findings with `declared === false` in the declarable keys (`exec`, `network`, `env`, `secrets`, `installers`). The flag is the one `evaluatePolicy` already computes, so there is one coverage implementation.
- `unobserved`: declared tokens that cover no finding (over-declaration, e.g. `network:*` with no network code).

`normalizeHost`, `hostCovered`, `normalizeSecretPath` and `secretCovered` move from
`packages/scanner/src/policy.ts` (today private `normalizeHost`/`hostMatches`/`normalizeSecret`/
`secretMatches`) to `core/src/capabilities.ts`; `policy.ts` imports them back. Hosts are converted
to punycode with `node:url` `domainToASCII`.

### 1.5 Canonical form and digests

- Canonical JSON = `JSON.stringify(sortKeysDeep({ schema: 1, ...set }))`: no whitespace, UTF-8, every array sorted by JavaScript string order and de-duplicated, `externals` sorted by `(kind, id, pin, pinValue ?? '')`, absent `host` omitted, null `pinValue` kept.
- `capabilityDigest = 'sha256:' + sha256Hex(canonical)`. The mismatch lists are **not** covered: a ruleset that newly observes an already-declared host must not invalidate an approval.
- `rulesetDigest = 'sha256:' + sha256Hex(JSON.stringify({ extractor: EXTRACTOR_VERSION, rules: [...RULE_IDS].sort(), scanner: SCANNER_VERSION }))`, exported as `RULESET_DIGEST` from `packages/scanner/src/ruleset.ts`.
- Rule: any change to a pattern table or analyzer bumps `SCANNER_VERSION` (now `1.1.0`). A test hashes the fixture expectations and fails when they change without a bump.

## 2. Delta semantics

```ts
export interface ExternalChange { change: 'pin-changed' | 'pin-loosened' | 'role-escalated';
  from: ExternalRef; to: ExternalRef }
export interface CapabilityDelta {
  added: Record<CapabilityKey, string[]>;  removed: Record<CapabilityKey, string[]>;
  externals: { added: ExternalRef[]; removed: ExternalRef[]; changed: ExternalChange[];
               tightened: { from: ExternalRef; to: ExternalRef }[] };
  expansion: boolean;
  reasons: string[];   // sorted display tokens: '+network:x.ngrok.io', '~npm:tool 1.2.3→^1 (pin loosened)'
}
export function diffCapabilities(installed: CapabilitySet | null, candidate: CapabilitySet): CapabilityDelta;
export interface FileChangeSummary { added: string[]; removed: string[]; modified: string[];
  unchanged: number; skillMd: { before: number | null; after: number; delta: number | null } }
export function summarizeFileChanges(prev: { files: Record<string,string>; skillMd: string | null } | null,
                                     next: { files: Record<string,string>; skillMd: string }): FileChangeSummary;
```

`diffCapabilities` is pure, total and order-independent; `installed === null` means everything is
added. **Expansion** is true when any of these holds:

1. `added[key]` is non-empty for any key (set difference on canonical tokens). This covers every loosening of a list: host list → `*`, a new `*.d` grant, `exec:*`, `env:*`.
2. An external with a new `(kind, id)` appears, pinned or not.
3. For an existing `(kind, id)`, a candidate variant is **not covered**. A variant is covered when the installed set has the identical `(pin, pinValue)` with role ≥ its role, or the variant is pinned and the installed set has an *unpinned* variant of that id with role ≥ its role. Otherwise it is `pin-loosened` (pinned → unpinned), `pin-changed` (another `pinValue`, including one mutable ref → another) or `role-escalated`.

Role order: `reference < fetch < install < run = instructions`. **Never an expansion:** removals;
unpinned → pinned (`tightened`); file moves; changed line numbers or evidence; changes in the
mismatch lists (those change the *policy outcome*, which `--safe` checks separately, §4.3).

The file summary is for display only: paths compare per-file hashes (`LockEntry.files` vs
`SkillPackage.fileHashes`); `skillMd` counts lines of the LF-normalized file.

## 3. Lock v2

### 3.1 Example

```json
{
  "lockfileVersion": 2,
  "skills": {
    "web-testing": {
      "approval": { "approvedAt": "2026-10-05T09:12:44Z", "approvedBy": "dev@example.com",
                    "capabilityDigest": "sha256:9c1e…", "digest": "sha256:41ab…",
                    "note": "reviewed in PR 12", "rulesetDigest": "sha256:77f0…" },
      "capabilities": {
        "binaries": [], "dynamic": [], "env": ["PLAYWRIGHT_BROWSERS_PATH"],
        "exec": ["node", "npx"], "fsWrite": ["project", "temp"], "installers": [],
        "markers": [], "network": ["*.example.com", "api.example.com"], "prompt": [], "secrets": []
      },
      "capabilityDigest": "sha256:9c1e…",
      "digest": "sha256:41ab…",
      "externals": [
        { "id": "playwright", "kind": "npm", "pin": "version", "pinValue": "1.48.0", "role": "run" },
        { "host": "docs.example.com", "id": "https://docs.example.com", "kind": "url",
          "pin": "unpinned", "pinValue": null, "role": "reference" }
      ],
      "files": { "SKILL.md": "sha256:…", "agenthub.yaml": "sha256:…", "scripts/run.sh": "sha256:…" },
      "installedAt": "2026-10-05T09:12:44Z",
      "installedTargets": ["claude-code", "codex", "cursor", "vscode"],
      "paths": { ".agents/skills/web-testing": ["codex", "cursor", "vscode"],
                 ".claude/skills/web-testing": ["claude-code"] },
      "registry": "https://registry.example.dev", "rulesetDigest": "sha256:77f0…",
      "source": "registry", "version": "1.3.0"
    }
  }
}
```

(Objects and arrays are shown inline for brevity; the file is plain `JSON.stringify(_, null, 2)`.)
An adopted entry has `"source": "adopted"`, `"registry": null` and:

```json
"origin": { "adoptedAt": "2026-10-05T10:00:00Z", "status": "unverified", "tool": "vercel-skills",
            "reported": { "computedHash": "3f9a…", "ref": "main", "source": "acme/skills", "sourceType": "github" } }
```

### 3.2 Fields and validation

The lock is committed, so in a cloned repo it is attacker-controlled input. `lockEntrySchema` and
`lockSchema` switch from `z.object` (which strips unknown keys today) to `z.strictObject`. `types.ts`
gains `LockApproval`, `LockOrigin`, the optional `LockEntry` fields below and `LockFile.lockfileVersion: 2`.

| Field | Rule |
|---|---|
| `lockfileVersion` | integer. `1` → v1 schema; `2` → v2; `> 2` → `LOCK_TOO_NEW` (§3.4); anything else → `VALIDATION` |
| skill key | `SKILL_NAME_PATTERN`, ≤ 64. Lookups keep using `own()` (`Object.hasOwn`) |
| `version` | 1–256 chars, charset of `isSafeVersionName` |
| `digest`, `capabilityDigest`, `rulesetDigest`, `files.*` | `^sha256:[0-9a-f]{64}$` |
| `source` | `file` \| `dir` \| `registry` \| `adopted` |
| `registry` | string ≤ 2048 or null. Display only (through `clean()`); never a fetch target — `packageForEntry` uses the *configured* registry |
| `installedTargets`, `paths.*` | `AGENT_IDS`, unique. `paths` ≤ 8 keys, each checked by `resolveLockPath` on use (unchanged) |
| `files` | ≤ `DEFAULT_LIMITS.maxFiles` keys, each through `checkPackagePath` (unchanged) |
| `installedAt`, `approvedAt`, `adoptedAt` | `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$` |
| `capabilities` | strict object with exactly the ten `CAPABILITY_KEYS`; each ≤ 256 items of 1–256 chars. `exec`, `installers`, `binaries`, `dynamic`, `prompt`, `markers`: `^(\*\|[a-z0-9][a-z0-9 ._:+~/-]{0,127})$`; `env`: `^(\*\|[A-Za-z_][A-Za-z0-9_]{0,127})$`; `network`: `*`, `*.<hostname>`, hostname or IP literal, ≤ 255; `secrets`: printable, no control characters; `fsWrite`: enum |
| `externals` | ≤ 256 strict objects: `kind`, `pin`, `role` enums; `id` 1–512 printable non-space chars; `host` hostname or `*`; `pinValue` ≤ 128 or null |
| capability block | `capabilities`, `capabilityDigest`, `rulesetDigest`, `externals` are **all present or all absent** (absent = migrated from v1, not yet touched). When present, arrays are normalized (sorted, unique) on read and `capabilityDigest` must equal the digest recomputed from them, else `VALIDATION` with `details.code = 'LOCK_INCONSISTENT'` (catches bad merges) |
| `approval` | strict: `digest`, `capabilityDigest`, `rulesetDigest`, `approvedAt`; optional `approvedBy` (1–128 printable) and `note` (1–500, single line). A parseable approval that does not match its entry is treated as **absent** (§4.1), not as an error |
| `origin` | strict: `tool` (`vercel-skills` \| `gh-skill` \| `unknown`), `status` literal `unverified`, `adoptedAt`, `reported` (≤ 16 keys `^[a-z][A-Za-z0-9-]{0,31}$` → printable strings ≤ 512) |
| `signer`, `quarantine` (reserved) | optional string maps: ≤ 16 keys `^[a-z][A-Za-z0-9-]{0,31}$` → strings ≤ 512. Round-tripped verbatim, never written by this release |

Reserved fields **fail closed**, so an older client cannot be used to bypass a newer one: an entry
with `quarantine` is skipped by `restore` with a warning, blocks `install`/`update` (blocker
`CONFLICT`) and fails `ci` (`quarantine.present`); an entry with `signer` can be restored and
verified but not updated ("update needs an agenthub that verifies signatures"). Any other new
field needs a `lockfileVersion` bump.

### 3.3 v1 → v2

- `parseLock` peeks `lockfileVersion`. A v1 file parses with the v1 (lenient) schema and is returned in the v2 in-memory shape with no capability block on any entry. `emptyLock()` returns version 2.
- Read-only commands never write, so a v1 file stays v1 on disk. The next command that writes the lock serializes v2 ("upgrade on next write"); entries it did not touch stay block-less.
- **First touch** computes an entry's capability block: `approve`, `adopt`, and any install or update that changes the digest. Same-digest operations carry the entry verbatim (D16). Migration never invents an approval: v1 entries are `unapproved` until `agenthub approve`.
- `parseLockEntry` (snapshot `entry.json`) and `journalSchema.newEntry` use the same v2 entry schema. A v1-era entry is a valid block-less v2 entry, so old snapshots and journals still load.
- Older clients read a v2 lock as `invalid lock file …: lockfileVersion` and exit 1 (their `z.literal(1)`): they refuse rather than strip. Docs: upgrade the whole team together.

### 3.4 Unknown future versions

`lockfileVersion > 2` throws `AgentHubError('VALIDATION', 'lock file <path> was written by a newer
agenthub (lockfileVersion N); upgrade agenthub', { code: 'LOCK_TOO_NEW', lockfileVersion: N })`.
Every command, including read-only ones, stops (exit 1). The file is never rewritten.

### 3.5 Determinism and merges

`serializeLock` is unchanged: `sortKeysDeep`, 2 spaces, trailing newline. Token arrays and
`externals` are sorted; agents follow `AGENT_IDS` order (`sortAgents`). There are no file-level
counters, and one skill is one contiguous block, so branches touching different skills merge
cleanly. Two branches touching the same skill conflict inside that block: take one side, then run
`agenthub approve <skill>`; `LOCK_INCONSISTENT` and `lock.capabilities-mismatch` catch a
hand-merged block. Capability values never depend on line endings (`buildSkillPackage`
LF-normalizes before scanning).

## 4. Approval rules

### 4.1 State of an installed entry (`core/src/engine/approval.ts`)

`approvalState(entry, current: CapabilityReport | null, strictOutcome)`. `current` is a rescan of
the installed bytes after they verify against `entry.files` (else of the cached package; else `null`).

| Order | Condition | State |
|---|---|---|
| 1 | no `approval`, or `approval.digest ≠ entry.digest`, or `approval.capabilityDigest ≠ entry.capabilityDigest`, or no capability block | `unapproved` |
| 2 | strict policy outcome is `block` | `not-approvable` |
| 3 | `entry.rulesetDigest` = current ruleset and `current.digest = entry.capabilityDigest` | `approved` |
| 4 | same ruleset, digests differ | `unapproved` + integrity result `lock.capabilities-mismatch` (the lock does not describe the bytes) |
| 5 | ruleset changed, `current.set` ⊆ recorded set (coverage of §2) | `approved-carried` |
| 6 | ruleset changed, something new | `stale` (lists the new tokens) |

When `current` is `null` (no intact copy, no cache), rows 2–6 cannot be evaluated: the entry is
reported as "cannot recheck" and counts as `unapproved` for the gate.

### 4.2 Approved baseline `B` and the gate

- `approved` → `B = current.set`. `approved-carried` / `stale` → `B = current.set ∩ recorded set` (a token counts only if it was recorded as approved **and** is really in the bytes). `unapproved` / `not-approvable` / no intact copy and no cache → `B = ∅` (D15).
- `unapproved = diffCapabilities(B, candidate)`; the gate is `unapproved.expansion`.
- For display the plan also carries `delta = diffCapabilities(current.set, candidate)` ("what changes on disk"). In the normal case both are equal.

### 4.3 Decision table

"Written" means a new `approval` block bound to the new `(digest, capabilityDigest,
rulesetDigest)`. An approval is **never** written when the strict policy outcome is `block`.

| Case | Proceeds when | Approval |
|---|---|---|
| Fresh install (no entry) | plan confirmed: interactive yes, or `--yes`. Non-interactive without `--yes` is `USAGE` when the inventory is non-empty (`needsConfirmation`) | written (the confirmation is the approval). Empty inventory: written without a prompt |
| Reinstall / restore from lock (same digest) | bytes match `digest` (`packageForEntry`: intact copy, cache, or `downloadVerified`) | carried verbatim; none written, none removed |
| Install/update to another digest, no expansion | existing confirmation rules | carried forward: new block, `approvedBy` kept, `approvedAt` = now, `note` = `carried forward from <digest8>` |
| …with expansion, interactive | delta shown, prompt default **No** | written on yes; no → `CANCELLED` (130) |
| …with expansion, non-interactive (`--json` or no TTY) | `--approve-capabilities` (plus `--yes` for the plan). `--yes` alone → `APPROVAL_REQUIRED`, exit 3, nothing written | written |
| `update --safe` | no blockers **and** no expansion **and** state `approved`/`approved-carried` **and** policy outcome not worse than the installed version's. Otherwise skipped with the reason; never prompts. `--safe --approve-capabilities` is `USAGE` | carried forward |
| Ruleset change, same digest (`stale`) | nothing is blocked locally; `list`/`verify`/`doctor` warn, `ci` exits 3 | `agenthub approve` writes a new one |
| `--dev` | only overrides policy BLOCK, as today. An expansion still needs the interactive yes or `--approve-capabilities` | not written while the strict outcome is `block`; `approve` refuses (exit 3) |
| Rollback | snapshot digest verified (unchanged check in `rollback()`); never gated, even if the old version can do more | snapshot entry restored verbatim, including its approval when `approval.digest` = snapshot digest |
| Adopt | interactive yes to the shown inventory, or `--yes --approve-capabilities`. `--yes` alone adopts **without** approval | written only in the first two cases |
| `agenthub approve` | installed bytes verify (else exit 4); strict outcome not `block`; interactive yes or `--yes` | written; capability block refreshed |

The gate is enforced in `Engine.apply`, not only in the CLI: `apply(plan, { approve })` recomputes
the candidate report and the baseline from the lock as read at apply time and throws
`APPROVAL_REQUIRED` when there is an expansion and no `approve` input. The approval mode
(`prompt` \| `yes` \| `flag` \| `carried` \| `command`) goes to `audit.log`, not the lock.
`approvedBy` is `AGENTHUB_APPROVED_BY`, else `git config user.email` (read-only, 2 s, no shell),
else omitted. It is self-asserted; the evidence is the commit that changes the lock.

## 5. Externals extraction (`packages/scanner/src/externals.ts`)

Pure, offline, text files only. `FileScan` gains `externals`; analyzers call `scan.addExternal()`
from the loops they already run, so there is no second parser.

### 5.1 What is extracted

| Where | Form | kind | role |
|---|---|---|---|
| Scripts and shell-dialect fenced blocks (the units `scanFile`/`analyzeMarkdown` already analyze) | `curl`/`wget`/`iwr`/`irm`/`Invoke-WebRequest` targets (`DOWNLOADERS`); literal URLs in `fetch`/`requests`/`urllib` calls | `url` | `fetch`; `run` when the line also yields `net.download-exec` |
| | `git clone <url>`, `git+https://…`, `git@host:o/r`, `github:o/r` | `git` | `install` |
| | `npx`, `bunx`, `pnpm dlx`, `yarn dlx`, `npm exec <pkg>[@v]` | `npm` | `run` |
| | `npm i/install/add`, `pnpm add`, `yarn add`, `bun add` (the `depsInstaller` cases); `package.json` dependency keys | `npm` | `install` |
| | `uvx`, `pipx run`, `uv tool run <pkg>` | `pypi` | `run` |
| | `pip install`, `uv pip install`, `uv add`, `pipx install`; `requirements*.txt` lines | `pypi` | `install` |
| | `cargo install <crate>` | `crates` | `install` |
| | `--index-url`, `--extra-index-url`, `--registry <url>` | `url` | `install` |
| | JSON with a top-level `mcpServers` object (`url`; or `command` `npx`/`uvx` + args); `claude mcp add` / `codex mcp add … <url>` | `mcp` (or `npm`/`pypi`) | `run` |
| Prose: SKILL.md body and description, any `.md`/`.mdx`/`.txt`, outside fences | URL in a sentence matching §5.4 | `url` | `instructions` |
| | any other URL (inline, autolink, link target, reference definition) | `url` | `reference` |

### 5.2 Normalization

- URLs go through WHATWG `URL` in a `try`: schemes `http`, `https`, `ws`, `wss`, `ftp` only; host lower-cased and punycoded; userinfo, default port, query, fragment and trailing dot removed; path case kept, trailing `/` trimmed. `http` and `https` are different ids. No host is ignored (fixtures use `.invalid` hosts and must be seen).
- `reference` URLs collapse to their origin (`https://docs.example.com`), or to `https://host/owner/repo` on `github.com`, `gitlab.com`, `bitbucket.org`. A page gaining a second link to the same site is then not an expansion.
- `git`: id `host/owner/repo` (`.git` stripped). `npm`: lower-cased, scope kept. `pypi`: PEP 503 name. `crates`: lower-cased.
- A templated host or path (`$VAR`, `${…}`, `{{…}}`, `%VAR%`) keeps its literal text with each expansion replaced by `*` (`https://*/install.sh`), `host: '*'`, `pin: 'unpinned'`.
- Occurrences with the same `(kind, id, pin, pinValue)` merge; role = the highest seen.

### 5.3 Pin status

| Pin | Rule |
|---|---|
| `sha256` | `pip … --hash=sha256:<64 hex>`; a `requirements` line with `--hash`; a download whose same or next non-empty line checks a 64-hex literal with `sha256sum -c`, `shasum -a 256 -c` or `Get-FileHash` |
| `commit` | the git ref is a full 40-hex commit: `git+…@<sha>`, `github:o/r#<sha>`, `raw.githubusercontent.com/o/r/<sha>/…`, `github.com/o/r/(blob\|raw\|tree)/<sha>/…`, `git checkout <sha>` on the clone's line |
| `version` | exact registry version: `pkg@1.2.3`, `pkg==1.2.3`, `--version 1.2.3`, exact `package.json` spec |
| `unpinned` | everything else: no version, ranges (`^ ~ >= *`), dist-tags, branches, **tags** (mutable), short SHAs, plain URLs. `pinValue` holds the mutable ref when there is one |

### 5.4 Remote instructions

A URL is `instructions` when its sentence (text between `.`/`!`/`?`/line break, ≤ 400 chars)
contains a verb from {follow, obey, execute, apply, perform, run, load, fetch, download, retrieve,
read, open, visit, consult, use, import, include, adhere to, comply with} **and** either a noun
from {instruction(s), step(s), direction(s), rule(s), prompt, guide, guideline(s), playbook,
workflow, procedure, checklist, skill, policy} or a URL path ending in `.md`, `.mdx`, `.txt`,
`.prompt`, `.yaml`, `.yml`, `.json`. This is fetched text the agent is told to follow: the prose
form of download-and-run.

New rule `ext.remote-instructions` (category `remote-instructions`, declarable, subject = host;
default severity high, lowered to medium per finding when pinned, the way `code.dynamic` is raised
today). `isDeclared` covers it with the same host logic as `network`. The existing `decide()` gives:

| | host not in `permissions.network` | host declared |
|---|---|---|
| unpinned | **BLOCK** | WARN — the inventory line says "content can change after approval" |
| `commit` / `sha256` pinned | WARN | INFO |

### 5.5 Hosts and `permissions.network`

- `instructions` → `ext.remote-instructions` (above).
- `fetch`/`install`/`run` references with a host (`url`, `git`, `mcp`) → a `net.access` finding with that host as subject, unless the file already has a `net.access`/`net.download-exec` hit for it. The existing tiers apply, and the host lands in `capabilities.network`.
- `reference` → no check (not an access by code); it is still inventoried and diffed.
- Registry packages have no host. They are governed by the launcher/installer findings (`exec.shell`, `deps.remote`), declared through `permissions.exec`.

### 5.6 Bounds and ReDoS safety

- At most 256 externals per package after merging. Overflow emits `code.obfuscated` with subject `externals-overflow` (BLOCK): an incomplete inventory must not be approvable.
- Candidate tokens are cut at 2,048 chars. Ids over 512 chars become `<first 256>~<16 hex of sha256(id)>`, so they stay distinct and bounded. `pinValue` ≤ 128.
- Candidates are found with `indexOf('://')` and the analyzers' existing command tokens, then widened by character-class loops. Regexes run only on bounded tokens, anchored, with no nested quantifiers and no ambiguous alternation under `*`/`+` (`URL_RE` and `hostFromAuthority` in `patterns.ts` are the model). Sentence splitting is one linear pass; verb/noun checks use `includes` on the lower-cased window.
- A test feeds 1 MiB adversarial lines (`a://a://…`, `http://` + 1 MiB of `a`, nested brackets) and requires completion within 2 s.

## 6. CLI surface

Exit codes (MVP §10) are unchanged. `ErrorCode` gains `APPROVAL_REQUIRED` → 3. New option on
`install`, `update`, `adopt`: `--approve-capabilities`. JSON keeps the `{ ok, command, data }`
envelope. Every package-, lock- or registry-derived string passes through `clean()`.

### 6.1 `agenthub diff <skill> [--to <version>]` (read-only)

Compares the installed entry with the highest compatible registry version (same resolution as
`planUpdate`) or with `--to`. The candidate is downloaded and verified in memory
(`downloadVerified`); nothing is written.

```text
web-testing 1.0.0 → 1.1.0   (capability inventory from static analysis — not a safety verdict)
  + network   x.ngrok.io                 observed, undeclared
  + external  npm:left-pad               run, unpinned
  ~ external  npm:tool 1.2.3 → ^1        pin loosened
  - exec      curl
  files  2 modified, 1 added · SKILL.md 84 → 91 lines (+7)
Expansion: 3 capabilities need approval before this update can be applied.
```

`data` (type `SkillDiff`): `{ name, scope, from: { version, digest, capabilityDigest }, to: {…},
rulesetDigest, baseline: ApprovalState | 'unavailable', delta: CapabilityDelta, unapproved:
string[], approvalRequired: boolean, files: FileChangeSummary }`.
Exit 0 whenever the diff was computed (also with expansion); 1 not installed / not in registry;
2 usage (non-registry source: use `install <dir> --dry-run`); 4 the candidate fails its digests.

### 6.2 `agenthub approve <skill> [--note <text>]`

Approves the **installed** digest's capability set under the current ruleset. Prints the inventory
and the tokens not approved before, then asks `[y/N]` (`--yes` skips the question; non-interactive
without `--yes` is `USAGE`). Writes only the lock (`WriteGuard`, `writeScopeLock`) and an `approve`
line in `audit.log`. `data`: `{ name, scope, digest, capabilityDigest, rulesetDigest, approvedAt,
approvedBy?, note?, newlyApproved: string[] }`. Exit 0; 1 not installed; 3 strict outcome is
`block` or the entry carries `quarantine`; 4 installed files drifted; 130 declined.

### 6.3 Changes to existing commands

| Command | Change |
|---|---|
| `install <source>` | Plan gains a **Capabilities** block (full inventory on a fresh install, the §6.1 delta on a replace) and `data.plan.capabilities`. Registry installs also print a **Publisher** line with the warnings of §10.4 (unverified; account < 14 days; name first published < 7 days), which make the prompt default No. Gate per §4.3 |
| `install` (restore) | carries entries verbatim; lists `unapproved` entries as a notice; skips `quarantine` entries |
| `update <skill>` | Capability-change block, then `Approve N new capabilities and update web-testing 1.0.0 → 1.1.0? [y/N]` when there is an expansion; `APPROVAL_REQUIRED` (3) for `--yes` without `--approve-capabilities` |
| `update --safe` | the rule of §4.3 replaces today's `plan.policy.outcome !== 'allow'` skip. Skip reasons name tokens: `capability expansion: +network:x.ngrok.io`, `approval missing`, `approval stale` |
| `update --check` | `checkUpdates(scope, names, { capabilities: true })` downloads each `available` candidate in memory and adds a `CHANGE` column (`none`, `narrower`, `expands (+2)`, `unapproved`) and `candidate.change = { expansion, unapproved: string[], state }`. Still writes nothing. Entries with `source: 'adopted'` report `not-in-registry` ("adopted in place") |
| `info <name>` | "What this version can do" from the registry's `capabilities`, labelled *reported by the registry; recomputed locally at install*; publisher age |
| `list` | `APPROVAL` column: `approved`, `unapproved`, `recheck` (recorded under another ruleset; `list` does not rescan). `ListedSkill` gains `approval`, `capabilityDigest?`, `origin?` |
| `verify [name]` | also rescans and prints the approval state per skill. `lock.capabilities-mismatch` joins drift as exit 4; missing or stale approvals are warnings (exit 0). `VerifyReport` gains `capabilities?: { state, stale: string[], lockMatches: boolean \| null }` |
| `doctor` | new problems: `approval.missing`, `approval.stale`, `lock.capabilities-missing` (warnings); `lock.capabilities-mismatch`, `quarantine.present` (errors); a note when the lock is still v1 |
| `rollback` | prints the capability delta of going back; no approval prompt (§4.3) |

### 6.4 `agenthub ci [--sarif <file>] [--offline] [--policy <file>]`

Read-only for the repo (the SARIF file is the only write). Project scope; `-g` for the user scope.
All steps run; results are collected, never short-circuited.

```text
agenthub ci — 4 skills, ruleset sha256:77f0…, policy .agenthub/policy.json
✘ web-testing  approval.stale     new under this ruleset: exec:nc
✘ pdf-tools    budget.network     x.ngrok.io is not in the network budget
! notes        exception.expired  budget.exec for sha256:41ab… expired 2026-09-01
2 errors, 1 warning — exit 3
```

`data`: `{ scope, policy: { path, source: 'flag' | 'repo' | 'none' }, offline, rulesetDigest,
skills: [{ name, version, digest, integrity: 'ok' | 'drift' | 'missing', approval }],
results: [{ ruleId, level: 'error' | 'warning' | 'note', kind: 'integrity' | 'policy' |
'operational', skill, message, file?, line?, capability?, exception? }],
summary: { error, warning, note }, exitCode }`.
Exit: **4** any integrity error · else **3** any policy error · else **1** any operational error
(unreadable lock or policy, registry unreachable without `--offline`) · else **0**.

### 6.5 `agenthub adopt [names…] [--dry-run]`

Scope as for other commands (`-g` for user). Report, then one confirmation `[y/N]`; `--dry-run`
stops after the report and writes nothing.

```text
Found 5 unmanaged skills in 3 folders (project scope)
  adopt   pdf-tools   .agents/skills, .claude/skills (identical)   reported by vercel-skills, unverified
  adopt   notes       .claude/skills                               origin unknown
  skip    deploy      2 copies differ (.agents/skills ≠ .claude/skills) — reconcile, then re-run
  skip    evil        BLOCK net.download-exec at scripts/x.sh:3
  skip    old-skill   .codex/skills is a legacy folder agenthub does not manage
Adopt 2 skills and approve their capability inventory? [y/N]
```

`data`: `{ scope, dryRun, candidates: [{ name, digest, copies: [{ lockPath, readers }],
aliases: [{ lockPath, target }], origin, outcome, capabilities: CapabilityReport, action }],
adopted: string[], skipped: [{ name, reason }] }`; `action` ∈ `adopt`, `extend`,
`already-managed`, `skip-blocked`, `skip-conflict`, `skip-unloadable`, `skip-legacy`, `skip-link`.
Exit 0 when the run completed and every *named* skill was adopted; 1 a named skill was not found,
conflicting or unloadable; 3 a named skill is blocked; 130 declined. With no names, skips do not
change the exit code.

### 6.6 `agenthub audit`

Read-only, no network, no writes. Project + user scopes inside a project (`-g`: user only);
`--agent` narrows. Exit 0 whenever the report was produced.

```text
claude-code   reads .claude/skills (project), ~/.claude/skills (user)
  14 skills · always-loaded ≈ 3,960 chars ≈ 990 tokens (estimate, 4 chars/token)
  shadowed   deploy   project ≠ user → user copy wins   (documented: code.claude.com/docs/en/skills)
  long       research-kit   SKILL.md body 812 lines (guidance: 500)
cursor        reads .agents/skills, .cursor/skills, .claude/skills, .codex/skills
  duplicate  pdf-tools   .agents/skills = .claude/skills (identical) — listing behavior unknown
  shadowed   deploy      .agents/skills ≠ .claude/skills → winner unknown (not documented by vendor)
Unmanaged: notes (.claude/skills), old-skill (.codex/skills, legacy)
```

`data`: `{ scopes, agents: [{ id, roots, skills: [{ name, copies: [{ scope, lockPath, digest,
managed, kind }], status: 'single' | 'duplicate' | 'shadowed', resolution: { rule, winner?,
source? } }], contextCost: { chars, tokensEstimate, counted }, flags: [{ code, skill, value,
limit }] }], unmanaged, notes }`.

## 7. Policy file `.agenthub/policy.json` (F3)

### 7.1 Schema (zod `strictObject`; unknown keys are errors)

```json
{
  "schema": 1,
  "budgets": {
    "exec": ["git", "node", "npx"], "network": ["*.example.com", "api.github.com"],
    "env": ["GITHUB_TOKEN", "CI_*"], "secrets": "never", "fsWrite": ["project", "temp"],
    "remoteInstructions": "pinned", "maxDecision": "WARN"
  },
  "exceptions": [
    { "skill": "pdf-tools", "digest": "sha256:41ab…", "capability": "network:x.ngrok.io",
      "reason": "tunnel for the demo environment", "expires": "2026-11-30" }
  ]
}
```

| Key | Meaning (absent key = no extra restriction; empty list = nothing allowed) |
|---|---|
| `exec` | allowlist for `capabilities.exec`. The token `*` passes only if the list contains `*` |
| `network` | host globs with manifest semantics (`*.d` = `d` and subdomains, `*` = all). A grant token `*.d` passes only under an equal or broader glob |
| `env` | names, or `PREFIX_*`. The token `*` needs `*` |
| `secrets` | `"never"` or a list of paths (`secretCovered`) |
| `fsWrite` | allowed scopes |
| `remoteInstructions` | `"allow"` (default: the tiers of §5.4) \| `"pinned"` (an unpinned `instructions` external is a violation even when declared) \| `"never"` |
| `maxDecision` | `"WARN"` (default) \| `"INFO"` (any WARN finding is a violation) |
| `exceptions[]` | `skill`, `digest` (exact), exactly one of `capability` (`key:value`) or `rule` (a `budget.*` id), `reason` (3–500), `expires` (ISO date, ≤ 365 days ahead) |

Budgets are checked against the **effective set from the rescan** (declared ∪ observed), not
against the lock's record.

### 7.2 Evaluation order

1. Load the policy (`--policy`, else `.agenthub/policy.json`, else none). Invalid → operational error.
2. Parse the lock (`LOCK_TOO_NEW` → operational error).
3. Per entry, frozen verify: `lock.drift`, `lock.missing` (integrity); `quarantine.present` (policy).
4. Rescan intact copies: `lock.capabilities-mismatch` (integrity).
5. Scanner policy: BLOCK findings (policy error, by scanner rule id); WARN findings (warning).
6. Approval state: `approval.missing` (also for a missing capability block), `approval.stale`.
7. Revocation, for entries with `source: 'registry'` whose `registry` equals the configured one: `listVersions(name)`; same version revoked → `revoked.version`; quarantined → `registry.quarantined`; same version, different digest → `registry.digest-mismatch` (integrity). Unreachable → `revocation.unavailable` (operational error). `--offline` skips hosted registries with a `revocation.skipped` note; `file:` registries are still read.
8. Budgets → `budget.exec|network|env|secrets|fs-write|remote-instructions|max-decision`.
9. Exceptions: one applies when `skill` and `digest` match the entry and its bytes, it has not expired, and it names the violated capability or rule. Expired → `exception.expired` warning and the violation stands. Never matched → `exception.unused` note.

### 7.3 When the policy file is attacker-controlled

It is: a pull request can change the policy in the same commit that adds a skill. Decision:

- The file can only **tighten**. Budgets add violations; they never remove a built-in failure.
- Exceptions waive only `budget.*` results. They cannot waive integrity results, scanner BLOCK findings, `approval.*`, `revoked.version`, `registry.*` or `quarantine.present`.
- So the worst an attacker achieves by editing or deleting the policy is the built-in floor. That is why approvals, BLOCK findings, drift and revocation fail `ci` with **no** policy file.
- To protect the tightening itself: `--policy <file>` loads the policy from outside the checkout under test (e.g. from the protected base branch), and the docs require CODEOWNERS on `.agenthub/`.
- Approvals in the lock are self-asserted in the same way. What `ci` guarantees is that the lock *truthfully describes the bytes* under the current ruleset, so a reviewer reading the lock diff sees the real capability change. The human gate is the review of that diff.

## 8. SARIF 2.1.0 (`packages/cli/src/ci/sarif.ts`)

| SARIF | Content |
|---|---|
| top level | `version: "2.1.0"`, `$schema: "https://json.schemastore.org/sarif-2.1.0.json"`, one `run` |
| `tool.driver` | `name: "agenthub"`, `version`, `rules[]`: one `reportingDescriptor` per scanner rule (`RULES`: `id`, `shortDescription.text` = `title`) and per ci rule of §7.2, each with `defaultConfiguration.level` |
| `results[]` | `ruleId`, `ruleIndex`, `level`, `message.text`. Scanner findings: BLOCK → `error`, WARN → `warning`; INFO findings are omitted. ci rules: integrity/policy/operational errors → `error`, warnings → `warning`, notes → `note` |
| `locations[0].physicalLocation` | scanner findings: `artifactLocation.uri` = `<first lock path>/<finding.file>` (repo-relative, `uriBaseId: "%SRCROOT%"`), `region.startLine` when `line > 0`, `region.snippet.text` = `evidence` (already escaped, ≤ 120 chars). Lock-level results: `.agenthub/agenthub.lock`, `startLine` of the skill's key |
| `partialFingerprints` | `agenthub/v1` = sha256 of `ruleId \0 skill \0 file \0 subject \0 n` (`n` = index among equal keys in file order). No line number and no digest, so an alert survives edits and updates |
| `properties` | `skill`, `version`, `digest`, `decision`, `declared`, `capability`, `exception` |

Results are sorted by `(ruleId, skill, file, line, subject)`; output is byte-stable for equal input.

**OWASP mapping.** The identifiers `AST01`–`AST10` of the *OWASP Agentic Skills Top 10, version 1.0
(2026)* were checked against the project page (`owasp.github.io/www-project-agentic-skills-top-10`)
on 2026-10-05. The mapping below is agenthub's reading of the titles, not an OWASP statement. It
lives in one data file (`ci/owasp-ast.ts`) and is emitted as `rules[].properties.tags`
(`owasp-ast:AST05`). Rules without a clear fit carry no tag.

| Tag | Rules |
|---|---|
| AST01 Malicious Skills | `net.download-exec`, `code.obfuscated`, `fs.persistence`, `prompt.hidden` |
| AST02 Supply Chain Compromise | `deps.remote`, `revoked.version`, `registry.digest-mismatch` |
| AST03 Over-Privileged Skills | `budget.*` |
| AST05 Untrusted External Instructions | `ext.remote-instructions`, `budget.remote-instructions` |
| AST07 Update Drift | `lock.drift`, `lock.capabilities-mismatch`, `approval.stale`, `approval.missing` |

## 9. Adopt and audit algorithms

### 9.1 Discovery (`packages/adapters/src/discover.ts`, shared)

```ts
export interface DiscoveredRoot { scope: Scope; dir: string; absDir: string;
  kind: 'dir' | 'link' | 'missing' | 'other'; contained: boolean;
  readers: AgentId[]; legacyFor: AgentId[]; writable: boolean; viaEnv?: string }
export interface DiscoveredSkill { scope: Scope; root: string; name: string; absDir: string;
  lockPath: string; kind: 'dir' | 'link' | 'other'; aliasOf?: string; escapes?: boolean;
  hasSkillMd: boolean; readers: AgentId[] }
export function discoverSkills(opts: { projectRoot: string | null; home: string;
  env: Record<string, string | undefined>; scopes: Scope[] }): Promise<{ roots: DiscoveredRoot[]; skills: DiscoveredSkill[] }>;
```

- **Root set** per scope = every folder in `AGENT_PATHS[agent][scope]` ∪ `AGENT_PATHS[agent].legacy?.[scope]`. Today: project `.agents/skills`, `.claude/skills`, `.cursor/skills`, `.github/skills`, `.codex/skills`; user the `~/` forms with `.copilot/skills` instead of `.github/skills`. `writable` = member of `WRITE_CANDIDATES[scope]`. `.codex/skills` (read by Cursor, legacy for Codex) is **read-only**.
- `$CLAUDE_CONFIG_DIR/skills` and `$CODEX_HOME/skills` are added as `viaEnv` roots: reported, never adoptable (the lock cannot name them: `resolveLockPath` only accepts table folders).
- Only the scope root's folders are scanned. Nested `.claude/skills` / `.agents/skills` in subfolders (which Claude Code and Codex also load) are **not** walked; both commands say so.
- A skill is a direct child of a root. Every root and child is `lstat`ed (junctions report as links); `core` exports `pathKind` and `resolvesWithin` for this.

**Links are never followed out of scope.** A root that is a link is listed only if it
`resolvesWithin` the scope root; otherwise it is reported as `link-escapes-scope` and not listed.
A child link is resolved with `realpath`: if the target is a skill folder inside a discovered root
of the same scope, it is recorded as `aliasOf` (same copy, hashed once, counted for the agents that
read the link's root); any other target is reported with `escapes` and **never read**. Links
inside a skill folder make it `unloadable` (`readTreeFiles` rejects them) and are not followed.

### 9.2 Adopt

1. Discover the command's scope. A copy is **managed** when the scope lock has `skills[name]` and `paths` contains its `lockPath`; everything else is unmanaged.
2. Load each unmanaged real folder with `loadSkillInPlace(absDir)` = `readTreeFiles` + `buildSkillPackage({ folderName })`: **every** regular file on disk is included (`.git`, `node_modules` too), so hidden payloads are scanned and `verify` passes right after adoption. Limits, path safety and `name == folder` apply; failures are `skip-unloadable` with the validation code.
3. Group by name. All copies identical (same content digest) → one candidate whose `paths` are its copies in writable roots. Differing digests → `skip-conflict`, nothing adopted for that name. Name already in the lock: same digest → `extend` (`paths` gains the copy); different → `skip-conflict`. Copies only in legacy roots → `skip-legacy`. Link aliases are listed, not adopted.
4. `engine.assess(pkg)`: strict outcome `block` → `skip-blocked`. `--dev` does not apply to adopt.
5. Attach the origin (§9.3), print the report with each inventory, confirm (§4.3).
6. `engine.recordInPlace(scope, items, { approve })` re-hashes every folder (`hashInstalledDir`) against the reported hashes and aborts the whole run on any difference (TOCTOU), then writes.

**Written:** the scope lock (and `.agenthub/.gitignore` through `ensureStateGitignore`), one
`adopt` line per skill in `audit.log`, and best-effort `~/.agenthub/cache/sha256/<digest>.skillpkg`
(a baseline for later drift). **Never touched:** any file under any skills folder, links,
`skills-lock.json`, SKILL.md frontmatter, other tools' state, agent configuration.

The entry is as in §3.1: `version` from `agenthub.yaml` or `0.0.0-local+<digest8>`, `paths` and
`installedTargets` from the adopted copies and their readers, `approval` only when confirmed.
Adopted entries are never update candidates (`planUpdate` refuses them with `USAGE`); `remove`,
`verify` and `rollback` work as for any entry. `restore` of an adopted entry whose folder is
missing fails with "adopted in place; restore it with the tool that installed it".

### 9.3 Foreign provenance (best effort, never verified)

| Tool | Read | `origin.reported` |
|---|---|---|
| `vercel-skills` | `<project root>/skills-lock.json`, only when `version === 1` and `skills[name]` is an object (shape checked against `vercel-labs/skills` `src/local-lock.ts`, 2026-10-05) | string fields `source`, `sourceType`, `ref`, `sourceUrl`, `skillPath`, `computedHash` |
| `gh-skill` | SKILL.md frontmatter `metadata` keys `github-repo`, `github-ref`, `github-tree-sha`, `github-path`, `github-pinned` (checked against `cli/cli` `internal/skills/frontmatter`, 2026-10-05) | those keys |
| otherwise | — | `tool: 'unknown'`, `reported: {}` |

Files ≤ 1 MiB, `JSON.parse` in a `try`, own string properties only, values truncated to 512 chars.
Another lock version or shape → `unknown` plus a note. `computedHash` is **recorded, not
recomputed**: its sort order and raw-byte hashing are not specified tightly enough to compare
without false "edited" reports. Every surface prints `reported by <tool>, unverified`; no field is
named or rendered as verified. Each parser has a golden fixture.

### 9.4 Audit

Per agent `A`: visible copies = discovered skills (real or alias) in the roots `A` reads at each scope.

- **Status** by name: one copy → `single`; several, same digest → `duplicate`; differing → `shadowed`. Unloadable copies are parsed leniently (`parseSkillMd`) so they still count.
- **Resolution** comes from `cli/src/audit/precedence.ts` (rule, source URL and date per agent):

| Agent | Same name in several places | Source |
|---|---|---|
| claude-code | personal (user) wins over project | documented, code.claude.com/docs/en/skills |
| codex | not merged; both can appear | documented, learn.chatgpt.com/docs/build-skills |
| cursor | **unknown** | vendor does not document precedence |
| vscode | **unknown** | vendor does not document precedence |

- **Context cost** = Σ over counted copies of `len(name) + len(description)`; tokens ≈ chars / 4, always labelled *estimate*. Copies a documented rule excludes are not counted; under `unknown`, every copy is counted and the line says so. Reference points are printed, not enforced: Codex caps the list at 2% of the context window or 8,000 chars; Claude Code truncates a listing entry at 1,536 chars.
- **Flags:** `description.long` (> `MAX_DESCRIPTION_LENGTH` = 1,024), `body.long` (> `MAX_BODY_LINES` = 500), `name.mismatch` (frontmatter ≠ folder), `link.escapes`.
- **Unmanaged** list, with legacy and `viaEnv` roots marked.

## 10. Registry, API and web (F6, F7)

### 10.1 Database (`schema.ts` and `MIGRATION_SQL` in `migrate.ts`, kept in sync)

```sql
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS ruleset_digest text;
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS capability_digest text;
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS capabilities_json jsonb;  -- CapabilityReport
ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS skill_md_lines integer;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS name_status text NOT NULL DEFAULT 'clear'; -- clear | held
ALTER TABLE skills ADD COLUMN IF NOT EXISTS name_skeleton text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS skills_name_skeleton_idx ON skills (name_skeleton);
CREATE TABLE IF NOT EXISTS name_tombstones (
  slug text PRIMARY KEY, publisher_id uuid NOT NULL REFERENCES publishers(id),
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
```

Capabilities belong to the scan row because they depend on the ruleset; `rescan` inserts a new
row. `scripts/backfill-capabilities.ts` rescans stored versions that have none.

### 10.2 Publish pipeline (`Registry.publish`)

After `readSkillArchive` and the version checks, before `store.put`:

1. Tombstone: `slug` in `name_tombstones` under another publisher → `CONFLICT` ("this name is retired"). Same publisher → hold.
2. For a slug with no `skills` row, run §10.3 → hold or clear. A skill with `name_status = 'held'` holds every new version.
3. `scanPackage` (now with externals and `rulesetDigest`) → `evaluatePolicy` → `deriveCapabilities`, stored on the `security_scans` row; `skill_md_lines` on the version.
4. `status = 'quarantined'` when the scan blocks **or** the name is held; `statusReason` joins the causes (`Blocked by scanner: …; name-review: resembles "web-testing"`).

New names are checked inside the publish transaction (on Postgres under `pg_advisory_xact_lock`),
so two lookalikes cannot both pass by racing. `revoke()` gains: when no version of the skill is
left non-revoked, insert the tombstone in the same transaction. Tombstones are never deleted
through the API. Nothing deletes `skills` rows today either; the table makes the rule survive any
future delete or rename.

### 10.3 Name protection (`apps/web/src/lib/names.ts`, pure)

Slugs are ASCII (`SLUG_RE`), so "homoglyphs" are ASCII lookalikes.

```text
plain(slug)   = tokens minus DECORATION (kept if nothing else remains), joined
                → 'rn'→'m', 'vv'→'w' → fold 0→o, 1→l, i→l, 5→s
sorted(slug)  = the same, with tokens sorted first (catches reordering)
DECORATION    = official verified real original secure safe skill skills agent the new latest pro
```

A **new** slug by publisher `P` is held when any of:

| Rule | Condition | `statusReason` |
|---|---|---|
| H1 reserved | `plain` equals `plain` of a `RESERVED_EXACT` name (`agenthub`, `official`, `verified`, `admin`, `security`, `support`, `system`, `registry`, `skill`, `skills`, `api`, `default`, `latest`, …) | `name-review: reserved name` |
| H2 vendor | first token ∈ `VENDORS` (`anthropic`, `claude`, `openai`, `codex`, `chatgpt`, `cursor`, `github`, `copilot`, `vscode`, `microsoft`, `google`, `gemini`, `vercel`) and `P` is not verified | `name-review: vendor name` |
| H3 lookalike | a slug `S` of **another** publisher has `sorted(S) = sorted(slug)`, or the OSA (Damerau–Levenshtein) distance between the `plain` forms is ≤ 0 for length ≤ 4, ≤ 1 for 5–9, ≤ 2 for ≥ 10 (length = the longer one) | `name-review: resembles "S"` |
| H4 tombstone | own retired name republished | `name-review: retired name` |

Same-publisher lookalikes are exempt. Candidates are pre-filtered by length (±2) before the
distance. Lookalikes are **held, not rejected**: a hard reject would let a squatter deny a
legitimate name. Both lists live in `reserved-names.ts`.

**Admin review needs no new UI.** A hold is a `quarantined` version, so it appears in the existing
queue (`listByStatus('quarantined')`, `QueueItem.statusReason`). `setStatus(…, 'active', …)` also
sets `skills.name_status = 'clear'` in the same transaction, so later versions are not held.
Rejecting = `revoke`, which tombstones the name once every version is revoked. Held versions are
already refused by `resolve`/`download` (`FORBIDDEN`), and the CLI's `resolveVersion` reports them
as "no stable version matches … (1.0.0 quarantined)" (exit 1).

### 10.4 API (additive; `api.ts` in core and `api-types.ts` in web stay structurally identical)

```ts
export interface VersionCapabilities { set: CapabilitySet; digest: string; rulesetDigest: string;
  undeclared: string[]; unobserved: string[] }
// SkillInfoVersion += capabilities?: VersionCapabilities; skillMdLines?: number
// SkillInfo        += createdAt?: string; nameStatus?: 'clear' | 'held'
// PublisherRef / SkillInfo.publisher / SearchResult.publisher += createdAt?: string
export interface VersionDiff { slug: string; from: { version: string; digest: string };
  to: { version: string; digest: string }; comparable: boolean;
  delta: CapabilityDelta | null; files: FileChangeSummary }
```

- `GET /api/v1/skills/:slug` and `/versions` return the new optional fields from the latest scan row.
- `GET /api/v1/skills/:slug/diff?from=<v>&to=<v>` → `VersionDiff` from **stored** data (`capabilities_json`, `files_json`, `skill_md_lines`). No artifact is read and nothing is rescanned on a GET. `comparable` is false when the two rows have different `ruleset_digest` (`delta` is still returned and the page says so). Rate group `read`; `versionSchema` on both parameters.
- The client treats all of it as display-only. `HttpRegistry.info` validates the new fields' types; gating uses only locally computed reports (D12). `plan()` reads publisher data through `registry.info?.()`, best effort, into `InstallPlan.registryTrust`; a failure prints "publisher information unavailable" and never blocks.

### 10.5 Namespaces: a recorded one-way door

Flat names stay. Moving to `@publisher/skill` later changes lock keys, folder names, routes and
tombstone keys, so it needs lock v3 and a redirect table. What keeps that migration deterministic
is built now: a name never changes owner (`skills.publisherId`), retired names are tombstoned, and
lookalikes are held, so every flat slug maps to exactly one `@publisher/slug`.

### 10.6 Web (uses the redesign's `src/components/ui` primitives)

- `CapabilityInventory` (server component) on `app/skills/[slug]/page.tsx`, section **"What this version can do"**: one row per non-empty key, externals with kind, pin and role, `undeclared` tokens marked, markers shown as blocked behavior. Caption: *"Capability inventory from static analysis of this version. It lists what the files were seen to do and what the publisher declared. It is not a safety verdict."* No capabilities stored → "Not yet analyzed".
- `CapabilityDiff` + `VersionDiffPicker` (a GET form with two selects, `?from=&to=`, no client JavaScript) under the versions table: `+`/`−`/`~` rows from `VersionDiff`, the file summary and the `comparable: false` note. Chips in the versions list (`+network: x.ngrok.io`) come from the diff against the previous version.

## 11. Engine integration and ownership

### 11.1 Hook points in `packages/core/src/engine/engine.ts`

| Symbol | Change |
|---|---|
| `evaluatePolicy(pkg, dev)` → `assess(pkg, dev)` | also returns `report = deriveCapabilities(strict.findings, pkg.manifest, scan.externals, scan.rulesetDigest)`; exposed read-only as `Engine.assess(pkg)` |
| `buildPlan()` | after the *Policy* block: `baselineFor(scope, name, previous)` (intact installed copy → cache → unavailable; **never** the registry), `approvalState`, both deltas, `summarizeFileChanges` → `plan.capabilities`. `needsConfirmation \|\|= approvalRequired`. Blocker `CONFLICT` for `quarantine`, and for `signer` when the digest changes |
| `plan()` | registry source: best-effort `registry.info?.()` → `plan.registryTrust` |
| `apply(plan, opts?)` | after the policy re-check: recompute the report and the baseline from the lock read here; expansion without `opts.approve` → `APPROVAL_REQUIRED`. `newEntry`: same digest → `{ ...previous }` with only `installedTargets`/`paths` updated; otherwise capability block + approval per §4.3; reserved fields carried. `entryKey()` is unchanged, so a restore still writes nothing when nothing changed. Audit events gain `capabilityDigest` and the approval mode |
| `transact()`, `recover()`, `writeSnapshot()` | unchanged; they carry v2 entries through `Journal.newEntry` and `entry.json` |
| `planUpdate()` / `checkUpdates()` | refuse / report `source: 'adopted'`; `checkUpdates` option `{ capabilities }` fills `UpdateCandidate.change` |
| `restore()` | skips `quarantine` entries; otherwise as today (same-digest carry) |
| `rollback()` | passes the parsed snapshot entry to `buildPlan` (`PlanInternals.carry`); `apply` writes it verbatim |
| `verifyEntry()` / `list()` / `doctor()` | add the approval state through `inspect` (rescan in `verify`/`doctor`, record-only in `list`) |
| new methods | `inspect`, `approve`, `diff`, `recordInPlace`; `AuditAction` gains `approve` and `adopt` |

### 11.2 `api.ts` (additive)

```ts
export type ApprovalState = 'approved' | 'approved-carried' | 'unapproved' | 'stale' | 'not-approvable';
export interface ApprovalInput { by?: string; note?: string }
export interface PlanCapabilities { rulesetDigest: string; candidate: CapabilityReport;
  state: ApprovalState | 'fresh' | 'unavailable'; delta: CapabilityDelta | null;
  unapproved: CapabilityDelta; approvalRequired: boolean; approvable: boolean; files: FileChangeSummary }
export interface RegistryTrust { publisher?: { name: string; verified: boolean; createdAt?: string };
  skillCreatedAt?: string; warnings: string[] }
export interface InstalledInspection { name: string; scope: Scope; entry: LockEntry; verify: VerifyReport;
  current: CapabilityReport | null; policy: PolicyResult | null;
  approval: { state: ApprovalState; stale: string[] }; lockMatches: boolean | null }
export interface InPlaceItem { name: string; pkg: SkillPackage; lockPaths: Record<string, AgentId[]>;
  origin: LockOrigin }
// InstallPlan  += capabilities: PlanCapabilities; registryTrust?: RegistryTrust
// Engine       += assess(pkg): { policy: PolicyResult; report: CapabilityReport }
//                 inspect(scope, name?): Promise<InstalledInspection[]>
//                 approve(name, scope, input: ApprovalInput): Promise<LockApproval>
//                 diff(name, scope, opts?: { to?: string }): Promise<SkillDiff>
//                 recordInPlace(scope, items: InPlaceItem[], opts: { approve?: ApprovalInput }): Promise<string[]>
//                 apply(plan, opts?: { approve?: ApprovalInput })
//                 checkUpdates(scope, names?, opts?: { capabilities?: boolean })
```

New core exports: `capabilities.ts` (`deriveCapabilities`, `canonicalCapabilities`,
`capabilityDigest`, `diffCapabilities`, `intersectCapabilities`, `summarizeFileChanges`,
`capabilityTokens`, the four normalizers), `engine/approval.ts` (`approvalState`,
`approvedBaseline`), `loadSkillInPlace`, `pathKind`, `resolvesWithin`. New scanner exports:
`extractExternals`, `EXTRACTOR_VERSION`, `RULESET_DIGEST`. New adapters export: `discoverSkills`.

### 11.3 File ownership

**Wave A — one team, the foundation (F1 + F2 and every shared seam).** Wave B starts when it merges.

| Package | Files |
|---|---|
| core | `types.ts`, `errors.ts`, `capabilities.ts` (new), `index.ts`, `engine/api.ts`, `engine/engine.ts`, `engine/lock.ts`, `engine/approval.ts` (new), `engine/index.ts`, tests |
| scanner | `externals.ts`, `ruleset.ts` (new), `scan.ts`, `rules.ts`, `policy.ts`, `context.ts`, `index.ts`, `lang/*` (only `addExternal` calls), tests |
| adapters | `discover.ts` (new), one export line in `index.ts`, test |
| cli | `program.ts`, `prompt.ts`, `format.ts`, `capability-format.ts` (new), `http-registry.ts`, `commands/{install,update,plan-flow,info,list,verify,doctor,rollback}.ts`, `commands/{diff,approve}.ts` (new), tests |
| test-fixtures | new fixtures (`externals`, `remote-instructions`, version pairs) and their expectations |

Wave A also registers `ci`, `adopt` and `audit` in `program.ts` (flags exactly as in §6, names in
`COMMANDS`), pointing at stub modules `commands/{ci,adopt,audit}.ts` that throw "not implemented".
Because of that, **no Wave B team edits a shared file.**

**Wave B — five teams in parallel.**

| Team | Owns (exclusively) | Consumes (read-only) |
|---|---|---|
| ci (F3) | `cli/src/commands/ci.ts`, `cli/src/ci/**` (`policy-file.ts`, `budget.ts`, `exceptions.ts`, `sarif.ts`, `owasp-ast.ts`), `cli/test/ci/**`, `docs/ci.md` | `engine.inspect`, `readLock`, `wiring.registry.listVersions`, core capability helpers |
| adopt (F4) | `cli/src/commands/adopt.ts`, `cli/src/adopt/**` (`provenance.ts`, `group.ts`, `report.ts`), `cli/test/adopt/**` | `discoverSkills`, `loadSkillInPlace`, `engine.assess`, `engine.recordInPlace`, `capability-format.ts` |
| audit (F5) | `cli/src/commands/audit.ts`, `cli/src/audit/**` (`view.ts`, `precedence.ts`, `cost.ts`), `cli/test/audit/**` | `discoverSkills`, `readLock`, `parseSkillMd` |
| registry (F6 + F7 server) | `apps/web/src/db/{schema,migrate}.ts`, `src/lib/{registry,api-types,validation}.ts`, `src/lib/{names,reserved-names}.ts` (new), `app/api/v1/skills/[slug]/diff/route.ts` (new), `scripts/backfill-capabilities.ts`, `apps/web/test/**` | `@agenthub/core` capability helpers, `@agenthub/scanner` |
| web (F7 UI) | `apps/web/app/skills/[slug]/page.tsx`, `src/components/{CapabilityInventory,CapabilityDiff,VersionDiffPicker}.tsx` (new), `e2e/**` | the types of §10.4, `Registry.getSkill`, `Registry.diffVersions(slug, from, to)` |

Seams between B teams: (1) team registry lands the §10.4 type additions and the `diffVersions`
signature as its first commit; team web never edits `api-types.ts` or `registry.ts` and develops
against those types with fixture data. (2) B teams keep fixtures in their own test folders, not in
`packages/test-fixtures`. (3) Admin pages are untouched (§10.3).

## 12. Test plan

Unit and engine tests run on real temp directories (MVP §12). The research plan's acceptance
tests were checked against the code; corrections are marked.

| ID | Test | Pins |
|---|---|---|
| A1 | v1 lock fixture parses; a read-only command leaves the file byte-identical; `agenthub approve x` writes `lockfileVersion: 2` with `x`'s capability block and the other entries block-less | migration never invents approvals or rewrites on read |
| A2 | `lockfileVersion: 3` → `VALIDATION`, `details.code = LOCK_TOO_NEW`, exit 1, file untouched; unknown key in a v2 entry → `VALIDATION` (not stripped); `signer`/`quarantine` round-trip byte-identically | no silent downgrade of newer state |
| A3 | Each field of §3.2 with one malformed value (control characters, oversize arrays, bad host, `__proto__` key in `reported`, traversal in `paths`) → `VALIDATION`; an edited token without a matching `capabilityDigest` → `LOCK_INCONSISTENT` | the lock is untrusted input |
| A4 | `deriveCapabilities`, table-driven: one row per rule of §1.2, the declared mapping, both mismatch lists; reordering findings or changing `line`/`file` gives the same digest | determinism; only subject and category feed the set |
| A5 | `diffCapabilities` properties: `diff(x, x)` is empty; a removal is never an expansion; adding `*` to a host list, a new host under `*`, pinned → unpinned, a changed pin value, a new unpinned external and a role escalation are each an expansion; unpinned → pinned is not | the definition of expansion |
| A6 | `web-testing` 1.0.0 (declares `network: [api.example.invalid]`) → 1.1.0 with an undeclared fetch to `x.ngrok.invalid`: `update --check --json` shows `change.expansion: true` and `unapproved: ['network:x.ngrok.invalid']`; every byte of the lock and the skill folders is unchanged | the check is read-only; the delta comes from verified bytes |
| A7 | `update --safe` with a typo-fix candidate and the A6 candidate: the first is applied (approval carried, `note` set), the second skipped with `+network:x.ngrok.invalid` in the reason; exit 0. *(Correction: a declared WARN-level skill with no expansion is now applied.)* | unattended updates cannot expand |
| A8 | `update web-testing --yes` on A6 → exit 3 `APPROVAL_REQUIRED`, nothing written; with `--approve-capabilities` → applied, `approval.digest` = new digest, one `update` audit line with mode `flag`; `engine.apply(plan)` called directly without `approve` also throws | `--yes` never approves; the gate is in the engine |
| A9 | Interactive update with expansion: an empty answer declines (default No), exit 130, nothing changed | default-deny |
| A10 | Ruleset change (fake `SecurityPort` with another `rulesetDigest`): no new tokens → `verify` prints `approved (carried forward)`, lock untouched; a new `exec:nc` → `stale`, `ci` exit 3, `approve` fixes it. With a matching ruleset, a lock edited to add `network:*` (digest fixed up) → `lock.capabilities-mismatch`, exit 4 | D12, D16; a forged record is detected |
| A11 | Approval removed from the lock, then A7's typo-fix update with `--safe` → skipped, `approval missing` | D15 |
| A12 | Fresh install `--yes` writes an approval; restore on a clean clone writes nothing and keeps the approval; restore with the folder missing and a registry serving other bytes for that version → `INTEGRITY`, exit 4 | restore needs matching bytes and writes no approval |
| A13 | `--dev` install of `download-exec`: installed, **no** approval; `approve` exits 3; a `--dev` update with expansion and only `--yes` → exit 3 | `--dev` never approves |
| A14 | Rollback to a snapshot with more capabilities than the current version: succeeds without an approval prompt and restores the snapshot's approval; a v1-era snapshot restores as `unapproved` | the rollback rule |
| A15 | Entry with `quarantine`: `install`/`update` blocked, `restore` skips it, `ci` exit 3; entry with `signer`: restore ok, update blocked | reserved fields fail closed |
| A16 | LF and CRLF checkouts of one repo produce identical capability blocks and approvals | no line-ending dependence |
| A17 | Prose-only change (a new sentence, no URL, no flagged phrase): `expansion: false`, applied by `--safe`, output shows `SKILL.md +1 lines`. *(Correction: there is no `prose-review` class.)* | the limit of §13 is pinned, not hidden |
| B1 | Externals fixture: `npx some-cli@latest` → npm/unpinned/run; `pip install foo` → pypi/unpinned; `pip install foo==1.2 --hash=sha256:…` → sha256; a raw GitHub URL at a 40-hex commit → commit, at `main` → unpinned; an MCP URL → mcp/run; stored sorted, no line numbers | extraction and pin rules |
| B2 | "Follow the instructions at <url>": undeclared host → BLOCK; host in `permissions.network` → WARN; commit-pinned → WARN / INFO; "see the docs at <url>" → `reference`, no finding. *(Correction: there is no `permissions.remoteInstructions` key.)* | remote-instruction tiers |
| B3 | An update adding `git:github.com/evil/helper`, or loosening `npm:tool@1.2.3` to `^1` → expansion, and `--safe` skips with the ref in the reason; a second link to an already referenced origin → no expansion | externals are gated without same-origin noise |
| B4 | 300 distinct externals → `code.obfuscated` (`externals-overflow`), BLOCK; adversarial 1 MiB lines finish < 2 s; `scanPackage` under a throwing `fetch` stub makes zero calls | bounded, linear, offline |
| C1 | Clean repo: `ci --sarif out.sarif` exit 0, valid SARIF structure (required properties; schema validation when the 2.1.0 schema is vendored in the test folder), zero error results | baseline |
| C2 | One vendored byte edited → exit 4, result `lock.drift` with the repo-relative path; a missing folder → `lock.missing` | frozen verify |
| C3 | `exec:curl` under `budgets.exec: ['git']` → exit 3 `budget.exec`; a matching exception → 0; the same exception after the digest changes → 3; expired → 3 plus `exception.expired`; `expires` two years ahead → invalid policy, exit 1 | digest-bound, expiring exceptions |
| C4 | A policy with an exception for `approval.missing` or for a scanner BLOCK is rejected; deleting the policy file never turns a failing built-in check green; `--policy` overrides the repo file | D17 |
| C5 | Revoked installed version (`revocations.json` and a stub hosted registry) → exit 3 `revoked.version`; unreachable registry → exit 1; with `--offline` → exit 0 and a `revocation.skipped` note | revocation; explicit offline |
| C6 | Two runs produce byte-identical SARIF; fingerprints stay equal when a finding moves by 10 lines; no INFO results | stable alerts |
| D1 | Vercel layout: real folder in `.agents/skills`, link (junction on win32) in `.claude/skills`, `skills-lock.json` v1 → a candidate with `origin.tool = 'vercel-skills'`, the alias listed; a hash of the whole tree is identical before and after `adopt`. *(Correction: never `verified`.)* | adopt changes no byte |
| D2 | A link in `.claude/skills` pointing at a fake `~/.ssh`: reported `escapes`; an fs spy records no open under the target; not adopted | links are never followed out of scope |
| D3 | A skill folder with `.git/hooks/post-checkout` running `curl … \| sh` → `skip-blocked`, the finding path inside `.git` | hidden payloads are scanned |
| D4 | Same name, different digests in two folders → `skip-conflict`, exit 1 when named; identical copies → one entry with both `paths` | no silent choice between copies |
| D5 | After adopt: `verify` exit 0; a byte changed by another tool → exit 4; `update --safe` never touches the entry; `adopt --yes` leaves entries `unapproved`, `--yes --approve-capabilities` approves | adopted entries are pinned; `--yes` does not approve |
| D6 | Folder changed between report and commit → the run aborts, lock unchanged; `skills-lock.json` with `version: 3` or malformed JSON → `origin.tool = 'unknown'`, no crash | TOCTOU; tolerant parsers |
| E1 | Identical copy in `.agents/skills` and `.claude/skills`: `duplicate` for cursor and vscode, `single` for claude-code and codex | the per-agent view follows `AGENT_PATHS` |
| E2 | Differing copies at project and user scope: claude-code → the user copy wins, with the source URL; codex → both listed; cursor/vscode → `unknown` | no invented precedence |
| E3 | 60 skills with 300-char descriptions: chars and `tokensEstimate = ceil(chars / 4)`; a 1,100-char description → `description.long`; a 600-line body → `body.long` | cost arithmetic |
| E4 | fs-write and fetch spies record zero calls for a full `audit` run | read-only, offline |
| F1 | `web-testing` by A, then `web-tesitng`, `testing-web`, `web-testing-official` by B → each `quarantined` with `name-review`; the same names by A → active; `agenthub install web-tesitng` exits 1 naming `quarantined`. *(Correction: exit 1 from `resolveVersion`, not 3.)* | lookalike hold |
| F2 | Admin `setStatus(active)` clears the hold and the next version publishes active; `revoke` of every version inserts a tombstone; B publishing that slug → 409; A republishing → held | tombstones; review flow |
| F3 | Reserved exact name → held; `claude-helper` by an unverified publisher → held, by a verified one → active; 4-char names differing by one letter → not held | thresholds |
| F4 | `GET /skills/:slug` carries `publisher.createdAt` and `createdAt`; the CLI plan warns for an unverified or 3-day-old publisher and still installs with `--yes`; a failing `info` call does not block | warnings never gate |
| G1 | Publish stores `capabilities_json`, the digests and `skill_md_lines`; info returns them; `rescan` adds a row with new digests | computed at publish |
| G2 | `/diff?from=1.0.0&to=1.1.0` returns the A6 delta; different rulesets → `comparable: false`; an invalid version → 400; no artifact read (store spy) | a cheap diff from stored data |
| G3 | The skill page renders "What this version can do" and the diff; rendered HTML and JSON contain no "safe" claim (string test over the components) | the wording rule |

Every feature has at least one failure-path test above (handoff §4.9).

## 13. Honest limits and wording

**What a capability diff cannot catch**

- **Prose-only changes.** A new sentence that tells the agent to behave differently, without a new URL, command or flagged phrase, leaves the set unchanged, and `--safe` will apply it. The diff shows the SKILL.md line delta so a person can look.
- **The static-analysis ceiling.** The scanner is pattern-based. Obfuscation it does not recognize, code assembled at runtime and languages it has no analyzer for are not seen. `exec` names launchers only; file writes outside persistence locations are not detected at all (`fsWrite` is declared-only).
- **Unpinned references.** An approved unpinned external or remote instruction can change after approval. Nothing here re-fetches it; the watchdog is not built.
- **Remote-instruction detection is heuristic.** Phrasing outside the verb/noun lists is recorded as a `reference`, not blocked.
- **Approvals are self-asserted.** `approvedBy` is text. The evidence is the reviewed commit that changes `.agenthub/agenthub.lock`; use CODEOWNERS.
- **Ruleset changes** can make an old approval stale. That is new information about the same bytes, not a change in the skill.
- **Foreign provenance** is whatever another tool wrote down. agenthub repeats it and checks none of it.
- **Name protection** covers ASCII skill names. Publisher display names are not checked, and a lookalike that an admin approves is a normal name from then on.
- **Audit numbers** are estimates. Agents change their loading rules, nested skills folders are not walked, and two of four vendors do not document precedence.

**Wording the product uses**

| Say | Never say |
|---|---|
| "capability inventory", "what this version can do", "capability changes" | "safe", "secure", "trusted", "clean", "verified safe", "no risk" |
| "no expansion found by static analysis" | "safe to update" |
| "approved by <who> on <date>" (a recorded human decision) | "approved" as a quality claim |
| "reported by <tool>, unverified" | "verified source", "provenance verified" |
| "estimate (4 chars per token)" | exact token counts |
| "no findings (the scanner reports what it finds; it does not certify safety)" — the existing line in `formatPlan` | "passed", "certified" |

Every surface that shows an inventory or a diff (plan, `diff`, `info`, the `ci` summary, the skill
page) carries the line: *"Capability inventory from static analysis — not a safety verdict."*

## Appendix A — Wave A implementation decisions (2026-10-05)

Wave A built F1 (capability lock, diff-gated updates) and F2 (outbound-reference lock: extraction,
`ext.remote-instructions`, externals in the lock and in diffs). Wave B (F3–F7) is on hold, so the
shared seams of §11.3 (`discoverSkills`, `Engine.inspect/assess/recordInPlace`,
`loadSkillInPlace`, the `ci`/`adopt`/`audit` stubs) were **not** built. Where the draft above
conflicted with the code or left room, the safer, simpler, deterministic option was chosen:

| # | Draft | Built | Why |
|---|---|---|---|
| A1 | Analyzers call `scan.addExternal()` (§5) | One separate pass, `scanner/src/externals.ts`, called from `scanFile` with the already-decoded, LF-normalized text | Keeps the hardened analyzers untouched; the pass is linear (indexOf + char loops, regexes only on bounded tokens) and timed by tests |
| A2 | fetch/install/run externals add `net.access` findings (§5.5) | Their hosts enter `capabilities.network` in `deriveCapabilities`; no new findings | The gate still sees every new host; existing policy outcomes and fixture expectations do not shift |
| A3 | Per-key token grammars in the lock (§3.2) | One rule for all keys: 1–256 printable characters, no whitespace or control/format characters (fsWrite stays an enum); `capToken()` sanitizes every scanner subject the same way | A package can never produce a token the lock parser then rejects (which would make the repo's lock unreadable) |
| A4 | v1 parsed with a lenient schema | v1 is parsed strictly with v1 fields only; v2 fields inside a v1 file are a `VALIDATION` error | Nothing is stripped or invented during migration |
| A5 | — | Any `__proto__`/`constructor`/`prototype` key anywhere in a lock, snapshot `entry.json` or journal entry is a `VALIDATION` error | zod drops such keys silently; refusing is stricter than stripping |
| A6 | `quarantine` entries are skipped by restore (§3.2) | A quarantined entry is a `CONFLICT` blocker for install, update, **restore** and rollback; `approve` refuses it (exit 3) | Fail closed, one rule everywhere |
| A7 | `ScanResult.rulesetDigest/externals` required | Optional; the engine falls back to `sha256({capabilitySchema, scanner: scannerVersion})`; `SecurityPort.rulesetDigest` is optional too | Test fakes and older producers keep working; the real CLI port supplies `RULESET_DIGEST` |
| A8 | `approvedBy` from `git config user.email` | `AGENTHUB_APPROVED_BY` only (cleaned, ≤ 128 chars); no subprocess | Self-asserted either way; avoids running git from the CLI |
| A9 | `Engine.inspect` / `assess` / `recordInPlace` | Not exported. `verify` and `doctor` rescan privately; `Engine.approve(name, scope, input, { dryRun })` returns the preview the `approve` command prints | Wave B cancelled; smaller API |
| A10 | `origin` field and `source: 'adopted'` in lock v2 | Not added (adopt is not built). Reserved `signer` / `quarantine` are added and round-trip | A field without a writer is untested surface; adding it later needs a schema change anyway |
| A11 | `update --check` CHANGE values | `none`, `narrower`, `expands (+N)` (an approval exists), `unapproved` (no usable approval), `—` (not checked) | As drafted, plus `—` |
| A12 | rollback prints the capability delta | rollback prints its usual result; the delta is computed in the plan (`plan.capabilities.delta`) but `rollback` does not print a plan | Unchanged rollback UX; rollback is never gated |
| A13 | `diff` exit 2 for a non-registry source | `USAGE` (exit 2), as drafted; `--to` must be an exact version | — |
| A14 | Lock caps of 256 tokens per key | 1024 tokens per key, 256 externals; the scanner itself emits `code.obfuscated` (`externals-overflow`, BLOCK) above 256 distinct externals or 4096 candidates in one file | Generous for real skills, bounded for hostile ones; an incomplete inventory is never approvable |
| A15 | `prose.ts`-style line windows for remote instructions | A sentence is read across soft-wrapped lines of one paragraph (blank lines, headings and list items start a new block); inline code spans are also read as commands (`npx tool`, `curl … \| sh`) | Wrapped Markdown is the common case |
| A16 | `remote-instructions` pinned → medium | As drafted: commit or sha256 pin lowers severity to medium (WARN undeclared, INFO declared) | — |

Known limits found while building (not fixed in Wave A): the pre-existing shell analyzer takes
several seconds on a 1 MiB line of nested brackets (the externals extractor itself takes ~30 ms on
the same input); the ReDoS tests time the extractor directly.

Lock v2 entry as written by this release (abridged):

```json
"web-testing": {
  "approval": { "approvedAt": "2026-10-05T15:28:43.015Z", "capabilityDigest": "sha256:1b04…",
                "digest": "sha256:27c9…", "rulesetDigest": "sha256:0f1d…" },
  "capabilities": { "binaries": [], "dynamic": [], "env": ["PLAYWRIGHT_BROWSERS_PATH"],
                    "exec": ["node", "npx"], "fsWrite": [], "installers": [], "markers": [],
                    "network": ["*"], "prompt": [], "secrets": [] },
  "capabilityDigest": "sha256:1b04…", "digest": "sha256:27c9…",
  "externals": [
    { "id": "playwright", "kind": "npm", "pin": "unpinned", "pinValue": null, "role": "run" },
    { "host": "playwright.dev", "id": "https://playwright.dev", "kind": "url",
      "pin": "unpinned", "pinValue": null, "role": "reference" } ],
  "files": { "SKILL.md": "sha256:…", "agenthub.yaml": "sha256:…", "scripts/run.sh": "sha256:…" },
  "installedAt": "…", "installedTargets": ["claude-code", "codex"], "paths": { … },
  "registry": "file:…", "rulesetDigest": "sha256:0f1d…", "source": "registry", "version": "1.0.0"
}
```
