/**
 * Configuration (design §6): defaults < user config < project config < environment < flags,
 * recording where each effective value came from.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AgentHubError } from '../errors';
import { AGENT_IDS, type AgentHubConfig } from '../types';
import type { ConfigSource, ResolvedConfig } from './api';
import { errnoCode, readTextOrNull, WriteGuard, writeFileAtomic } from './fsutil';
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
});

export interface LoadConfigOptions {
  cwd: string;
  home: string;
  agenthubHome: string;
  env?: Record<string, string | undefined>;
  flags?: Partial<AgentHubConfig>;
}

export interface LoadedConfig extends ResolvedConfig {
  projectRoot: string | null;
  userConfigPath: string;
  projectConfigPath: string | null;
}

function describe(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Validate a config object; throws AgentHubError('VALIDATION') naming `origin`. */
export function validateConfig(raw: unknown, origin: string): AgentHubConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentHubError('VALIDATION', `invalid config ${origin}: ${describe(parsed.error)}`, {
      path: origin,
    });
  }
  const out: AgentHubConfig = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** `file:<relative>` resolves against `baseDir`; other registries are returned unchanged. */
export function resolveRegistry(registry: string, baseDir: string): string {
  if (!registry.startsWith('file:')) return registry;
  const target = registry.slice('file:'.length);
  return `file:${path.resolve(baseDir, target)}`;
}

function readConfigFile(file: string): AgentHubConfig | null {
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
  const config = validateConfig(raw, file);
  if (config.registry !== undefined)
    config.registry = resolveRegistry(config.registry, path.dirname(file));
  return config;
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
  const apply = (layer: AgentHubConfig | null | undefined, source: ConfigSource) => {
    if (!layer) return;
    for (const key of CONFIG_KEYS) {
      const value = layer[key];
      if (value === undefined) continue;
      (effective as Record<string, unknown>)[key] = value;
      sources[key] = source;
    }
  };

  apply(DEFAULTS, 'default');
  apply(readConfigFile(userConfigPath), 'user');
  if (projectConfigPath !== null) apply(readConfigFile(projectConfigPath), 'project');

  const env = opts.env ?? {};
  const envLayer: Record<string, unknown> = {};
  if (env.AGENTHUB_REGISTRY) envLayer.registry = env.AGENTHUB_REGISTRY;
  if (env.AGENTHUB_CHANNEL) envLayer.channel = env.AGENTHUB_CHANNEL;
  const fromEnv = validateConfig(envLayer, 'from the environment');
  if (fromEnv.registry !== undefined)
    fromEnv.registry = resolveRegistry(fromEnv.registry, opts.cwd);
  apply(fromEnv, 'env');

  if (opts.flags) {
    const fromFlags = validateConfig(opts.flags, 'from command-line flags');
    if (fromFlags.registry !== undefined) {
      fromFlags.registry = resolveRegistry(fromFlags.registry, opts.cwd);
    }
    apply(fromFlags, 'flag');
  }

  return { effective, sources, projectRoot, userConfigPath, projectConfigPath };
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
  const text = await readTextOrNull(target);
  let current: Record<string, unknown> = {};
  if (text !== null) {
    try {
      const raw: unknown = JSON.parse(text);
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        current = { ...(raw as Record<string, unknown>) };
      }
    } catch (error) {
      throw new AgentHubError(
        'VALIDATION',
        `invalid config ${target}: ${error instanceof Error ? error.message : String(error)}`,
        { path: target },
      );
    }
  }
  if (value === undefined) delete current[configKey];
  else current[configKey] = coerceValue(configKey, value);
  const validated = validateConfig(current, target);
  const guard = new WriteGuard([path.dirname(target)]);
  const sorted = Object.fromEntries(
    Object.entries(validated).sort(([a], [b]) => a.localeCompare(b)),
  );
  await writeFileAtomic(guard, target, `${JSON.stringify(sorted, null, 2)}\n`);
  return validated;
}
