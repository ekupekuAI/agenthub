/**
 * Capability model (trust features design §1–§2). Pure and deterministic: no I/O, no clock, no
 * platform-dependent ordering. The same findings, manifest and externals give the same set and
 * the same capabilityDigest on every OS and in every run.
 *
 * A capability set is an inventory from static analysis plus the publisher's declarations. It
 * says what the files were seen to do and what they claim; it is not a safety verdict.
 */
import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';
import {
  CAPABILITY_KEYS,
  type CapabilityDelta,
  type CapabilityKey,
  type CapabilityReport,
  type CapabilitySet,
  type CapabilityTokens,
  type EvaluatedFinding,
  type ExternalChange,
  type ExternalRef,
  type ExternalRole,
  type FileChangeSummary,
  type Finding,
  type SkillManifest,
} from './types';

/** Version of the canonical form; part of every capabilityDigest. */
export const CAPABILITY_SCHEMA = 1;

/** Longest token kept verbatim; longer ones keep a prefix and a hash suffix (still distinct). */
export const MAX_TOKEN_LENGTH = 256;

const ROLE_RANK: Record<ExternalRole, number> = {
  reference: 0,
  fetch: 1,
  install: 2,
  run: 3,
  instructions: 3,
};

/** Keys whose tokens a manifest can declare (and so can be undeclared). */
const DECLARABLE_KEYS: ReadonlySet<CapabilityKey> = new Set([
  'exec',
  'network',
  'env',
  'secrets',
  'installers',
]);

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** JavaScript string order (UTF-16 code units): identical on every platform and locale. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Makes any scanner subject a valid lock token: control, format and line-separator characters
 * are removed, whitespace runs become '_', and values longer than `max` keep a prefix plus 16
 * hex characters of their SHA-256. A package can therefore never produce a token the lock
 * parser rejects.
 */
export function capToken(value: string, max = MAX_TOKEN_LENGTH): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += ' ';
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      continue;
    }
    if (code >= 0xad && /^\p{Cf}$/u.test(char)) continue;
    out += char;
  }
  out = out.trim().replace(/\s+/g, '_');
  if (out === '') return '*';
  if (out.length <= max) return out;
  return `${out.slice(0, max - 17)}~${sha256Hex(out).slice(0, 16)}`;
}

/** True when `token` is acceptable in a lock: 1–256 chars, no whitespace or control chars. */
export function isValidToken(token: string, max = MAX_TOKEN_LENGTH): boolean {
  return token.length > 0 && token.length <= max && capToken(token, max) === token;
}

// ---------------------------------------------------------------------------
// Hosts and secret paths (shared with the scanner's policy)
// ---------------------------------------------------------------------------

/**
 * Host or host suffix from a declared entry ('*.example.com', 'https://example.com:443/x'):
 * lower case, no scheme, path, port, leading '*.' or trailing dot; non-ASCII names punycoded.
 */
export function normalizeHost(entry: string): string {
  const host = entry
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/\.$/, '');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: any non-ASCII character
  if (!/[^\x00-\x7f]/.test(host)) return host;
  const ascii = domainToASCII(host);
  return ascii === '' ? host : ascii;
}

/** Is `host` the declared entry or one of its subdomains? */
export function hostCovered(host: string, entry: string): boolean {
  const h = normalizeHost(host);
  const e = normalizeHost(entry);
  return e !== '' && (h === e || h.endsWith(`.${e}`));
}

/** Normalizes a credential path: forward slashes, no home prefix, no `./`, no trailing `/`. */
export function normalizeSecretPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)\//i, '')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

/** Is the secret `subject` the declared path or inside it? */
export function secretCovered(subject: string, entry: string): boolean {
  const s = normalizeSecretPath(subject);
  const e = normalizeSecretPath(entry);
  return e !== '' && (s === e || s.startsWith(`${e}/`));
}

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

export function emptyTokens(): CapabilityTokens {
  const out = {} as CapabilityTokens;
  for (const key of CAPABILITY_KEYS) out[key] = [];
  return out;
}

export function emptyCapabilitySet(): CapabilitySet {
  return { ...emptyTokens(), externals: [] };
}

/** Order of externals: kind, id, pin, pinValue, role. */
export function compareExternals(a: ExternalRef, b: ExternalRef): number {
  return (
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.id, b.id) ||
    compareStrings(a.pin, b.pin) ||
    compareStrings(a.pinValue ?? '', b.pinValue ?? '') ||
    compareStrings(a.role, b.role)
  );
}

function cleanExternal(ref: ExternalRef): ExternalRef {
  const out: ExternalRef = {
    kind: ref.kind,
    id: ref.id,
    pin: ref.pin,
    pinValue: ref.pinValue ?? null,
    role: ref.role,
  };
  if (ref.host !== undefined) out.host = ref.host;
  return out;
}

/**
 * Merges references with the same (kind, id, pin, pinValue) — the highest role wins (ties:
 * 'instructions' over 'run') — and sorts them.
 */
export function normalizeExternals(refs: readonly ExternalRef[]): ExternalRef[] {
  const merged = new Map<string, ExternalRef>();
  for (const raw of refs) {
    const ref = cleanExternal(raw);
    const key = JSON.stringify([ref.kind, ref.id, ref.pin, ref.pinValue]);
    const seen = merged.get(key);
    if (seen === undefined) {
      merged.set(key, ref);
      continue;
    }
    const rank = ROLE_RANK[ref.role] - ROLE_RANK[seen.role];
    if (rank > 0 || (rank === 0 && ref.role === 'instructions')) seen.role = ref.role;
    if (seen.host === undefined && ref.host !== undefined) seen.host = ref.host;
  }
  return [...merged.values()].sort(compareExternals);
}

/** Sorted, unique tokens per key and merged externals. Missing keys become empty lists. */
export function normalizeCapabilitySet(
  set: Partial<CapabilityTokens> & { externals?: readonly ExternalRef[] },
): CapabilitySet {
  const out = emptyCapabilitySet();
  for (const key of CAPABILITY_KEYS) out[key] = uniqueSorted(set[key] ?? []);
  out.externals = normalizeExternals(set.externals ?? []);
  return out;
}

/** The ten token lists of a set, without externals (the lock's `capabilities` object). */
export function tokensOf(set: CapabilityTokens): CapabilityTokens {
  const out = emptyTokens();
  for (const key of CAPABILITY_KEYS) out[key] = uniqueSorted(set[key] ?? []);
  return out;
}

function sortedObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedObject);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareStrings(a, b));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortedObject(v)]));
  }
  return value;
}

/** Canonical JSON of a set: sorted keys, sorted unique arrays, no whitespace, schema 1. */
export function canonicalCapabilities(
  set: CapabilityTokens & { externals?: readonly ExternalRef[] },
): string {
  const normalized = normalizeCapabilitySet(set);
  return JSON.stringify(sortedObject({ schema: CAPABILITY_SCHEMA, ...normalized }));
}

/** 'sha256:<hex>' of the canonical set. */
export function capabilityDigest(
  set: CapabilityTokens & { externals?: readonly ExternalRef[] },
): string {
  return `sha256:${sha256Hex(canonicalCapabilities(set))}`;
}

// ---------------------------------------------------------------------------
// Derivation (design §1.2–§1.4)
// ---------------------------------------------------------------------------

function hostToken(subject: string | undefined): string {
  if (subject === undefined || subject.trim() === '*') return '*';
  const host = normalizeHost(subject);
  return host === '' ? '*' : capToken(host);
}

function lower(subject: string | undefined): string {
  return subject === undefined ? '*' : capToken(subject.toLowerCase());
}

/** The capability tokens one finding contributes. Only category, subject and declarable count. */
export function findingTokens(finding: Finding): [CapabilityKey, string][] {
  const subject = finding.subject;
  switch (finding.category) {
    case 'exec':
      return [['exec', lower(subject)]];
    case 'network':
    case 'remote-instructions':
      return [['network', hostToken(subject)]];
    case 'download-exec':
      return [
        ['markers', 'download-exec'],
        ['network', hostToken(subject)],
      ];
    case 'secrets': {
      const path = subject === undefined ? '' : normalizeSecretPath(subject);
      return [['secrets', path === '' ? '*' : capToken(path)]];
    }
    case 'env':
      return [['env', subject === undefined ? '*' : capToken(subject)]];
    case 'dynamic':
      return finding.declarable
        ? [['dynamic', lower(subject)]]
        : [
            ['dynamic', lower(subject)],
            ['markers', 'dynamic-untrusted'],
          ];
    case 'obfuscation':
      return [['markers', capToken(`obfuscation:${lower(subject)}`)]];
    case 'persistence':
      return [['markers', capToken(`persistence:${subject ?? '*'}`)]];
    case 'hidden':
      return [['markers', capToken(`hidden:${subject ?? '*'}`)]];
    case 'deps':
      return [['installers', lower(subject)]];
    case 'prompt':
      return [['prompt', lower(subject)]];
    case 'binary':
      return [['binaries', lower(subject)]];
    default:
      return [['markers', capToken(`unknown:${String(finding.category)}`)]];
  }
}

/** Tokens the manifest declares (design §1.3). */
export function declaredTokens(manifest: SkillManifest | null): CapabilityTokens {
  const out = emptyTokens();
  const perms = manifest?.permissions;
  if (perms === undefined) return out;
  if (perms.network === true) out.network.push('*');
  else if (Array.isArray(perms.network)) {
    for (const entry of perms.network) {
      if (entry.trim() === '*') {
        out.network.push('*');
        continue;
      }
      const host = normalizeHost(entry);
      if (host !== '') out.network.push(capToken(`*.${host}`));
    }
  }
  for (const name of perms.exec ?? []) out.exec.push(lower(name));
  for (const name of perms.env ?? []) out.env.push(capToken(name));
  for (const path of perms.secrets ?? []) {
    const normalized = normalizeSecretPath(path);
    if (normalized !== '') out.secrets.push(capToken(normalized));
  }
  for (const scope of perms.fs?.write ?? []) out.fsWrite.push(scope);
  for (const key of CAPABILITY_KEYS) out[key] = uniqueSorted(out[key]);
  return out;
}

/** Hosts that externals fetch, install from or run against (they count as network access). */
function externalHosts(externals: readonly ExternalRef[]): string[] {
  const hosts: string[] = [];
  for (const ref of externals) {
    if (ref.role === 'reference' || ref.host === undefined) continue;
    hosts.push(hostToken(ref.host));
  }
  return hosts;
}

function declaredCovers(key: CapabilityKey, declared: string, observed: string): boolean {
  if (declared === '*') return true;
  switch (key) {
    case 'network':
      return declared.startsWith('*.')
        ? hostCovered(observed, declared.slice(2))
        : declared === observed;
    case 'secrets':
      return secretCovered(observed, declared);
    default:
      return declared === observed;
  }
}

/**
 * The capability report of a package: the union of observed and declared tokens per key, plus
 * its externals. `findings` must be the strict evaluation (dev: false), so --dev cannot alter
 * the set. The undeclared/unobserved lists are shown to people and are not part of the digest.
 */
export function deriveCapabilities(
  findings: readonly EvaluatedFinding[],
  manifest: SkillManifest | null,
  externals: readonly ExternalRef[],
  rulesetDigest: string,
): CapabilityReport {
  const observed = emptyTokens();
  const undeclared: string[] = [];
  for (const finding of findings) {
    for (const [key, token] of findingTokens(finding)) {
      observed[key].push(token);
      if (!finding.declared && finding.declarable && DECLARABLE_KEYS.has(key)) {
        undeclared.push(`${key}:${token}`);
      }
    }
  }
  const merged = normalizeExternals(externals);
  observed.network.push(...externalHosts(merged));
  const declared = declaredTokens(manifest);

  const unobserved: string[] = [];
  for (const key of ['exec', 'network', 'env', 'secrets'] as const) {
    const seen = key === 'exec' ? [...observed.exec, ...observed.installers] : observed[key];
    for (const token of declared[key]) {
      if (!seen.some((value) => declaredCovers(key, token, value))) {
        unobserved.push(`${key}:${token}`);
      }
    }
  }

  const set = emptyCapabilitySet();
  for (const key of CAPABILITY_KEYS) set[key] = uniqueSorted([...observed[key], ...declared[key]]);
  set.externals = merged;
  return {
    set,
    digest: capabilityDigest(set),
    rulesetDigest,
    undeclared: uniqueSorted(undeclared),
    unobserved: uniqueSorted(unobserved),
  };
}

// ---------------------------------------------------------------------------
// Delta (design §2)
// ---------------------------------------------------------------------------

function sameVariant(a: ExternalRef, b: ExternalRef): boolean {
  return a.pin === b.pin && (a.pinValue ?? null) === (b.pinValue ?? null);
}

/** Is `ref` within what `base` allows (same id, same or looser pin, same or higher role)? */
export function externalCovered(base: readonly ExternalRef[], ref: ExternalRef): boolean {
  return base.some(
    (b) =>
      b.kind === ref.kind &&
      b.id === ref.id &&
      ROLE_RANK[b.role] >= ROLE_RANK[ref.role] &&
      (sameVariant(b, ref) || (ref.pin !== 'unpinned' && b.pin === 'unpinned')),
  );
}

export function pinLabel(ref: ExternalRef): string {
  if (ref.pin === 'unpinned') return ref.pinValue ? `${ref.pinValue} (unpinned)` : 'unpinned';
  return `${ref.pin} ${ref.pinValue ?? ''}`.trim();
}

/** Display name of an external, e.g. 'npm:playwright' or 'url:https://example.com/x.md'. */
export function externalLabel(ref: ExternalRef): string {
  return `${ref.kind}:${ref.id}`;
}

function idKey(ref: ExternalRef): string {
  return `${ref.kind}\u0000${ref.id}`;
}

/**
 * What `candidate` adds to and removes from `installed` (null = nothing installed: everything is
 * added). Pure, total and order-independent. `expansion` is true when any token is added, a new
 * external id appears, or an existing external is loosened, changed or used in a stronger role.
 * Removals and tightened pins are never an expansion.
 */
export function diffCapabilities(
  installed: CapabilitySet | null,
  candidate: CapabilitySet,
): CapabilityDelta {
  const before = normalizeCapabilitySet(installed ?? emptyCapabilitySet());
  const after = normalizeCapabilitySet(candidate);
  const added = emptyTokens();
  const removed = emptyTokens();
  const reasons: string[] = [];
  for (const key of CAPABILITY_KEYS) {
    const a = new Set(before[key]);
    const b = new Set(after[key]);
    added[key] = after[key].filter((token) => !a.has(token));
    removed[key] = before[key].filter((token) => !b.has(token));
    for (const token of added[key]) reasons.push(`+${key}:${token}`);
  }

  const beforeById = new Map<string, ExternalRef[]>();
  for (const ref of before.externals) {
    beforeById.set(idKey(ref), [...(beforeById.get(idKey(ref)) ?? []), ref]);
  }
  const afterIds = new Set(after.externals.map(idKey));
  const externals: CapabilityDelta['externals'] = {
    added: [],
    removed: before.externals.filter((ref) => !afterIds.has(idKey(ref))),
    changed: [],
    tightened: [],
  };
  for (const ref of after.externals) {
    const base = beforeById.get(idKey(ref));
    if (base === undefined) {
      externals.added.push(ref);
      reasons.push(`+external:${externalLabel(ref)} (${ref.role}, ${pinLabel(ref)})`);
      continue;
    }
    if (externalCovered(base, ref)) {
      if (!base.some((b) => sameVariant(b, ref))) {
        const from = base.find((b) => b.pin === 'unpinned') as ExternalRef;
        externals.tightened.push({ from, to: ref });
      }
      continue;
    }
    const same = base.find((b) => sameVariant(b, ref));
    let change: ExternalChange;
    if (same !== undefined) change = { change: 'role-escalated', from: same, to: ref };
    else if (ref.pin === 'unpinned' && base.some((b) => b.pin !== 'unpinned')) {
      change = {
        change: 'pin-loosened',
        from: base.find((b) => b.pin !== 'unpinned') as ExternalRef,
        to: ref,
      };
    } else change = { change: 'pin-changed', from: base[0] as ExternalRef, to: ref };
    externals.changed.push(change);
    const detail =
      change.change === 'role-escalated'
        ? `${change.from.role} → ${ref.role}`
        : `${pinLabel(change.from)} → ${pinLabel(ref)}`;
    reasons.push(`~external:${externalLabel(ref)} ${detail} (${change.change.replace('-', ' ')})`);
  }
  const expansion =
    CAPABILITY_KEYS.some((key) => added[key].length > 0) ||
    externals.added.length > 0 ||
    externals.changed.length > 0;
  return { added, removed, externals, expansion, reasons: uniqueSorted(reasons) };
}

/**
 * Tokens of `current` that `recorded` also has; externals of `current` that `recorded` covers.
 * Used for the approved baseline after a ruleset change (a token counts only if it was approved
 * and is really in the bytes).
 */
export function intersectCapabilities(
  current: CapabilitySet,
  recorded: CapabilitySet,
): CapabilitySet {
  const a = normalizeCapabilitySet(current);
  const b = normalizeCapabilitySet(recorded);
  const out = emptyCapabilitySet();
  for (const key of CAPABILITY_KEYS) {
    const keep = new Set(b[key]);
    out[key] = a[key].filter((token) => keep.has(token));
  }
  out.externals = a.externals.filter((ref) => externalCovered(b.externals, ref));
  return out;
}

/** Is everything in `inner` within `outer`? */
export function capabilitiesCovered(inner: CapabilitySet, outer: CapabilitySet): boolean {
  return !diffCapabilities(outer, inner).expansion;
}

/** Flat 'key:token' and 'external:kind:id' list, sorted. */
export function capabilityTokens(set: CapabilitySet): string[] {
  const out: string[] = [];
  for (const key of CAPABILITY_KEYS) for (const token of set[key]) out.push(`${key}:${token}`);
  for (const ref of set.externals) out.push(`external:${externalLabel(ref)}`);
  return uniqueSorted(out);
}

/** What a delta adds, as 'key:token' / 'external:kind:id' strings (no '+' prefix). */
export function expansionTokens(delta: CapabilityDelta): string[] {
  const out: string[] = [];
  for (const key of CAPABILITY_KEYS)
    for (const token of delta.added[key]) out.push(`${key}:${token}`);
  for (const ref of delta.externals.added) out.push(`external:${externalLabel(ref)}`);
  for (const change of delta.externals.changed) {
    out.push(`external:${externalLabel(change.to)} (${change.change})`);
  }
  return uniqueSorted(out);
}

/** True when the set holds nothing at all. */
export function isEmptyCapabilitySet(set: CapabilitySet): boolean {
  return CAPABILITY_KEYS.every((key) => set[key].length === 0) && set.externals.length === 0;
}

// ---------------------------------------------------------------------------
// File summary (display only)
// ---------------------------------------------------------------------------

function lineCount(text: string): number {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (normalized === '') return 0;
  const lines = normalized.split('\n');
  return normalized.endsWith('\n') ? lines.length - 1 : lines.length;
}

/** Files added, removed and modified between two versions, and the SKILL.md line delta. */
export function summarizeFileChanges(
  prev: { files: Record<string, string>; skillMd: string | null } | null,
  next: { files: Record<string, string>; skillMd: string },
): FileChangeSummary {
  const before = prev?.files ?? {};
  const after = next.files;
  const added: string[] = [];
  const modified: string[] = [];
  let unchanged = 0;
  for (const path of Object.keys(after).sort(compareStrings)) {
    if (!Object.hasOwn(before, path)) added.push(path);
    else if (before[path] !== after[path]) modified.push(path);
    else unchanged++;
  }
  const removed = Object.keys(before)
    .filter((path) => !Object.hasOwn(after, path))
    .sort(compareStrings);
  const afterLines = lineCount(next.skillMd);
  const beforeLines = prev?.skillMd == null ? null : lineCount(prev.skillMd);
  return {
    added,
    removed,
    modified,
    unchanged,
    skillMd: {
      before: beforeLines,
      after: afterLines,
      delta: beforeLines === null ? null : afterLines - beforeLines,
    },
  };
}
