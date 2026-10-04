/**
 * The real, Node-backed DetectContext (design §7.3). Everything here is read-only: it looks
 * up executables, runs them with constant arguments such as `--version`, checks whether paths
 * exist and lists directories. It never writes, creates or modifies anything.
 */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DetectContext, RunResult } from '@agenthub/core';

export interface NodeDetectContextOptions {
  home?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}

const MAX_BUFFER = 1024 * 1024;
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

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

export function createNodeDetectContext(opts: NodeDetectContextOptions = {}): DetectContext {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;

  /**
   * Absolute PATH entries only. Empty and relative entries (which would mean the current
   * directory) are skipped so a project folder can never shadow a real agent executable.
   */
  function searchDirs(): string[] {
    const raw = getEnvVar(env, 'PATH', platform) ?? '';
    const delimiter = platform === 'win32' ? ';' : ':';
    return raw
      .split(delimiter)
      .map((dir) => (platform === 'win32' ? dir.trim().replace(/^"(.*)"$/, '$1') : dir))
      .filter((dir) => dir !== '' && p.isAbsolute(dir));
  }

  function candidateNames(command: string): string[] {
    if (platform !== 'win32') return [command];
    const exts = (getEnvVar(env, 'PATHEXT', platform) ?? DEFAULT_PATHEXT)
      .split(';')
      .map((ext) => ext.trim().toLowerCase())
      .filter((ext) => ext.startsWith('.') && ext.length > 1);
    const names = p.extname(command) !== '' ? [command] : [];
    for (const ext of exts) names.push(command + ext);
    return names;
  }

  async function isExecutableFile(file: string): Promise<boolean> {
    try {
      const info = await stat(file);
      if (!info.isFile()) return false;
      if (platform === 'win32') return true;
      if ((info.mode & 0o111) === 0) return false;
      await access(file, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  async function which(command: string): Promise<string | null> {
    if (command === '' || command.includes('\0')) return null;
    const hasSeparator = platform === 'win32' ? /[\\/]/.test(command) : command.includes('/');
    if (hasSeparator) {
      // Explicit paths are accepted only when absolute; they are never searched on PATH.
      if (!p.isAbsolute(command)) return null;
      for (const name of candidateNames(p.basename(command))) {
        const full = p.join(p.dirname(command), name);
        if (await isExecutableFile(full)) return full;
      }
      return null;
    }
    for (const dir of searchDirs()) {
      for (const name of candidateNames(command)) {
        const full = p.join(dir, name);
        if (await isExecutableFile(full)) return full;
      }
    }
    return null;
  }

  async function run(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
    try {
      const resolved = p.isAbsolute(command) ? command : await which(command);
      if (resolved === null) return failure(`${command}: not found on PATH`);
      if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
        return runBatchShim(resolved, args, timeoutMs, env);
      }
      return execFileSafe(resolved, args, timeoutMs, env, false);
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

/**
 * Node refuses to spawn .cmd/.bat files without a shell (EINVAL), so they go through
 * cmd.exe. The command line is built only from the resolved absolute path and arguments
 * that passed the SAFE_SHIM_ARG guard; anything else is refused rather than escaped.
 */
function runBatchShim(
  resolved: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string | undefined>,
): Promise<RunResult> {
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
  // `/d` skips AutoRun commands; `/s /c "<line>"` strips exactly the outer quotes we add.
  return execFileSafe(comSpec(), ['/d', '/s', '/c', `"${commandLine}"`], timeoutMs, env, true);
}

function comSpec(): string {
  const configured = process.env.ComSpec;
  if (configured) return configured;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'cmd.exe');
}

function execFileSafe(
  file: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string | undefined>,
  verbatim: boolean,
): Promise<RunResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        file,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          shell: false,
          maxBuffer: MAX_BUFFER,
          encoding: 'utf8',
          env,
          windowsVerbatimArguments: verbatim,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, stdout, stderr });
            return;
          }
          const code = !error.killed && typeof error.code === 'number' ? error.code : null;
          if (code !== null) {
            resolve({ code, stdout, stderr });
            return;
          }
          const reason = error.killed ? `timed out after ${timeoutMs} ms` : error.message;
          resolve({
            code: null,
            stdout: stdout ?? '',
            stderr: stderr ? `${stderr}\n${reason}` : reason,
          });
        },
      );
    } catch (error) {
      resolve(failure(errorMessage(error)));
    }
  });
}

function failure(message: string): RunResult {
  return { code: null, stdout: '', stderr: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
