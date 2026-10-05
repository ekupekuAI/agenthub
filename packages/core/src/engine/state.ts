/**
 * Where local state lives (design §6): project root discovery, scope roots, lock locations and
 * scope ids.
 */
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentHubError } from '../errors';
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
 * look like one. For the same reason a home directory that is itself a git work tree (dotfiles
 * kept in `~/.git`) is not a project: home is the user scope only.
 */
export function findProjectRoot(
  cwd: string,
  opts: { home?: string; agenthubHome?: string } = {},
): string | null {
  const start = path.resolve(cwd);
  // The real OS home is never a project either, even when AGENTHUB_USER_HOME/AGENTHUB_HOME
  // point elsewhere. Otherwise a folder under home without .git resolves to home, and project
  // installs land in the user's global agent folders (~/.claude/skills, ~/.agents/skills).
  const osHome = os.homedir();
  const isHome = (dir: string) =>
    samePath(dir, osHome) || (opts.home !== undefined && samePath(dir, opts.home));
  for (let current = start; ; current = path.dirname(current)) {
    const candidate = path.join(current, STATE_DIR);
    const isMachineState =
      (opts.agenthubHome !== undefined && samePath(candidate, opts.agenthubHome)) ||
      isHome(current);
    if (!isMachineState && isDir(candidate)) return current;
    if (path.dirname(current) === current) break;
  }
  for (let current = start; ; current = path.dirname(current)) {
    const isMachineState =
      isHome(current) ||
      (opts.agenthubHome !== undefined &&
        samePath(path.join(current, STATE_DIR), opts.agenthubHome));
    if (!isMachineState && existsSync(path.join(current, '.git'))) return current;
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
  const dir = path.join(loc.projectRoot, STATE_DIR);
  if (samePath(dir, loc.agenthubHome)) {
    throw new AgentHubError(
      'USAGE',
      `the project state folder ${dir} is the machine state folder; use -g for user-wide installs`,
    );
  }
  return dir;
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

/** Files and folders of a project's `.agenthub/` state folder, with the kind each must be. */
export function projectStateEntries(projectRoot: string): [string, 'dir' | 'file'][] {
  const dir = path.join(projectRoot, STATE_DIR);
  return [
    [dir, 'dir'],
    [path.join(dir, 'tmp'), 'dir'],
    [path.join(dir, '.gitignore'), 'file'],
    [path.join(dir, LOCK_FILE), 'file'],
    [path.join(dir, CONFIG_FILE), 'file'],
  ];
}

/**
 * A project's state folder is committed to git, so it is untrusted: refuse it when `.agenthub`,
 * `tmp`, `.gitignore`, the lock or the config is a symlink, junction or special file (reads and
 * writes would otherwise follow the link out of the project). Missing entries are fine.
 */
export function assertProjectStateSafe(projectRoot: string): void {
  for (const [entry, kind] of projectStateEntries(projectRoot)) {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(entry);
    } catch {
      continue;
    }
    const ok = !st.isSymbolicLink() && (kind === 'dir' ? st.isDirectory() : st.isFile());
    if (!ok) {
      throw new AgentHubError(
        'CONFLICT',
        `${entry} is a symlink, junction or not a ${kind === 'dir' ? 'folder' : 'regular file'}; agenthub will not read or write project state through it`,
        { path: entry },
      );
    }
  }
}

/** Make sure `<root>/.agenthub/.gitignore` ignores `tmp/`. */
export async function ensureStateGitignore(guard: WriteGuard, stateDir: string): Promise<void> {
  const file = path.join(stateDir, '.gitignore');
  assertProjectStateSafe(path.dirname(stateDir));
  const current = await readTextOrNull(file);
  if (current?.split(/\r?\n/).some((line) => line.trim() === 'tmp/')) return;
  const prefix =
    current === null || current === '' ? '' : current.endsWith('\n') ? current : `${current}\n`;
  await writeFileAtomic(guard, file, `${prefix}tmp/\n`);
}
