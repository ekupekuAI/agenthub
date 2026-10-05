/**
 * agenthub.lock (design §6, trust features §3): zod-validated read, deterministic atomic write.
 *
 * The lock is committed to git, so in a cloned repository it is attacker-controlled input. Every
 * field is validated strictly (unknown keys are errors, never stripped), every capability block
 * must hash to its recorded capabilityDigest, and a lock written by a newer agenthub is refused
 * without being rewritten.
 *
 * Versions: lockfileVersion 1 (MVP) is read and upgraded to 2 on the next write; entries it did
 * not touch stay without a capability block. Migration never invents an approval.
 */
import { z } from 'zod';
import { capabilityDigest, isValidToken, normalizeExternals, tokensOf } from '../capabilities';
import { AgentHubError } from '../errors';
import { contentDigest } from '../hash';
import { DEFAULT_LIMITS } from '../limits';
import { checkPackagePath } from '../paths';
import { MAX_NAME_LENGTH, SKILL_NAME_PATTERN } from '../skillmd';
import {
  AGENT_IDS,
  type CAPABILITY_KEYS,
  type CapabilityTokens,
  EXTERNAL_KINDS,
  EXTERNAL_PINS,
  EXTERNAL_ROLES,
  type LockEntry,
  type LockFile,
} from '../types';
import { readTextOrNull, type WriteGuard, writeFileAtomic } from './fsutil';

/** The version this release writes. */
export const LOCKFILE_VERSION = 2;

/** Most tokens per capability key, and most externals, a lock entry may hold. */
export const MAX_LOCK_TOKENS = 1024;
export const MAX_LOCK_EXTERNALS = 256;

const HASH = /^sha256:[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,255}$/;
const RESERVED_KEY = /^[a-z][A-Za-z0-9-]{0,31}$/;

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
    if (code >= 0xad && /^\p{Cf}$/u.test(char)) return true;
  }
  return false;
}

/** A single-line string without control or format characters. */
const printable = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !hasControl(value), 'must be printable text on one line');

const hash = (what: string) => z.string().regex(HASH, `${what} must be sha256:<64 hex>`);
const timestamp = z.string().regex(TIMESTAMP, 'must be an ISO 8601 UTC timestamp');
const agentIdSchema = z.enum(AGENT_IDS);
const agentList = z
  .array(agentIdSchema)
  .max(AGENT_IDS.length)
  .refine((ids) => new Set(ids).size === ids.length, 'agents must be unique');

const reservedMap = z
  .record(
    z.string().regex(RESERVED_KEY, 'keys must match ^[a-z][A-Za-z0-9-]{0,31}$'),
    printable(512),
  )
  .refine((map) => Object.keys(map).length <= 16, 'at most 16 keys');

const token = (max = 256) =>
  z
    .string()
    .refine(
      (value) => isValidToken(value, max),
      `tokens are 1–${max} printable characters without spaces`,
    );

const tokenList = z.array(token()).max(MAX_LOCK_TOKENS);

const capabilitiesSchema = z.strictObject({
  binaries: tokenList,
  dynamic: tokenList,
  env: tokenList,
  exec: tokenList,
  fsWrite: z.array(z.enum(['project', 'home', 'temp'])).max(3),
  installers: tokenList,
  markers: tokenList,
  network: tokenList,
  prompt: tokenList,
  secrets: tokenList,
} satisfies Record<(typeof CAPABILITY_KEYS)[number], z.ZodType>);

const externalSchema = z.strictObject({
  kind: z.enum(EXTERNAL_KINDS),
  id: token(512),
  host: token(255).optional(),
  pin: z.enum(EXTERNAL_PINS),
  pinValue: token(128).nullable(),
  role: z.enum(EXTERNAL_ROLES),
});

const approvalSchema = z.strictObject({
  digest: hash('approval.digest'),
  capabilityDigest: hash('approval.capabilityDigest'),
  rulesetDigest: hash('approval.rulesetDigest'),
  approvedAt: timestamp,
  approvedBy: printable(128).optional(),
  note: printable(500).optional(),
});

const filesSchema = z.record(z.string(), hash('file hash')).superRefine((files, ctx) => {
  const keys = Object.keys(files);
  if (keys.length > DEFAULT_LIMITS.maxFiles) {
    ctx.addIssue({ code: 'custom', message: `at most ${DEFAULT_LIMITS.maxFiles} files` });
  }
  for (const file of keys) {
    const problem = checkPackagePath(file);
    if (problem !== null) ctx.addIssue({ code: 'custom', message: problem, path: [file] });
  }
});

const pathsSchema = z
  .record(printable(512), agentList)
  .refine((paths) => Object.keys(paths).length <= 8, 'at most 8 install paths');

/** Fields of a v1 (MVP) entry. */
const v1EntryShape = {
  version: z.string().regex(VERSION, 'version must be 1–256 characters of [0-9A-Za-z.+-]'),
  digest: hash('digest'),
  source: z.enum(['file', 'dir', 'registry']),
  registry: printable(2048).nullable(),
  installedTargets: agentList,
  paths: pathsSchema,
  files: filesSchema,
  installedAt: timestamp,
};

const v1EntrySchema = z.strictObject(v1EntryShape);

export const lockEntrySchema = z.strictObject({
  ...v1EntryShape,
  capabilities: capabilitiesSchema.optional(),
  capabilityDigest: hash('capabilityDigest').optional(),
  rulesetDigest: hash('rulesetDigest').optional(),
  externals: z.array(externalSchema).max(MAX_LOCK_EXTERNALS).optional(),
  approval: approvalSchema.optional(),
  signer: reservedMap.optional(),
  quarantine: reservedMap.optional(),
});

const skillName = z
  .string()
  .max(MAX_NAME_LENGTH)
  .regex(SKILL_NAME_PATTERN, 'skill names must be lowercase a-z, 0-9 and hyphens');

const lockV1Schema = z.strictObject({
  lockfileVersion: z.literal(1),
  skills: z.record(skillName, v1EntrySchema),
});

const lockV2Schema = z.strictObject({
  lockfileVersion: z.literal(2),
  skills: z.record(skillName, lockEntrySchema),
});

export function emptyLock(): LockFile {
  return { lockfileVersion: LOCKFILE_VERSION, skills: {} };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * A lock is untrusted input (it is committed to git): its `digest` must be the content digest of
 * its own `files` map, otherwise a forged entry could pair a trusted digest with other files.
 */
function assertConsistent(name: string, entry: LockEntry, file: string): void {
  let actual: string;
  try {
    actual = contentDigest(entry.files);
  } catch {
    actual = '(invalid)';
  }
  if (actual !== entry.digest) {
    throw new AgentHubError(
      'VALIDATION',
      `invalid lock entry for ${name} in ${file}: its files hash to ${actual}, not the recorded digest ${entry.digest}`,
      { path: file, skill: name, expected: entry.digest, actual },
    );
  }
}

/**
 * The capability block is all present or all absent, and its recorded capabilityDigest must be
 * the digest of its own tokens and externals (catches hand edits and bad merges). Arrays are
 * normalized (sorted, unique) in memory.
 */
function checkCapabilityBlock(name: string, entry: LockEntry, file: string): LockEntry {
  const parts = [entry.capabilities, entry.capabilityDigest, entry.rulesetDigest, entry.externals];
  const present = parts.filter((part) => part !== undefined).length;
  const inconsistent = (message: string, extra: Record<string, unknown> = {}): never => {
    throw new AgentHubError('VALIDATION', `invalid lock entry for ${name} in ${file}: ${message}`, {
      code: 'LOCK_INCONSISTENT',
      path: file,
      skill: name,
      ...extra,
    });
  };
  if (present === 0) {
    if (entry.approval !== undefined) {
      inconsistent('an approval needs the capability block it approves; run "agenthub approve"');
    }
    return entry;
  }
  if (present !== parts.length) {
    inconsistent(
      'capabilities, capabilityDigest, rulesetDigest and externals must be present together',
    );
  }
  const capabilities = tokensOf(entry.capabilities as CapabilityTokens);
  const externals = normalizeExternals(entry.externals ?? []);
  const actual = capabilityDigest({ ...capabilities, externals });
  if (actual !== entry.capabilityDigest) {
    inconsistent(
      `its capabilities hash to ${actual}, not the recorded capabilityDigest ${entry.capabilityDigest} — take one side of the merge, then run "agenthub approve ${name}"`,
      { expected: entry.capabilityDigest, actual },
    );
  }
  return { ...entry, capabilities, externals };
}

function versionError(file: string, version: unknown): AgentHubError {
  if (typeof version === 'number' && Number.isInteger(version) && version > LOCKFILE_VERSION) {
    return new AgentHubError(
      'VALIDATION',
      `lock file ${file} was written by a newer agenthub (lockfileVersion ${version}); upgrade agenthub`,
      { code: 'LOCK_TOO_NEW', path: file, lockfileVersion: version },
    );
  }
  return new AgentHubError(
    'VALIDATION',
    `invalid lock file ${file}: lockfileVersion must be 1 or ${LOCKFILE_VERSION}`,
    { path: file },
  );
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** First prototype-polluting key anywhere in parsed JSON (zod would drop it silently). */
function forbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 32 || value === null || typeof value !== 'object') return null;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) return key;
    const found = forbiddenKey((value as Record<string, unknown>)[key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function assertNoForbiddenKeys(raw: unknown, file: string): void {
  const key = forbiddenKey(raw);
  if (key !== null) {
    throw new AgentHubError('VALIDATION', `invalid lock data in ${file}: forbidden key "${key}"`, {
      path: file,
    });
  }
}

/** The lockfileVersion recorded in lock text, or null when it cannot be read. */
export function peekLockVersion(text: string): number | null {
  try {
    const raw = JSON.parse(text) as unknown;
    if (raw === null || typeof raw !== 'object') return null;
    const version = (raw as Record<string, unknown>).lockfileVersion;
    return typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}

/**
 * Parse lock text; throws AgentHubError('VALIDATION') naming `file`. A v1 lock is returned in
 * the v2 in-memory shape (entries without a capability block); a newer version is refused with
 * `details.code = 'LOCK_TOO_NEW'`.
 */
export function parseLock(text: string, file: string): LockFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AgentHubError(
      'VALIDATION',
      `invalid lock file ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { path: file },
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentHubError('VALIDATION', `invalid lock file ${file}: expected a JSON object`, {
      path: file,
    });
  }
  assertNoForbiddenKeys(raw, file);
  const version = (raw as Record<string, unknown>).lockfileVersion;
  if (version !== 1 && version !== LOCKFILE_VERSION) throw versionError(file, version);
  const parsed = (version === 1 ? lockV1Schema : lockV2Schema).safeParse(raw);
  if (!parsed.success) {
    throw new AgentHubError(
      'VALIDATION',
      `invalid lock file ${file}: ${describeIssues(parsed.error)}`,
      {
        path: file,
        issues: parsed.error.issues,
      },
    );
  }
  const skills: Record<string, LockEntry> = {};
  for (const [name, value] of Object.entries(parsed.data.skills)) {
    const entry = value as LockEntry;
    assertConsistent(name, entry, file);
    skills[name] = checkCapabilityBlock(name, entry, file);
  }
  return { lockfileVersion: LOCKFILE_VERSION, skills };
}

/** Read a lock file. Missing → empty lock. Invalid → AgentHubError('VALIDATION'). */
export async function readLock(file: string): Promise<LockFile> {
  const text = await readTextOrNull(file);
  if (text === null) return emptyLock();
  return parseLock(text, file);
}

/** Validate one lock entry (snapshot entry.json, journal newEntry): the v2 entry schema. */
export function parseLockEntry(raw: unknown, file: string, name = 'the skill'): LockEntry {
  assertNoForbiddenKeys(raw, file);
  const parsed = lockEntrySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentHubError(
      'VALIDATION',
      `invalid lock entry in ${file}: ${describeIssues(parsed.error)}`,
      {
        path: file,
      },
    );
  }
  const entry = parsed.data as LockEntry;
  assertConsistent(name, entry, file);
  return checkCapabilityBlock(name, entry, file);
}

/** Recursively sort object keys (arrays keep their order). */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}

/** Keys sorted recursively, 2-space JSON, trailing newline. Always writes the current version. */
export function serializeLock(lock: LockFile): string {
  const current = { ...lock, lockfileVersion: LOCKFILE_VERSION };
  return `${JSON.stringify(sortKeysDeep(current), null, 2)}\n`;
}

export async function writeLock(guard: WriteGuard, file: string, lock: LockFile): Promise<void> {
  await writeFileAtomic(guard, file, serializeLock(lock));
}
