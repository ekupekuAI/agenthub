/**
 * agenthub.lock (design §6): zod-validated read, deterministic atomic write.
 */
import { z } from 'zod';
import { AgentHubError } from '../errors';
import { contentDigest } from '../hash';
import { checkPackagePath } from '../paths';
import { SKILL_NAME_PATTERN } from '../skillmd';
import { AGENT_IDS, type LockEntry, type LockFile } from '../types';
import { readTextOrNull, type WriteGuard, writeFileAtomic } from './fsutil';

const HASH = /^sha256:[0-9a-f]{64}$/;

const agentIdSchema = z.enum(AGENT_IDS);

export const lockEntrySchema = z.object({
  version: z.string().min(1),
  digest: z.string().regex(HASH, 'digest must be sha256:<64 hex>'),
  source: z.enum(['file', 'dir', 'registry']),
  registry: z.string().nullable(),
  installedTargets: z.array(agentIdSchema),
  paths: z.record(z.string().min(1), z.array(agentIdSchema)),
  files: z
    .record(z.string(), z.string().regex(HASH, 'file hash must be sha256:<64 hex>'))
    .superRefine((files, ctx) => {
      for (const file of Object.keys(files)) {
        const problem = checkPackagePath(file);
        if (problem !== null) ctx.addIssue({ code: 'custom', message: problem, path: [file] });
      }
    }),
  installedAt: z.string(),
});

const lockSchema = z.object({
  lockfileVersion: z.literal(1),
  skills: z.record(
    z.string().regex(SKILL_NAME_PATTERN, 'skill names must be lowercase a-z, 0-9 and hyphens'),
    lockEntrySchema,
  ),
});

export function emptyLock(): LockFile {
  return { lockfileVersion: 1, skills: {} };
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

/** Parse lock text; throws AgentHubError('VALIDATION') naming `file`. */
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
  const parsed = lockSchema.safeParse(raw);
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
  const lock = parsed.data as LockFile;
  for (const [name, entry] of Object.entries(lock.skills)) assertConsistent(name, entry, file);
  return lock;
}

/** Read a lock file. Missing → empty lock. Invalid → AgentHubError('VALIDATION'). */
export async function readLock(file: string): Promise<LockFile> {
  const text = await readTextOrNull(file);
  if (text === null) return emptyLock();
  return parseLock(text, file);
}

/** Validate one lock entry (snapshot entry.json). */
export function parseLockEntry(raw: unknown, file: string, name = 'the skill'): LockEntry {
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
  return entry;
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

/** Keys sorted recursively, 2-space JSON, trailing newline. */
export function serializeLock(lock: LockFile): string {
  return `${JSON.stringify(sortKeysDeep(lock), null, 2)}\n`;
}

export async function writeLock(guard: WriteGuard, file: string, lock: LockFile): Promise<void> {
  await writeFileAtomic(guard, file, serializeLock(lock));
}
