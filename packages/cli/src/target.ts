/**
 * What `agenthub install <target>` points at: a skill folder, a .skillpkg file, or a
 * `name[@range]` in the configured registry.
 */
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { SourceSpec } from '@agenthub/core';
import { AgentHubError } from '@agenthub/core';

export type PathKind = 'dir' | 'file' | 'other' | null;

export type StatFn = (path: string) => Promise<PathKind>;

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RANGE_CHARS = /^[0-9A-Za-z.*^~<>=|+\- ]+$/;

export async function statKind(path: string): Promise<PathKind> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return 'dir';
    if (info.isFile()) return 'file';
    return 'other';
  } catch {
    return null;
  }
}

/** True for inputs that can only be meant as a path (./x, ../x, /x, ~/x, C:\x, x/y, x.skillpkg). */
export function looksLikePath(target: string): boolean {
  return (
    target.startsWith('.') ||
    target.startsWith('~') ||
    target.includes('/') ||
    target.includes('\\') ||
    isAbsolute(target) ||
    /^[A-Za-z]:/.test(target) ||
    target.toLowerCase().endsWith('.skillpkg')
  );
}

/**
 * A path-like argument is a local folder or .skillpkg file; anything else is a registry
 * `name[@range]`. A bare name never resolves to a local folder, even when one with that name
 * exists here: a cloned repository must not be able to substitute its own copy for a registry
 * skill the user asks for by name (`./name` installs the folder).
 */
export async function classifyTarget(
  target: string,
  opts: { cwd: string; stat?: StatFn },
): Promise<SourceSpec> {
  const statFn = opts.stat ?? statKind;
  if (target.trim() === '') throw new AgentHubError('USAGE', 'install target must not be empty');
  if (!looksLikePath(target)) return parseRegistrySpec(target);

  const abs = resolve(opts.cwd, target);
  const kind = await statFn(abs);
  if (kind === 'dir') return { kind: 'dir', path: abs };
  if (kind === 'file') {
    if (abs.toLowerCase().endsWith('.skillpkg')) return { kind: 'file', path: abs };
    throw new AgentHubError(
      'USAGE',
      `${target} is a file but not a .skillpkg package — pass a skill folder, a .skillpkg file or a skill name`,
    );
  }
  if (kind === 'other') {
    throw new AgentHubError('USAGE', `${target} is neither a folder nor a .skillpkg file`);
  }
  throw new AgentHubError('NOT_FOUND', `no such file or folder: ${abs}`, { path: abs });
}

/**
 * For a bare registry name: the local folder of the same name, if one exists (so the CLI can
 * point out that `./name` installs it). Null for path-like input or when nothing is there.
 */
export async function shadowedLocalPath(
  target: string,
  opts: { cwd: string; stat?: StatFn },
): Promise<string | null> {
  if (looksLikePath(target)) return null;
  const at = target.indexOf('@');
  const abs = resolve(opts.cwd, at === -1 ? target : target.slice(0, at));
  return (await (opts.stat ?? statKind)(abs)) === 'dir' ? abs : null;
}

/** `name` or `name@range`. */
export function parseRegistrySpec(target: string): SourceSpec {
  const at = target.indexOf('@');
  const name = at === -1 ? target : target.slice(0, at);
  const range = at === -1 ? undefined : target.slice(at + 1).trim();
  if (!NAME.test(name) || name.length > 64) {
    throw new AgentHubError(
      'USAGE',
      `"${target}" is not a folder, a .skillpkg file or a skill name (lowercase letters, digits and hyphens, optionally @version-range)`,
    );
  }
  if (range === undefined) return { kind: 'registry', name };
  if (range === '' || !RANGE_CHARS.test(range) || range.length > 128) {
    throw new AgentHubError('USAGE', `invalid version range in "${target}"`);
  }
  return { kind: 'registry', name, range };
}
