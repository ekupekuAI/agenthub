/**
 * The real, Node-backed DetectContext (design §7.3). Everything here is read-only: it looks
 * up executables, runs them with constant arguments such as `--version`, checks whether paths
 * exist and lists directories. It never writes, creates or modifies anything.
 *
 * agenthub is routinely run inside a freshly cloned, untrusted repository, so the working
 * directory and the project root are treated as hostile:
 * - PATH lookup skips empty, relative and drive-relative entries, entries inside the working
 *   directory or project root, and `node_modules` folders on their ancestor chain;
 * - nothing that resolves (through symlinks too) into those folders is ever executed;
 * - children start in a trusted directory outside the project, with a PATH cleaned the same
 *   way and, on Windows, `NoDefaultCurrentDirectoryInExePath=1`, so a batch shim or a
 *   `#!/usr/bin/env node` script cannot pick up a `node` planted in the project;
 * - every probe has a hard deadline that kills the whole process tree, an empty stdin and a
 *   cap on captured output.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { DetectContext, RunResult } from '@agenthub/core';

export interface NodeDetectContextOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /**
   * Directory agenthub was started in. Untrusted: nothing inside it is searched or executed.
   * Defaults to process.cwd().
   */
  cwd?: string;
  /** Project root, untrusted like `cwd`. Pass it when it differs from the working directory. */
  projectRoot?: string;
}

/** Most a probe may print (stdout + stderr) before it is killed. `--version` needs a few lines. */
export const MAX_PROBE_OUTPUT = 64 * 1024;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';
const KILL_WAIT_MS = 3000;
const CWD_LOOKUP_VAR = 'NoDefaultCurrentDirectoryInExePath';

/**
 * Batch-file shims (.cmd/.bat) can only be started through cmd.exe, which re-parses its
 * command line. To keep that safe, arguments must consist solely of these characters (the
 * callers only pass constants like `--version`), and the resolved path, which is wrapped in
 * double quotes, must not contain characters cmd.exe still interprets inside quotes.
 */
const SAFE_SHIM_ARG = /^[A-Za-z0-9._=-]+$/;
const UNSAFE_SHIM_PATH = /[\r\n"%!]/;

/** Reads an environment variable; names are case-insensitive on Windows. */
export function getEnvVar(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  const exact = env[name];
  if (exact !== undefined || platform !== 'win32') return exact;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value !== undefined) return value;
  }
  return undefined;
}

/**
 * True for a path that does not depend on the current directory or drive. On Windows that is
 * `X:\…` or a UNC share (`\\server\share…`); `\dir`, `/dir` and `X:dir` resolve against the
 * current drive or directory and are rejected, as are device paths (`\\.\`, `\\?\`).
 */
export function isFullyQualified(target: string, platform: NodeJS.Platform): boolean {
  if (target === '' || target.includes('\0')) return false;
  if (platform !== 'win32') return path.posix.isAbsolute(target);
  return /^[A-Za-z]:[\\/]/.test(target) || /^[\\/]{2}(?![.?][\\/])[^\\/]+[\\/]+[^\\/]/.test(target);
}

/**
 * The PATH entries that may be searched at all: fully qualified ones, with surrounding quotes
 * removed on Windows. Empty, relative and drive-relative entries (which would mean the
 * current directory or drive) are dropped. Folder trust is checked separately.
 */
export function searchPathEntries(raw: string, platform: NodeJS.Platform): string[] {
  const win = platform === 'win32';
  return raw
    .split(win ? ';' : ':')
    .map((dir) => (win ? dir.trim().replace(/^"(.*)"$/, '$1') : dir))
    .filter((dir) => isFullyQualified(dir, platform));
}

/** Extensions from PATHEXT; an empty or unusable value falls back to cmd.exe's defaults. */
export function pathExtensions(raw: string | undefined): string[] {
  const parse = (value: string) =>
    value
      .split(';')
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => /^\.[^.\\/:*?"<>|\s]+$/.test(ext));
  const exts = parse(raw ?? '');
  return exts.length > 0 ? exts : parse(DEFAULT_PATHEXT);
}

interface UntrustedRoot {
  /** Resolved path and, when different, its real path. */
  forms: string[];
  /**
   * False when the root is the home folder or one of its ancestors (agenthub started from
   * `~` or a drive root): that subtree holds the user's own tools, so only the folder itself
   * is untrusted. Otherwise everything below it is.
   */
  subtree: boolean;
}

export function createNodeDetectContext(opts: NodeDetectContextOptions = {}): DetectContext {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const rootInputs = [opts.cwd ?? process.cwd(), opts.projectRoot].filter(
    (dir): dir is string => dir !== undefined && isFullyQualified(dir, platform),
  );

  const realpaths = new Map<string, Promise<string | null>>();
  function realpathOf(target: string): Promise<string | null> {
    let cached = realpaths.get(target);
    if (cached === undefined) {
      cached = realpath(target).catch(() => null);
      realpaths.set(target, cached);
    }
    return cached;
  }

  async function formsOf(target: string): Promise<string[]> {
    const resolved = p.resolve(target);
    const real = await realpathOf(resolved);
    return real === null || real === resolved ? [resolved] : [resolved, real];
  }

  function contains(parent: string, child: string): boolean {
    const rel = p.relative(parent, child);
    return rel === '' || (!p.isAbsolute(rel) && rel !== '..' && !/^\.\.[\\/]/.test(rel));
  }

  let rootsPromise: Promise<UntrustedRoot[]> | undefined;
  function untrustedRoots(): Promise<UntrustedRoot[]> {
    rootsPromise ??= (async () => {
      const homeForms = isFullyQualified(home, platform) ? await formsOf(home) : [];
      return Promise.all(
        rootInputs.map(async (dir) => {
          const forms = await formsOf(dir);
          const subtree = !forms.some((form) => homeForms.some((h) => contains(form, h)));
          return { forms, subtree };
        }),
      );
    })();
    return rootsPromise;
  }

  /** True when `target` sits inside `<ancestor of rootForm>/node_modules`. */
  function insideAncestorNodeModules(rootForm: string, target: string): boolean {
    const parts = target.split(/[\\/]+/);
    for (let i = parts.length - 1; i > 0; i--) {
      const part = parts[i] ?? '';
      if ((win ? part.toLowerCase() : part) !== 'node_modules') continue;
      const prefix = parts.slice(0, i).join(p.sep);
      const base = prefix === '' || /^[A-Za-z]:$/.test(prefix) ? `${prefix}${p.sep}` : prefix;
      if (contains(base, rootForm)) return true;
    }
    return false;
  }

  /**
   * False when `target` (or what it resolves to) is the working directory or project root,
   * lies inside one of them, or lies inside a `node_modules` folder on their ancestor chain
   * (package managers prepend `<ancestor>/node_modules/.bin` to PATH).
   */
  async function isTrusted(target: string): Promise<boolean> {
    if (!isFullyQualified(target, platform)) return false;
    const targetForms = await formsOf(target);
    for (const root of await untrustedRoots()) {
      for (const rootForm of root.forms) {
        for (const form of targetForms) {
          if (root.subtree ? contains(rootForm, form) : p.relative(rootForm, form) === '') {
            return false;
          }
          if (insideAncestorNodeModules(rootForm, form)) return false;
        }
      }
    }
    return true;
  }

  let dirsPromise: Promise<string[]> | undefined;
  /** Trusted PATH directories, in PATH order. */
  function trustedSearchDirs(): Promise<string[]> {
    dirsPromise ??= (async () => {
      const dirs = searchPathEntries(getEnvVar(env, 'PATH', platform) ?? '', platform);
      const trusted = await Promise.all(dirs.map((dir) => isTrusted(dir)));
      return dirs.filter((_, index) => trusted[index]);
    })();
    return dirsPromise;
  }

  function candidateNames(command: string): string[] {
    if (!win) return [command];
    const names = p.extname(command) !== '' ? [command] : [];
    for (const ext of pathExtensions(getEnvVar(env, 'PATHEXT', platform))) {
      names.push(command + ext);
    }
    return names;
  }

  async function isExecutableFile(file: string): Promise<boolean> {
    try {
      const info = await stat(file);
      if (!info.isFile()) return false;
      if (win) return true;
      if ((info.mode & 0o111) === 0) return false;
      await access(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async function firstRunnable(dir: string, names: string[]): Promise<string | null> {
    for (const name of names) {
      const full = p.join(dir, name);
      if ((await isExecutableFile(full)) && (await isTrusted(full))) return full;
    }
    return null;
  }

  async function which(command: string): Promise<string | null> {
    if (command === '' || command.includes('\0')) return null;
    const hasSeparator = win ? /[\\/]/.test(command) : command.includes('/');
    if (hasSeparator) {
      // Explicit paths are accepted only when fully qualified; they are never searched on PATH.
      if (!isFullyQualified(command, platform)) return null;
      return firstRunnable(p.dirname(command), candidateNames(p.basename(command)));
    }
    for (const dir of await trustedSearchDirs()) {
      const found = await firstRunnable(dir, candidateNames(command));
      if (found !== null) return found;
    }
    return null;
  }

  function systemDir(): string {
    const root = getEnvVar(env, 'SystemRoot', platform) ?? process.env.SystemRoot;
    const base = root !== undefined && isFullyQualified(root, platform) ? root : 'C:\\Windows';
    return path.win32.join(base, 'System32');
  }

  /** A directory outside the project for children to start in. */
  async function workingDir(): Promise<string> {
    const candidates = win ? [systemDir(), tmpdir(), home] : ['/', tmpdir(), home];
    for (const dir of candidates) {
      if (!isFullyQualified(dir, platform)) continue;
      try {
        if ((await stat(dir)).isDirectory() && (await isTrusted(dir))) return dir;
      } catch {
        // try the next one
      }
    }
    return candidates[0] as string;
  }

  /** The caller's environment with PATH reduced to trusted folders and cwd lookup disabled. */
  async function childEnv(): Promise<Record<string, string>> {
    const dropped = win ? ['PATH', CWD_LOOKUP_VAR.toUpperCase()] : ['PATH'];
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || dropped.includes(win ? key.toUpperCase() : key)) continue;
      out[key] = value;
    }
    out.PATH = (await trustedSearchDirs()).join(win ? ';' : ':');
    if (win) out[CWD_LOOKUP_VAR] = '1';
    return out;
  }

  async function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
    try {
      const resolved = isFullyQualified(command, platform) ? command : await which(command);
      if (resolved === null) return failure(`${command}: not found on PATH`);
      if (!(await isTrusted(resolved))) {
        return failure(
          `refusing to run ${resolved}: it is inside the working directory or project`,
        );
      }
      const plan: SpawnPlan = {
        cwd: await workingDir(),
        env: await childEnv(),
        timeoutMs,
        win,
        systemDir: win ? systemDir() : '',
      };
      if (win && /\.(cmd|bat)$/i.test(resolved)) return runBatchShim(resolved, args, plan);
      return runBounded(resolved, args, false, plan);
    } catch (error) {
      return failure(errorMessage(error));
    }
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  }

  async function listDir(target: string): Promise<string[]> {
    try {
      return await readdir(target);
    } catch {
      return [];
    }
  }

  return { home, env, platform, which, run, exists, listDir };
}

interface SpawnPlan {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  win: boolean;
  /** `%SystemRoot%\System32` on Windows, '' elsewhere. */
  systemDir: string;
}

/**
 * Node refuses to spawn .cmd/.bat files without a shell (EINVAL), so they go through
 * cmd.exe. The command line is built only from the resolved absolute path and arguments
 * that passed the SAFE_SHIM_ARG guard; anything else is refused rather than escaped.
 */
function runBatchShim(resolved: string, args: string[], plan: SpawnPlan): Promise<RunResult> {
  const unsafeArg = args.find((arg) => !SAFE_SHIM_ARG.test(arg));
  if (unsafeArg !== undefined) {
    return Promise.resolve(
      failure(`refusing to pass argument ${JSON.stringify(unsafeArg)} through cmd.exe`),
    );
  }
  if (UNSAFE_SHIM_PATH.test(resolved)) {
    return Promise.resolve(
      failure(`refusing to run ${resolved} through cmd.exe: the path contains % ! or "`),
    );
  }
  const commandLine = [`"${resolved}"`, ...args].join(' ');
  // Always the system cmd.exe (never %ComSpec%); `/d` skips AutoRun commands;
  // `/s /c "<line>"` strips exactly the outer quotes we add.
  const cmd = path.win32.join(plan.systemDir, 'cmd.exe');
  return runBounded(cmd, ['/d', '/s', '/c', `"${commandLine}"`], true, plan);
}

/**
 * Runs a child with an empty stdin and a hard deadline. The promise settles from the timer
 * itself, so a child that ignores signals cannot hold it, and on expiry (or once the output
 * passes MAX_PROBE_OUTPUT) the whole process tree is killed.
 */
function runBounded(
  file: string,
  args: string[],
  verbatim: boolean,
  plan: SpawnPlan,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: plan.cwd,
        env: plan.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX so the whole tree can be signalled.
        detached: !plan.win,
      });
    } catch (error) {
      resolve(failure(errorMessage(error)));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString('utf8');

    /** Stops listening; the child no longer keeps agenthub alive. */
    const detach = () => {
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };

    const settle = (result: RunResult) => {
      if (settled) return;
      detach();
      resolve(result);
    };

    const abort = (reason: string) => {
      if (settled) return;
      const err = text(stderr);
      const result: RunResult = {
        code: null,
        stdout: text(stdout),
        stderr: err ? `${reason}\n${err}` : reason,
      };
      detach();
      void killTree(child, plan).then(() => resolve(result));
    };

    const timer = setTimeout(() => abort(`timed out after ${plan.timeoutMs} ms`), plan.timeoutMs);

    const collect = (bucket: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      const room = MAX_PROBE_OUTPUT - size;
      size += chunk.length;
      if (size > MAX_PROBE_OUTPUT) {
        if (room > 0) bucket.push(chunk.subarray(0, room));
        abort(`output exceeded ${MAX_PROBE_OUTPUT} bytes`);
        return;
      }
      bucket.push(chunk);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));

    child.on('error', (error) => settle(failure(error.message)));
    child.on('close', (code, signal) => {
      if (code !== null) {
        settle({ code, stdout: text(stdout), stderr: text(stderr) });
        return;
      }
      const reason = `terminated by ${signal ?? 'a signal'}`;
      const err = text(stderr);
      settle({ code: null, stdout: text(stdout), stderr: err ? `${reason}\n${err}` : reason });
    });
  });
}

/**
 * Kills `child` and everything it started. Windows: the system taskkill.exe with /T /F (the
 * direct child of a shim is cmd.exe, the real program its child). POSIX: SIGKILL to the
 * child's process group. Resolves once done, or after KILL_WAIT_MS at the latest.
 */
function killTree(child: ChildProcess, plan: SpawnPlan): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return Promise.resolve();
  if (!plan.win) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(guard);
      // Fallback for the direct child in case taskkill could not run.
      child.kill();
      resolve();
    };
    const guard = setTimeout(done, KILL_WAIT_MS);
    try {
      const killer = spawn(
        path.win32.join(plan.systemDir, 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { cwd: plan.cwd, env: plan.env, stdio: 'ignore', windowsHide: true, shell: false },
      );
      killer.on('error', done);
      killer.on('exit', done);
      killer.unref();
    } catch {
      done();
    }
  });
}

function failure(message: string): RunResult {
  return { code: null, stdout: '', stderr: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
