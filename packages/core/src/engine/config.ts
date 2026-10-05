/**
 * Configuration (design §6): defaults < user config < project config < environment < flags,
 * recording where each effective value came from.
 *
 * The project layer comes from a cloned repository and is untrusted: it never chooses the
 * registry unless the value equals the user's own registry or the user trusted it for that
 * project (`trustedProjectRegistries` in the user config), and it is ignored entirely for
 * user-scope (-g) operations.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentHubError } from '../errors';
import { AGENT_IDS, type AgentHubConfig, type Scope } from '../types';
import type { ConfigSource, ResolvedConfig } from './api';
import {
  errnoCode,
  isNetworkPath,
  isWithin,
  readTextOrNull,
  samePath,
  WriteGuard,
  writeFileAtomic,
} from './fsutil';
import { CONFIG_FILE, findProjectRoot, STATE_DIR } from './state';

export const CONFIG_KEYS = ['registry', 'agents', 'channel', 'telemetry'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

const DEFAULTS: AgentHubConfig = { agents: 'detected', channel: 'stable', telemetry: false };

const REGISTRY_PATTERN = /^(https:\/\/.+|http:\/\/(localhost|127\.0\.0\.1)([:/].*)?$|file:.+)$/;

export const configSchema = z.strictObject({
  registry: z
    .string()
    .regex(
      REGISTRY_PATTERN,
      'registry must be https://…, http://localhost…, http://127.0.0.1… or file:<path>',
    )
    .optional(),
  agents: z.union([z.literal('detected'), z.array(z.enum(AGENT_IDS)).min(1)]).optional(),
  channel: z.enum(['stable', 'beta']).optional(),
  telemetry: z.boolean().optional(),
  /** User config only: project root (real path) -> registries that project's config may select. */
  trustedProjectRegistries: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
});

/** A config file as stored (the user file may also hold the trust list). */
type FileConfig = AgentHubConfig & { trustedProjectRegistries?: Record<string, string[]> };

export interface LoadConfigOptions {
  cwd: string;
  home: string;
  agenthubHome: string;
  env?: Record<string, string | undefined>;
  flags?: Partial<AgentHubConfig>;
  /** 'user': configuration for a user-scope (-g) operation, which never reads the project file. */
  scope?: Scope;
}

export interface LoadedConfig extends ResolvedConfig {
  projectRoot: string | null;
  userConfigPath: string;
  projectConfigPath: string | null;
  /** Problems with the project layer that were ignored (shown by plans and doctor). */
  warnings: string[];
  /** The registry the project config asked for but did not get, if any. */
  ignoredProjectRegistry?: string;
}

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Validate a config object; throws AgentHubError('VALIDATION') naming `origin`. */
export function validateConfig(raw: unknown, origin: string): FileConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentHubError('VALIDATION', `invalid config ${origin}: ${describe(parsed.error)}`, {
      path: origin,
    });
  }
  const out: FileConfig = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * `file:<relative>` resolves against `baseDir`; other registries are returned unchanged.
 * `file:///…` URLs are accepted. UNC, device and `//host` paths (and `file://host/…`) are refused
 * with VALIDATION: reading one makes Windows authenticate to that host.
 */
export function resolveRegistry(registry: string, baseDir: string): string {
  if (!registry.startsWith('file:')) return registry;
  let target = registry.slice('file:'.length);
  if (registry.startsWith('file://')) {
    // Only an empty host is local; `file:////host/share` is a UNC path in disguise.
    const rest = registry.slice('file://'.length);
    if (!rest.startsWith('/') || isNetworkPath(rest)) refuseNetwork(registry);
    try {
      target = fileURLToPath(registry);
    } catch (error) {
      throw new AgentHubError(
        'VALIDATION',
        `invalid file: registry ${registry}: ${error instanceof Error ? error.message : String(error)}`,
        { registry },
      );
    }
  }
  if (isNetworkPath(target)) refuseNetwork(registry);
  const resolved = path.resolve(baseDir, target);
  if (isNetworkPath(resolved)) refuseNetwork(registry);
  return `file:${resolved}`;
}

function refuseNetwork(registry: string): never {
  throw new AgentHubError(
    'VALIDATION',
    `the registry ${registry} is a network path; file: registries must be local folders`,
    { registry },
  );
}

/** Whether two registry ids name the same registry (trailing slashes, case of file paths). */
export function sameRegistry(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.startsWith('file:') && b.startsWith('file:')) {
    return samePath(a.slice('file:'.length), b.slice('file:'.length));
  }
  const norm = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return value.replace(/\/+$/, '');
    }
  };
  return norm(a) === norm(b);
}

function realOrResolved(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** Key of a project in `trustedProjectRegistries`: the real path of its root. */
export function projectTrustKey(projectRoot: string): string {
  return realOrResolved(projectRoot);
}

function readConfigFile(file: string): FileConfig | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw new AgentHubError('IO', `cannot read config ${file}: ${code ?? String(error)}`, {
      path: file,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new AgentHubError(
      'VALIDATION',
      `invalid config ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { path: file },
    );
  }
  return validateConfig(raw, file);
}

/** A `file:` registry from the project layer must stay inside the project after resolving links. */
function insideProject(projectRoot: string, registry: string): boolean {
  if (!registry.startsWith('file:')) return true;
  const target = registry.slice('file:'.length);
  if (!isWithin(projectRoot, target)) return false;
  const realRoot = realOrResolved(projectRoot);
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try {
      const real = realpathSync.native(current);
      return isWithin(realRoot, path.join(real, path.relative(current, target)));
    } catch {
      try {
        if (lstatSync(current).isSymbolicLink()) return false;
      } catch {
        // missing: look at the parent
      }
      if (path.dirname(current) === current) return false;
    }
  }
}

/** The project's config file, unless it is a link or not a regular file (then: a warning). */
function readProjectConfigFile(file: string, warnings: string[]): FileConfig | null {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) {
      warnings.push(`ignoring ${file}: it is a symlink, junction or not a regular file`);
      return null;
    }
  } catch {
    return null;
  }
  return readConfigFile(file);
}

/** Load and merge every configuration layer. */
export function loadConfig(opts: LoadConfigOptions): LoadedConfig {
  const projectRoot = findProjectRoot(opts.cwd, {
    home: opts.home,
    agenthubHome: opts.agenthubHome,
  });
  const userConfigPath = path.join(opts.agenthubHome, CONFIG_FILE);
  const projectConfigPath =
    projectRoot === null ? null : path.join(projectRoot, STATE_DIR, CONFIG_FILE);

  const effective: AgentHubConfig = {};
  const sources: Partial<Record<keyof AgentHubConfig, ConfigSource>> = {};
  const warnings: string[] = [];
  let ignoredProjectRegistry: string | undefined;
  const apply = (layer: AgentHubConfig | null | undefined, source: ConfigSource) => {
    if (!layer) return;
    for (const key of CONFIG_KEYS) {
      const value = layer[key];
      if (value === undefined) continue;
      (effective as Record<string, unknown>)[key] = value;
      sources[key] = source;
    }
  };

  const user = readConfigFile(userConfigPath);
  if (user?.registry !== undefined) {
    user.registry = resolveRegistry(user.registry, path.dirname(userConfigPath));
  }

  const env = opts.env ?? {};
  const envLayer: Record<string, unknown> = {};
  if (env.AGENTHUB_REGISTRY) envLayer.registry = env.AGENTHUB_REGISTRY;
  if (env.AGENTHUB_CHANNEL) envLayer.channel = env.AGENTHUB_CHANNEL;
  const fromEnv = validateConfig(envLayer, 'from the environment');
  if (fromEnv.registry !== undefined)
    fromEnv.registry = resolveRegistry(fromEnv.registry, opts.cwd);

  let fromFlags: FileConfig | undefined;
  if (opts.flags) {
    fromFlags = validateConfig(opts.flags, 'from command-line flags');
    if (fromFlags.registry !== undefined) {
      fromFlags.registry = resolveRegistry(fromFlags.registry, opts.cwd);
    }
  }

  let project: FileConfig | null = null;
  if (projectConfigPath !== null && projectRoot !== null && opts.scope !== 'user') {
    project = readProjectConfigFile(projectConfigPath, warnings);
    if (project) {
      delete project.trustedProjectRegistries;
      const raw = project.registry;
      delete project.registry;
      const overridden = fromEnv.registry !== undefined || fromFlags?.registry !== undefined;
      if (raw !== undefined && !overridden) {
        const verdict = projectRegistryVerdict({
          raw,
          projectRoot,
          projectConfigPath,
          userConfigPath,
          user,
        });
        if (verdict.use !== undefined) project.registry = verdict.use;
        if (verdict.warning !== undefined) {
          warnings.push(verdict.warning);
          ignoredProjectRegistry = raw;
        }
      }
    }
  }

  apply(DEFAULTS, 'default');
  apply(user, 'user');
  apply(project, 'project');
  apply(fromEnv, 'env');
  if (fromFlags) apply(fromFlags, 'flag');

  return {
    effective,
    sources,
    projectRoot,
    userConfigPath,
    projectConfigPath,
    warnings,
    ...(ignoredProjectRegistry === undefined ? {} : { ignoredProjectRegistry }),
  };
}

/** Decide whether a project config may select `raw` as the registry. */
function projectRegistryVerdict(args: {
  raw: string;
  projectRoot: string;
  projectConfigPath: string;
  userConfigPath: string;
  user: FileConfig | null;
}): { use?: string; warning?: string } {
  const { raw, projectRoot, projectConfigPath, userConfigPath, user } = args;
  const key = projectTrustKey(projectRoot);
  const howToTrust = `To use it, add it to "trustedProjectRegistries" in ${userConfigPath} as {${JSON.stringify(key)}: [${JSON.stringify(raw)}]}, or set AGENTHUB_REGISTRY.`;
  const ignore = (why: string) => ({
    warning: `ignoring "registry": ${JSON.stringify(raw)} in ${projectConfigPath}: ${why}. ${howToTrust}`,
  });
  let resolved: string;
  try {
    resolved = resolveRegistry(raw, path.dirname(projectConfigPath));
  } catch (error) {
    return ignore(error instanceof Error ? error.message : String(error));
  }
  if (!insideProject(projectRoot, resolved)) {
    return ignore('a file: registry named by a project must be a folder inside that project');
  }
  // Same as the user's own registry: nothing changes and the user layer stays the source.
  if (user?.registry !== undefined && sameRegistry(user.registry, resolved)) return {};
  const trusted = Object.entries(user?.trustedProjectRegistries ?? {})
    .filter(([root]) => samePath(realOrResolved(root), key))
    .flatMap(([, list]) => list);
  for (const value of trusted) {
    let candidate: string;
    try {
      candidate = resolveRegistry(value, path.dirname(projectConfigPath));
    } catch {
      continue;
    }
    if (sameRegistry(candidate, resolved)) return { use: resolved };
  }
  return ignore('a project cannot choose where agenthub downloads skills from');
}

/**
 * Trust `registry` (as written in the project's config) for the project at `projectRoot` by
 * adding it to `trustedProjectRegistries` in the user config file.
 */
export async function trustProjectRegistry(
  userConfigFile: string,
  projectRoot: string,
  registry: string,
): Promise<void> {
  const target = path.resolve(userConfigFile);
  const current = await readRawConfig(target);
  const key = projectTrustKey(projectRoot);
  const existing = validateConfig(current, target).trustedProjectRegistries ?? {};
  const list = [...(existing[key] ?? [])];
  if (!list.includes(registry)) list.push(registry);
  current.trustedProjectRegistries = { ...existing, [key]: list };
  await writeValidated(target, current);
}

async function readRawConfig(target: string): Promise<Record<string, unknown>> {
  const text = await readTextOrNull(target);
  if (text === null) return {};
  try {
    const raw: unknown = JSON.parse(text);
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return { ...(raw as Record<string, unknown>) };
    }
    return {};
  } catch (error) {
    throw new AgentHubError(
      'VALIDATION',
      `invalid config ${target}: ${error instanceof Error ? error.message : String(error)}`,
      { path: target },
    );
  }
}

async function writeValidated(target: string, current: Record<string, unknown>) {
  const validated = validateConfig(current, target);
  const guard = new WriteGuard([path.dirname(target)]);
  const sorted = Object.fromEntries(
    Object.entries(validated).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFileAtomic(guard, target, `${JSON.stringify(sorted, null, 2)}\n`);
  return validated;
}

function coerceValue(key: ConfigKey, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (key === 'telemetry') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  }
  if (key === 'agents') {
    if (value === 'detected') return value;
    return value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
  }
  return value;
}

/**
 * Set (or with `value === undefined`, unset) one key in a config file. The whole file is
 * validated before it is written atomically.
 */
export async function writeConfigValue(
  file: string,
  key: string,
  value: unknown,
): Promise<AgentHubConfig> {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new AgentHubError(
      'USAGE',
      `unknown config key "${key}" (known: ${CONFIG_KEYS.join(', ')})`,
    );
  }
  const configKey = key as ConfigKey;
  const target = path.resolve(file);
  const current = await readRawConfig(target);
  if (value === undefined) delete current[configKey];
  else current[configKey] = coerceValue(configKey, value);
  return writeValidated(target, current);
}
