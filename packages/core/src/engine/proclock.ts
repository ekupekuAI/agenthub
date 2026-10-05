/**
 * Inter-process exclusion (design §8.4): one agenthub process at a time changes skills or replays
 * journals for a given machine state folder. The lock is `<agenthubHome>/agenthub.pid`, created
 * with O_EXCL and holding the owner's pid, host and start time. A lock whose owner is no longer
 * running (same host) or that is older than `staleMs` is treated as stale and taken over.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { AgentHubError } from '../errors';
import { errnoCode, errorText, mkdirp, WriteGuard } from './fsutil';

export const PROCESS_LOCK_FILE = 'agenthub.pid';

/** Waiting and staleness limits. Tests may lower them. */
export const lockSettings = { timeoutMs: 15_000, pollMs: 100, staleMs: 10 * 60_000 };

interface LockOwner {
  pid: number;
  host: string;
  startedAt: string;
  token: string;
}

/** Whether a process with this pid is running on this machine (EPERM still means it exists). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === 'EPERM';
  }
}

/** Whether a journal or lock written by `pid` on `host` may belong to a transaction still running. */
export function ownerAlive(pid: number | undefined, host: string | undefined): boolean {
  if (pid === undefined) return false;
  if (host !== undefined && host !== hostname()) return true;
  return isProcessAlive(pid);
}

export function processLockFile(agenthubHome: string): string {
  return path.join(agenthubHome, PROCESS_LOCK_FILE);
}

async function readOwner(file: string): Promise<{ owner: LockOwner | null; text: string } | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
  try {
    const raw = JSON.parse(text) as Partial<LockOwner>;
    if (
      typeof raw.pid === 'number' &&
      typeof raw.host === 'string' &&
      typeof raw.startedAt === 'string' &&
      typeof raw.token === 'string'
    ) {
      return { owner: raw as LockOwner, text };
    }
  } catch {
    // half-written or foreign content
  }
  return { owner: null, text };
}

async function isStale(file: string, owner: LockOwner | null, now: Date): Promise<boolean> {
  let mtime: number;
  try {
    mtime = (await fs.stat(file)).mtimeMs;
  } catch {
    return false;
  }
  const age = now.getTime() - mtime;
  if (age > lockSettings.staleMs) return true;
  // Unreadable content: the owner may still be writing it; give it a few seconds.
  if (owner === null) return age > 5_000;
  if (owner.host !== hostname()) return false;
  return !isProcessAlive(owner.pid);
}

export type ReleaseLock = () => Promise<void>;

/**
 * Take the process lock, waiting up to `lockSettings.timeoutMs` (or `opts.waitMs`). Returns the
 * release function, or null when `opts.waitMs` is 0 and a live process holds the lock.
 */
export async function acquireProcessLock(
  agenthubHome: string,
  opts: { waitMs?: number; now?: () => Date } = {},
): Promise<ReleaseLock | null> {
  const file = processLockFile(agenthubHome);
  const guard = new WriteGuard([agenthubHome]);
  await mkdirp(guard, agenthubHome);
  const now = opts.now ?? (() => new Date());
  const waitMs = opts.waitMs ?? lockSettings.timeoutMs;
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    startedAt: now().toISOString(),
    token: randomBytes(8).toString('hex'),
  };
  const deadline = Date.now() + waitMs;
  let holder: LockOwner | null = null;
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx');
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`);
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readOwner(file).catch(() => null);
        if (current?.owner?.token === owner.token) await fs.rm(file, { force: true });
      };
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') {
        throw new AgentHubError('IO', `could not create ${file}: ${errorText(error)}`, {
          path: file,
        });
      }
    }
    const current = await readOwner(file);
    if (current === null) continue;
    holder = current.owner;
    if (await isStale(file, current.owner, new Date())) {
      // Remove it only if it still holds what was judged stale.
      const again = await readOwner(file);
      if (again !== null && again.text === current.text) await fs.rm(file, { force: true });
      continue;
    }
    if (Date.now() >= deadline) break;
    await new Promise<void>((resolve) => setTimeout(resolve, lockSettings.pollMs));
  }
  if (opts.waitMs === 0) return null;
  const who = holder ? `pid ${holder.pid} on ${holder.host}, since ${holder.startedAt}` : 'unknown';
  throw new AgentHubError(
    'CONFLICT',
    `another agenthub process (${who}) is installing or removing skills — wait for it to finish, or delete ${file} if no agenthub process is running`,
    { path: file, owner: holder },
  );
}
