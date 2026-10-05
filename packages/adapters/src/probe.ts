/**
 * Building blocks for read-only agent detection (design §7.3). Probes only go through the
 * DetectContext, never throw, and turn every failure into a lower confidence.
 */
import path from 'node:path';
import type { DetectContext, RunResult } from '@agenthub/core';
import { getEnvVar } from './context';

export const DETECT_TIMEOUT_MS = 5000;

/**
 * Bounded quantifiers plus a "no digit before" guard keep the scan linear: a run of digits
 * without a dot costs at most ~10 steps per position instead of backtracking over the rest.
 */
const VERSION_PATTERN = /(?<!\d)\d{1,9}\.\d{1,9}(?:\.\d{1,9})?/;
/** `--version` prints its version up front; only this much of the output is looked at. */
const VERSION_SCAN_LIMIT = 4096;
const MAX_REASON_LENGTH = 120;

/** First `major.minor[.patch]` token near the start of the text, if any. */
export function parseVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output.slice(0, VERSION_SCAN_LIMIT))?.[0];
}

export interface ExecutableProbe {
  executable?: string;
  version?: string;
  evidence: string[];
}

/** Looks up `command` on PATH and asks it for `--version`. */
export async function probeExecutable(
  ctx: DetectContext,
  command: string,
): Promise<ExecutableProbe> {
  let executable: string | null;
  try {
    executable = await ctx.which(command);
  } catch {
    executable = null;
  }
  if (!executable) return { evidence: [] };

  const evidence = [`found ${command} at ${displayPath(ctx, executable)}`];
  let result: RunResult;
  try {
    result = await ctx.run(executable, ['--version'], DETECT_TIMEOUT_MS);
  } catch (error) {
    evidence.push(`${command} --version failed: ${shorten(errorMessage(error))}`);
    return { executable, evidence };
  }
  if (result.code !== 0) {
    evidence.push(`${command} --version failed: ${describeFailure(result)}`);
    return { executable, evidence };
  }
  const output = result.stdout.trim() !== '' ? result.stdout : result.stderr;
  const version = parseVersion(output);
  if (version === undefined) {
    evidence.push(`${command} --version printed no version`);
    return { executable, evidence };
  }
  evidence.push(`${command} --version → ${version}`);
  return { executable, version, evidence };
}

export interface FolderProbe {
  /** Absolute path to check. */
  path: string;
  /** How the folder is named in evidence, e.g. '~/.claude' or '$CODEX_HOME (D:\codex)'. */
  label: string;
}

/** Evidence lines for the folders that exist. Duplicate paths are checked once. */
export async function probeFolders(ctx: DetectContext, folders: FolderProbe[]): Promise<string[]> {
  const seen = new Set<string>();
  const unique = folders.filter((folder) => {
    const key = ctx.platform === 'win32' ? folder.path.toLowerCase() : folder.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const found = await Promise.all(
    unique.map(async (folder) => {
      try {
        return (await ctx.exists(folder.path)) ? `found ${folder.label}` : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((line): line is string => line !== null);
}

/** Lists a directory through the context; [] on any error. */
export async function safeListDir(ctx: DetectContext, dir: string): Promise<string[]> {
  try {
    return await ctx.listDir(dir);
  } catch {
    return [];
  }
}

export function pathApi(ctx: Pick<DetectContext, 'platform'>): typeof path.posix {
  return ctx.platform === 'win32' ? path.win32 : path.posix;
}

/** Absolute path of `~/<relative>` for this context. */
export function homePath(
  ctx: Pick<DetectContext, 'home' | 'platform'>,
  ...segments: string[]
): string {
  return pathApi(ctx).join(ctx.home, ...segments);
}

/** Folder probe for an environment variable that names a directory, if it is set. */
export function envFolder(
  ctx: Pick<DetectContext, 'env' | 'home' | 'platform'>,
  name: string,
): FolderProbe[] {
  const value = getEnvVar(ctx.env, name, ctx.platform)?.trim();
  if (!value) return [];
  const p = pathApi(ctx);
  let resolved = value;
  if (value === '~') resolved = ctx.home;
  else if (/^~[\\/]/.test(value)) resolved = p.join(ctx.home, value.slice(2));
  if (!p.isAbsolute(resolved)) return [];
  return [{ path: resolved, label: `$${name} (${value})` }];
}

/** Shows paths under the home directory as `~…`. */
export function displayPath(ctx: Pick<DetectContext, 'home' | 'platform'>, target: string): string {
  const home = ctx.home;
  if (home === '') return target;
  const win = ctx.platform === 'win32';
  const same = win ? target.toLowerCase().startsWith(home.toLowerCase()) : target.startsWith(home);
  if (!same) return target;
  const rest = target.slice(home.length);
  if (rest === '') return '~';
  const separator = rest[0];
  if (separator === '/' || (win && separator === '\\')) return `~${rest}`;
  return target;
}

function describeFailure(result: RunResult): string {
  const firstLine =
    result.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? '';
  if (result.code === null) return shorten(firstLine || 'did not run');
  return shorten(firstLine ? `exit code ${result.code}: ${firstLine}` : `exit code ${result.code}`);
}

function shorten(text: string): string {
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
