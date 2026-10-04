import type { AgentHubConfig } from '@agenthub/core';
import { AgentHubError, writeConfigValue } from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { normalizeRegistryUrl } from '../http-registry';
import { clean } from '../output';
import { loadEffectiveConfig } from '../wiring';
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

/** Parses and validates a value given on the command line. */
export function parseConfigValue(key: ConfigKey, raw: string): AgentHubConfig[ConfigKey] {
  const value = raw.trim();
  switch (key) {
    case 'registry': {
      if (value.startsWith('file:')) {
        if (value.length === 'file:'.length) {
          throw new AgentHubError('USAGE', 'file registry path must not be empty');
        }
        return value;
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

export async function configCommand(
  ctx: CommandContext,
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
): Promise<CommandResult> {
  const config = await loadEffectiveConfig({
    cwd: ctx.cwd,
    env: ctx.env,
    flags: ctx.configFlags(),
  });
  const s = ctx.out.style;

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

  if (action === 'set' || action === 'unset') {
    const name = assertKey(key);
    const file =
      !ctx.opts.global && config.projectConfigPath !== null
        ? config.projectConfigPath
        : config.userConfigPath;
    const scope = file === config.userConfigPath ? 'user' : 'project';
    if (action === 'set') {
      if (value === undefined) throw new AgentHubError('USAGE', `config set ${name} needs a value`);
      const parsed = parseConfigValue(name, value);
      if (!ctx.opts.dryRun) await writeConfigValue(file, name, parsed);
      ctx.out.print(
        `${s.green('✔')} ${name} = ${clean(show(parsed))}  ${s.dim(`(${scope}: ${clean(file)})`)}`,
      );
      return { data: { key: name, value: parsed, scope, file, dryRun: ctx.opts.dryRun } };
    }
    if (value !== undefined) throw new AgentHubError('USAGE', 'config unset takes only a key');
    if (!ctx.opts.dryRun) await writeConfigValue(file, name, undefined);
    ctx.out.print(`${s.green('✔')} unset ${name}  ${s.dim(`(${scope}: ${clean(file)})`)}`);
    return { data: { key: name, value: null, scope, file, dryRun: ctx.opts.dryRun } };
  }

  throw new AgentHubError('USAGE', `unknown config action "${action}" (get, set or unset)`);
}
