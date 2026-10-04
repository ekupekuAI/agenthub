/**
 * Filesystem helpers for the install engine (design §8.4). Every write, rename and delete goes
 * through a WriteGuard that only allows the roots of the current operation, and nothing here
 * ever follows a symlink or junction when deleting.
 */
import { randomBytes } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentHubError } from '../errors';
import { fileHash } from '../hash';
import { normalizeFile } from '../normalize';
import { comparePaths } from '../paths';
import type { PackageFile } from '../types';
import type { VerifyFileStatus } from './api';

const IS_WINDOWS = process.platform === 'win32';

/** Hash recorded by hashInstalledDir for a symlink/junction (never equals a real file hash). */
export const LINK_MARKER = 'unsafe:symlink';
/** Hash recorded by hashInstalledDir for a device, FIFO or other special file. */
export const SPECIAL_MARKER = 'unsafe:special';

function comparable(p: string): string {
  const resolved = path.resolve(p);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

/** True when `target` is `root` or lies inside it (lexically, after resolving `.`/`..`). */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(comparable(root), comparable(target));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !rel.startsWith('../');
}

/** Restricts engine writes to the allowed roots of one operation (handoff security test 7). */
export class WriteGuard {
  private readonly roots: string[] = [];

  constructor(roots: Iterable<string> = []) {
    for (const root of roots) this.allow(root);
  }

  allow(root: string): void {
    const resolved = path.resolve(root);
    if (!this.roots.includes(resolved)) this.roots.push(resolved);
  }

  get allowedRoots(): readonly string[] {
    return this.roots;
  }

  isAllowed(target: string): boolean {
    return this.roots.some((root) => isWithin(root, target));
  }

  assertAllowed(target: string): void {
    if (this.isAllowed(target)) return;
    throw new AgentHubError(
      'INTERNAL',
      `refusing to write outside allowed targets: ${path.resolve(target)}`,
      { path: path.resolve(target), allowed: [...this.roots] },
    );
  }

  /** Creating a directory is allowed inside a root, or for an ancestor of a root. */
  assertCanCreateDir(dir: string): void {
    if (this.isAllowed(dir) || this.roots.some((root) => isWithin(dir, root))) return;
    this.assertAllowed(dir);
  }
}

export function errnoCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ioError(action: string, target: string, error: unknown): AgentHubError {
  if (error instanceof AgentHubError) return error;
  const code = errnoCode(error);
  const hint =
    code !== undefined && RETRYABLE.has(code) ? ' — another program may have a file open' : '';
  return new AgentHubError(
    'IO',
    `could not ${action} ${target}: ${code ?? errorText(error)}${hint}`,
    {
      path: target,
      cause: code,
    },
  );
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Total retry budget for locked files, ≈3 s (50 ms doubling). Tests may lower it. */
export const retrySettings = { initialDelayMs: 50, totalMs: 3000 };

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let delay = retrySettings.initialDelayMs;
  let waited = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const code = errnoCode(error);
      if (code === undefined || !RETRYABLE.has(code) || waited >= retrySettings.totalMs)
        throw error;
      await sleep(delay);
      waited += delay;
      delay *= 2;
    }
  }
}

/** lstat that returns null for a missing path. */
export async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw ioError('inspect', target, error);
  }
}

export type PathKind = 'missing' | 'link' | 'dir' | 'file' | 'other';

/** What is at `target`, without following links (junctions count as links). */
export async function pathKind(target: string): Promise<PathKind> {
  const st = await lstatOrNull(target);
  if (st === null) return 'missing';
  if (st.isSymbolicLink()) return 'link';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return 'other';
}

export async function exists(target: string): Promise<boolean> {
  return (await lstatOrNull(target)) !== null;
}

/**
 * mkdir -p through the guard. Returns every directory it created, deepest first, so a failed
 * transaction can remove them again.
 */
export async function mkdirp(guard: WriteGuard, dir: string): Promise<string[]> {
  const target = path.resolve(dir);
  guard.assertCanCreateDir(target);
  let first: string | undefined;
  try {
    first = await fs.mkdir(target, { recursive: true });
  } catch (error) {
    throw ioError('create', target, error);
  }
  if (first === undefined) return [];
  const created: string[] = [];
  for (let current = target; ; current = path.dirname(current)) {
    created.push(current);
    if (comparable(current) === comparable(first) || path.dirname(current) === current) break;
  }
  return created;
}

/** Remove directories (deepest first) that are still empty; ignore the rest. */
export async function removeEmptyDirs(guard: WriteGuard, dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    guard.assertCanCreateDir(dir);
    try {
      await fs.rmdir(dir);
    } catch {
      // not empty or already gone
    }
  }
}

/** Write a file atomically: temp file in the same directory, then rename. */
export async function writeFileAtomic(
  guard: WriteGuard,
  file: string,
  data: string | Uint8Array,
): Promise<void> {
  const target = path.resolve(file);
  guard.assertAllowed(target);
  await mkdirp(guard, path.dirname(target));
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  guard.assertAllowed(temp);
  try {
    await fs.writeFile(temp, data);
    await withRetry(() => fs.rename(temp, target));
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw ioError('write', target, error);
  }
}

/** Append text to a file (audit log). */
export async function appendFileGuarded(
  guard: WriteGuard,
  file: string,
  text: string,
): Promise<void> {
  const target = path.resolve(file);
  guard.assertAllowed(target);
  await mkdirp(guard, path.dirname(target));
  try {
    await fs.appendFile(target, text);
  } catch (error) {
    throw ioError('write', target, error);
  }
}

/**
 * Rename with retry: EPERM/EBUSY/EACCES/ENOTEMPTY (Windows file locks, antivirus scanners) are
 * retried with backoff for about three seconds before failing with an IO error naming the path.
 */
export async function renameWithRetry(guard: WriteGuard, from: string, to: string): Promise<void> {
  guard.assertAllowed(from);
  guard.assertAllowed(to);
  try {
    await withRetry(() => fs.rename(from, to));
  } catch (error) {
    throw ioError('move', `${from} to ${to}`, error);
  }
}

async function unlinkFile(target: string): Promise<void> {
  try {
    await withRetry(() => fs.unlink(target));
  } catch (error) {
    // Read-only files cannot be unlinked on Windows: clear the flag and try once more.
    if (errnoCode(error) !== 'EPERM' && errnoCode(error) !== 'EACCES') throw error;
    await fs.chmod(target, 0o666);
    await fs.unlink(target);
  }
}

/** Remove a symlink or junction itself, never what it points to. */
async function unlinkLink(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (error) {
    const code = errnoCode(error);
    // Directory symlinks and junctions on Windows are removed with rmdir, which does not
    // touch the link target.
    if (code !== 'EPERM' && code !== 'EISDIR' && code !== 'EACCES') throw error;
    await fs.rmdir(target);
  }
}

/** Recursive delete that uses lstat and never follows symlinks or junctions. */
export async function removeTree(guard: WriteGuard, target: string): Promise<void> {
  const resolved = path.resolve(target);
  guard.assertAllowed(resolved);
  const st = await lstatOrNull(resolved);
  if (st === null) return;
  try {
    if (st.isSymbolicLink()) {
      await unlinkLink(resolved);
      return;
    }
    if (st.isDirectory()) {
      for (const entry of await fs.readdir(resolved)) {
        await removeTree(guard, path.join(resolved, entry));
      }
      await withRetry(() => fs.rmdir(resolved));
      return;
    }
    await unlinkFile(resolved);
  } catch (error) {
    throw ioError('delete', resolved, error);
  }
}

/** Remove one file (not a directory); links are unlinked, never followed. */
export async function removeFile(guard: WriteGuard, target: string): Promise<void> {
  const resolved = path.resolve(target);
  guard.assertAllowed(resolved);
  const st = await lstatOrNull(resolved);
  if (st === null) return;
  try {
    if (st.isSymbolicLink()) await unlinkLink(resolved);
    else await unlinkFile(resolved);
  } catch (error) {
    throw ioError('delete', resolved, error);
  }
}

/** Write package files into `dir` (which must not exist yet). Executables get 0755 on POSIX. */
export async function writePackageFiles(
  guard: WriteGuard,
  dir: string,
  files: readonly PackageFile[],
): Promise<void> {
  await mkdirp(guard, dir);
  for (const file of files) {
    const target = path.join(dir, ...file.path.split('/'));
    guard.assertAllowed(target);
    await mkdirp(guard, path.dirname(target));
    try {
      await fs.writeFile(target, file.content, { flag: 'wx' });
      if (file.executable && !IS_WINDOWS) await fs.chmod(target, 0o755);
    } catch (error) {
      throw ioError('write', target, error);
    }
  }
}

/** Copy the given relative files from `fromDir` to `toDir`. */
export async function copyFiles(
  guard: WriteGuard,
  fromDir: string,
  toDir: string,
  relPaths: readonly string[],
): Promise<void> {
  await mkdirp(guard, toDir);
  for (const rel of relPaths) {
    const source = path.join(fromDir, ...rel.split('/'));
    const target = path.join(toDir, ...rel.split('/'));
    guard.assertAllowed(target);
    await mkdirp(guard, path.dirname(target));
    try {
      const st = await fs.lstat(source);
      if (!st.isFile()) throw new AgentHubError('IO', `not a regular file: ${source}`);
      await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      throw ioError('copy', source, error);
    }
  }
}

/** Every regular file under `dir` as POSIX relative path + bytes. Links are rejected. */
export async function readTreeFiles(dir: string): Promise<{ path: string; content: Uint8Array }[]> {
  const out: { path: string; content: Uint8Array }[] = [];
  const walk = async (absolute: string, prefix: string): Promise<void> => {
    const names = (await fs.readdir(absolute)).sort();
    for (const name of names) {
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const full = path.join(absolute, name);
      const st = await fs.lstat(full);
      if (st.isSymbolicLink()) {
        throw new AgentHubError('INTEGRITY', `unexpected link in ${dir}: ${rel}`, { path: full });
      }
      if (st.isDirectory()) await walk(full, rel);
      else if (st.isFile())
        out.push({ path: rel, content: new Uint8Array(await fs.readFile(full)) });
      else throw new AgentHubError('INTEGRITY', `unexpected special file in ${dir}: ${rel}`);
    }
  };
  try {
    await walk(dir, '');
  } catch (error) {
    throw ioError('read', dir, error);
  }
  return out;
}

/**
 * Hash an installed skill folder: relative POSIX path -> 'sha256:<hex>' of the normalized bytes
 * (CRLF checkouts still match). Symlinks/junctions and special files are reported with marker
 * values that never equal a real hash, so they show up as modified or extra.
 */
export async function hashInstalledDir(absDir: string): Promise<Record<string, string>> {
  const entries: [string, string][] = [];
  const walk = async (absolute: string, prefix: string): Promise<void> => {
    const names = await fs.readdir(absolute);
    for (const name of names) {
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      const full = path.join(absolute, name);
      const st = await fs.lstat(full);
      if (st.isSymbolicLink()) entries.push([rel, LINK_MARKER]);
      else if (st.isDirectory()) await walk(full, rel);
      else if (st.isFile()) {
        const bytes = new Uint8Array(await fs.readFile(full));
        entries.push([rel, fileHash(normalizeFile(rel, bytes).content)]);
      } else entries.push([rel, SPECIAL_MARKER]);
    }
  };
  try {
    await walk(absDir, '');
  } catch (error) {
    throw ioError('read', absDir, error);
  }
  entries.sort(([a], [b]) => comparePaths(a, b));
  return Object.fromEntries(entries);
}

/** Compare expected (lock) hashes with what is on disk. Sorted by path. */
export function diffFiles(
  expected: Record<string, string>,
  actual: Record<string, string>,
): VerifyFileStatus[] {
  const out: VerifyFileStatus[] = [];
  for (const [file, hash] of Object.entries(expected)) {
    if (!Object.hasOwn(actual, file)) out.push({ path: file, status: 'missing' });
    else out.push({ path: file, status: actual[file] === hash ? 'ok' : 'modified' });
  }
  for (const file of Object.keys(actual)) {
    if (!Object.hasOwn(expected, file)) out.push({ path: file, status: 'extra' });
  }
  return out.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * True when `target` still lies inside `root` after resolving symlinks/junctions in its nearest
 * existing ancestor (the write guard itself is lexical; this catches a linked skills folder).
 */
export async function resolvesWithin(root: string, target: string): Promise<boolean> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return false;
  }
  const resolved = path.resolve(target);
  for (let current = resolved; ; current = path.dirname(current)) {
    try {
      const real = await fs.realpath(current);
      return isWithin(realRoot, path.join(real, path.relative(current, resolved)));
    } catch {
      if (path.dirname(current) === current) return false;
    }
  }
}

/** Total size in bytes of the regular files under `dir` (0 when missing). Links not followed. */
export async function treeSize(dir: string): Promise<number> {
  const st = await lstatOrNull(dir);
  if (st === null) return 0;
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await fs.readdir(dir)) total += await treeSize(path.join(dir, name));
  return total;
}

/** Device id of the nearest existing ancestor of `target` (for same-volume checks). */
export async function deviceOf(target: string): Promise<number | bigint | null> {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try {
      return (await fs.stat(current)).dev;
    } catch {
      if (path.dirname(current) === current) return null;
    }
  }
}

export async function sameDevice(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([deviceOf(a), deviceOf(b)]);
  return da !== null && da === db;
}

export async function readTextOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw ioError('read', file, error);
  }
}

/** Directory entry names, or [] when the directory does not exist. */
export async function listDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort();
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw ioError('read', dir, error);
  }
}
