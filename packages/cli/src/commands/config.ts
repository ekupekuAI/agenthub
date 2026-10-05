import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentHubConfig } from '@agenthub/core';
import {
  AgentHubError,
  CONFIG_FILE,
  findProjectRoot,
  resolveRegistry,
  STATE_DIR,
  trustProjectRegistry,
  writeConfigValue,
} from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { normalizeRegistryUrl } from '../http-registry';
import { clean } from '../output';
import { confirm } from '../prompt';
import { loadEffectiveConfig, resolvePaths } from '../wiring';
import { parseAgentIds } from './options';

export const CONFIG_KEYS = ['registry', 'agents', 'channel', 'telemetry'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

function assertKey(key: string | undefined): ConfigKey {
  if (key === undefined || !(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new AgentHubError(
      'USAGE',
      `${key === undefined ? 'missing config key' : `unknown config key "${key}"`} (keys: ${CONFIG_KEYS.join(', ')})`,
    );
  }
  return key as ConfigKey;
}

export interface ConfigTarget {
  /** Where the user typed the command: relative folders are meant relative to it. */
  cwd: string;
  /** The config file being written; stored relative paths resolve against its folder. */
  file: string;
  /** Store a path relative to the config file (portable project config) instead of absolute. */
  relative: boolean;
}

/**
 * `file:<folder>` as typed (relative to the current folder, absolute, or a file:// URL), turned
 * into what the config file must hold so that core resolves it to the same folder: a path
 * relative to the config file's folder, or an absolute path.
 */
export function normalizeFileRegistry(value: string, target: ConfigTarget): string {
  let folder: string;
  if (value.startsWith('file://')) {
    try {
      folder = fileURLToPath(value);
    } catch {
      throw new AgentHubError('USAGE', `invalid file registry URL: ${value}`);
    }
  } else {
    folder = value.slice('file:'.length);
  }
  if (folder.trim() === '')
    throw new AgentHubError('USAGE', 'file registry path must not be empty');
  const abs = resolve(target.cwd, folder);
  if (!target.relative) return `file:${abs}`;
  const rel = relative(dirname(target.file), abs);
  if (rel === '' || isAbsolute(rel)) return `file:${abs}`;
  return `file:${rel.split(sep).join('/')}`;
}

/** Parses and validates a value given on the command line. */
export function parseConfigValue(
  key: ConfigKey,
  raw: string,
  target?: ConfigTarget,
): AgentHubConfig[ConfigKey] {
  const value = raw.trim();
  switch (key) {
    case 'registry': {
      if (value.startsWith('file:')) {
        if (value.length === 'file:'.length) {
          throw new AgentHubError('USAGE', 'file registry path must not be empty');
        }
        return target === undefined ? value : normalizeFileRegistry(value, target);
      }
      return normalizeRegistryUrl(value);
    }
    case 'agents':
      return value === 'detected' ? 'detected' : parseAgentIds(value);
    case 'channel':
      if (value !== 'stable' && value !== 'beta') {
        throw new AgentHubError('USAGE', 'channel must be "stable" or "beta"');
      }
      return value;
    case 'telemetry':
      if (value === 'true' || value === 'on' || value === 'yes') return true;
      if (value === 'false' || value === 'off' || value === 'no') return false;
      throw new AgentHubError('USAGE', 'telemetry must be true or false');
  }
}

function show(value: unknown): string {
  if (value === undefined) return '(not set)';
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

/**
 * The file `config set/unset` writes: the project config inside a project, the user config
 * with -g or outside one. Found without loading (and validating) the merged configuration, so
 * a broken config file can still be repaired with `config set/unset`.
 */
function configFileFor(ctx: CommandContext): { file: string; scope: 'user' | 'project' } {
  const paths = resolvePaths(ctx.env);
  const userFile = join(paths.agenthubHome, CONFIG_FILE);
  if (ctx.opts.global) return { file: userFile, scope: 'user' };
  const root = findProjectRoot(ctx.cwd, { home: paths.home, agenthubHome: paths.agenthubHome });
  return root === null
    ? { file: userFile, scope: 'user' }
    : { file: join(root, STATE_DIR, CONFIG_FILE), scope: 'project' };
}

export async function configCommand(
  ctx: CommandContext,
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
): Promise<CommandResult> {
  const s = ctx.out.style;
  if (action === 'set' || action === 'unset') return setOrUnset(ctx, action, key, value);
  if (action === 'trust-registry') return trustRegistry(ctx, key, value);

  const config = await loadEffectiveConfig({
    cwd: ctx.cwd,
    env: ctx.env,
    flags: ctx.configFlags(),
  });

  if (action === undefined) {
    const rows: Record<string, { value: unknown; source: string }> = {};
    for (const name of CONFIG_KEYS) {
      const effective = config.effective[name];
      const source = config.sources[name] ?? 'default';
      rows[name] = { value: effective ?? null, source };
      ctx.out.print(`${name.padEnd(10)} ${clean(show(effective))}  ${s.dim(`(${source})`)}`);
    }
    ctx.out.print();
    ctx.out.print(s.dim(`user config:    ${clean(config.userConfigPath)}`));
    if (config.projectConfigPath !== null) {
      ctx.out.print(s.dim(`project config: ${clean(config.projectConfigPath)}`));
    }
    for (const warning of config.warnings ?? []) ctx.out.warn(clean(warning));
    return {
      data: {
        values: rows,
        effective: config.effective,
        sources: config.sources,
        userConfigPath: config.userConfigPath,
        projectConfigPath: config.projectConfigPath,
        projectRoot: config.projectRoot,
      },
    };
  }

  if (action === 'get') {
    const name = assertKey(key);
    if (value !== undefined) throw new AgentHubError('USAGE', 'config get takes only a key');
    const effective = config.effective[name];
    const source = config.sources[name] ?? 'default';
    ctx.out.print(clean(show(effective)));
    return { data: { key: name, value: effective ?? null, source } };
  }

  throw new AgentHubError(
    'USAGE',
    `unknown config action "${action}" (get, set, unset or trust-registry)`,
  );
}

async function setOrUnset(
  ctx: CommandContext,
  action: 'set' | 'unset',
  key: string | undefined,
  value: string | undefined,
): Promise<CommandResult> {
  const s = ctx.out.style;
  const name = assertKey(key);
  const { file, scope } = configFileFor(ctx);
  if (action === 'set') {
    if (value === undefined) throw new AgentHubError('USAGE', `config set ${name} needs a value`);
    const parsed = parseConfigValue(name, value, {
      cwd: ctx.cwd,
      file,
      relative: scope === 'project',
    });
    if (!ctx.opts.dryRun) await writeConfigValue(file, name, parsed);
    ctx.out.print(
      `${s.green('✔')} ${name} = ${clean(show(parsed))}  ${s.dim(`(${scope}: ${clean(file)})`)}`,
    );
    if (name === 'registry' && typeof parsed === 'string') {
      const resolved = resolveRegistry(parsed, dirname(file));
      if (resolved !== parsed) ctx.out.print(s.dim(`  resolves to ${clean(resolved)}`));
      if (scope === 'project') {
        ctx.out.notice(
          'note: a registry in the project config is only used after you trust it in your user config (see "agenthub doctor"); use -g to set your own registry',
        );
      }
    }
    return { data: { key: name, value: parsed, scope, file, dryRun: ctx.opts.dryRun } };
  }
  if (value !== undefined) throw new AgentHubError('USAGE', 'config unset takes only a key');
  if (!ctx.opts.dryRun) await writeConfigValue(file, name, undefined);
  ctx.out.print(`${s.green('✔')} unset ${name}  ${s.dim(`(${scope}: ${clean(file)})`)}`);
  return { data: { key: name, value: null, scope, file, dryRun: ctx.opts.dryRun } };
}

/**
 * `config trust-registry`: lets this project's config choose the registry. A cloned repository
 * cannot do that on its own; the trust is recorded in the user config, for this project folder
 * and this registry value only.
 */
async function trustRegistry(
  ctx: CommandContext,
  extra: string | undefined,
  more: string | undefined,
): Promise<CommandResult> {
  if (extra !== undefined || more !== undefined) {
    throw new AgentHubError('USAGE', 'config trust-registry takes no arguments');
  }
  if (ctx.opts.global) {
    throw new AgentHubError('USAGE', 'trust-registry applies to the current project; drop -g');
  }
  const config = await loadEffectiveConfig({
    cwd: ctx.cwd,
    env: ctx.env,
    flags: ctx.configFlags(),
  });
  const s = ctx.out.style;
  if (config.projectRoot === null || config.projectConfigPath === null) {
    throw new AgentHubError('USAGE', 'not inside a project: there is no project config to trust');
  }
  const registry = config.ignoredProjectRegistry;
  if (registry === undefined) {
    const message =
      config.sources.registry === 'project'
        ? `the project registry ${clean(config.effective.registry)} is already trusted`
        : 'the project config does not set a registry that needs trust';
    ctx.out.print(message);
    return { data: { trusted: false, registry: config.effective.registry ?? null, message } };
  }
  ctx.out.print(s.bold('Trust a project registry'));
  ctx.out.print(`  project   ${clean(config.projectRoot)}`);
  ctx.out.print(`  config    ${clean(config.projectConfigPath)}`);
  ctx.out.print(`  registry  ${clean(registry)}`);
  ctx.out.print(
    s.dim('  Skills installed or updated in this project will be downloaded from this registry.'),
  );
  if (ctx.opts.dryRun) {
    ctx.out.progress('dry run: nothing was changed');
    return { data: { trusted: false, dryRun: true, registry } };
  }
  await confirm(`Trust ${clean(registry)} for this project?`, {
    ...ctx.confirmOptions(),
    defaultYes: false,
    required: true,
  });
  await trustProjectRegistry(config.userConfigPath, config.projectRoot, registry);
  const after = await loadEffectiveConfig({ cwd: ctx.cwd, env: ctx.env, flags: ctx.configFlags() });
  const active = after.sources.registry === 'project';
  ctx.out.print(
    active
      ? `${s.green('✔')} trusted; the project registry is now used`
      : `${s.yellow('!')} recorded, but the registry is still not used`,
  );
  for (const warning of after.warnings ?? []) ctx.out.warn(clean(warning));
  return {
    data: {
      trusted: true,
      active,
      registry,
      projectRoot: config.projectRoot,
      file: config.userConfigPath,
    },
  };
}
