/**
 * Where local state lives (design §6): project root discovery, scope roots, lock locations and
 * scope ids.
 */
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Scope } from '../types';
import { readTextOrNull, type WriteGuard, writeFileAtomic } from './fsutil';

export const STATE_DIR = '.agenthub';
export const LOCK_FILE = 'agenthub.lock';
export const CONFIG_FILE = 'config.json';

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsSync(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/**
 * Project root: nearest ancestor of `cwd` containing a `.agenthub` directory, else the nearest
 * ancestor containing `.git` (directory or file), else null.
 *
 * The machine-state folder (`agenthubHome`, normally `~/.agenthub`) and a `.agenthub` folder
 * directly in the home directory never mark a project; otherwise every folder under home would
 * look like one.
 */
export function findProjectRoot(
  cwd: string,
  opts: { home?: string; agenthubHome?: string } = {},
): string | null {
  const start = path.resolve(cwd);
  for (let current = start; ; current = path.dirname(current)) {
    const candidate = path.join(current, STATE_DIR);
    const isMachineState =
      (opts.agenthubHome !== undefined && samePath(candidate, opts.agenthubHome)) ||
      (opts.home !== undefined && samePath(current, opts.home));
    if (!isMachineState && isDir(candidate)) return current;
    if (path.dirname(current) === current) break;
  }
  for (let current = start; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) return current;
    if (path.dirname(current) === current) break;
  }
  return null;
}

export interface StateLocations {
  projectRoot: string | null;
  home: string;
  agenthubHome: string;
}

/** Directory holding the scope's lock and staging area: `<root>/.agenthub` or agenthubHome. */
export function scopeStateDir(scope: Scope, loc: StateLocations): string {
  if (scope === 'user') return loc.agenthubHome;
  if (loc.projectRoot === null) throw new Error('no project root');
  return path.join(loc.projectRoot, STATE_DIR);
}

export function lockFilePath(scope: Scope, loc: StateLocations): string {
  return path.join(scopeStateDir(scope, loc), LOCK_FILE);
}

/** Staging root for the scope: `<root>/.agenthub/tmp` or `<agenthubHome>/tmp`. */
export function scopeTmpDir(scope: Scope, loc: StateLocations): string {
  return path.join(scopeStateDir(scope, loc), 'tmp');
}

/** 'user', or the first 16 hex chars of sha256(real path of the project root). */
export function scopeId(scope: Scope, projectRoot: string | null): string {
  if (scope === 'user') return 'user';
  if (projectRoot === null) throw new Error('no project root');
  let real = projectRoot;
  try {
    real = realpathSync.native(projectRoot);
  } catch {
    real = path.resolve(projectRoot);
  }
  return createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 16);
}

/** Make sure `<root>/.agenthub/.gitignore` ignores `tmp/`. */
export async function ensureStateGitignore(guard: WriteGuard, stateDir: string): Promise<void> {
  const file = path.join(stateDir, '.gitignore');
  const current = await readTextOrNull(file);
  if (current?.split(/\r?\n/).some((line) => line.trim() === 'tmp/')) return;
  const prefix =
    current === null || current === '' ? '' : current.endsWith('\n') ? current : `${current}\n`;
  await writeFileAtomic(guard, file, `${prefix}tmp/\n`);
}
