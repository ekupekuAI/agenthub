/**
 * Transaction journals (design §8.4): `<agenthubHome>/journal/<txid>.json`, rewritten before and
 * after every swap so an interrupted install can be finished or undone by `recover()`.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import type { LockEntry, Scope } from '../types';
import { listDir, readTextOrNull, removeFile, type WriteGuard, writeFileAtomic } from './fsutil';
import { lockEntrySchema } from './lock';

export interface JournalStep {
  /** Installed skill folder being replaced or created. */
  absDir: string;
  /** Where the previous folder (or link) is parked while the transaction runs. */
  backup?: string;
  /** Staged copy that is renamed into place. */
  staged?: string;
  /** True once the staged copy is at absDir. */
  swapped: boolean;
}

export interface Journal {
  txid: string;
  scope: Scope;
  scopeRoot: string;
  name: string;
  stagingRoot: string;
  /** Every staging folder of the transaction (stagingRoot plus same-volume fallbacks). */
  stagingDirs: string[];
  /** Directories created for new targets, deepest first; removed again on undo when empty. */
  createdDirs: string[];
  steps: JournalStep[];
  committed: boolean;
  /** Lock file of the scope, its text before the transaction (null = absent) and the new entry. */
  lockFile: string;
  previousLockText: string | null;
  newEntry: LockEntry | null;
  startedAt: string;
  /** Process that runs the transaction; recover() leaves journals of live processes alone. */
  pid?: number;
  host?: string;
}

const journalSchema = z.object({
  txid: z.string().regex(/^[a-z0-9-]+$/),
  scope: z.enum(['project', 'user']),
  scopeRoot: z.string().min(1),
  name: z.string().min(1),
  stagingRoot: z.string().min(1),
  stagingDirs: z.array(z.string().min(1)),
  createdDirs: z.array(z.string().min(1)),
  steps: z.array(
    z.object({
      absDir: z.string().min(1),
      backup: z.string().min(1).optional(),
      staged: z.string().min(1).optional(),
      swapped: z.boolean(),
    }),
  ),
  committed: z.boolean(),
  lockFile: z.string().min(1),
  previousLockText: z.string().nullable(),
  newEntry: lockEntrySchema.nullable(),
  startedAt: z.string(),
  pid: z.number().int().positive().optional(),
  host: z.string().optional(),
});

export function newTxid(now: Date = new Date()): string {
  return `${now.getTime().toString(36)}-${randomBytes(4).toString('hex')}`;
}

export function journalDir(agenthubHome: string): string {
  return path.join(agenthubHome, 'journal');
}

export function journalFile(agenthubHome: string, txid: string): string {
  return path.join(journalDir(agenthubHome), `${txid}.json`);
}

export async function writeJournal(
  guard: WriteGuard,
  agenthubHome: string,
  journal: Journal,
): Promise<void> {
  await writeFileAtomic(
    guard,
    journalFile(agenthubHome, journal.txid),
    `${JSON.stringify(journal, null, 2)}\n`,
  );
}

export async function deleteJournal(
  guard: WriteGuard,
  agenthubHome: string,
  txid: string,
): Promise<void> {
  await removeFile(guard, journalFile(agenthubHome, txid));
}

export type JournalRead = { file: string; journal: Journal } | { file: string; error: string };

/** Every journal file in `<agenthubHome>/journal`, parsed and validated. */
export async function readJournals(agenthubHome: string): Promise<JournalRead[]> {
  const dir = journalDir(agenthubHome);
  const out: JournalRead[] = [];
  for (const name of await listDir(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const text = await readTextOrNull(file);
    if (text === null) continue;
    try {
      const parsed = journalSchema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        out.push({ file, error: parsed.error.issues[0]?.message ?? 'invalid journal' });
        continue;
      }
      out.push({ file, journal: parsed.data as Journal });
    } catch (error) {
      out.push({ file, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}
