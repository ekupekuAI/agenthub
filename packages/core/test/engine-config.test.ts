import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentHubError, loadConfig, resolveVersion, writeConfigValue } from '../src/index';

let base: string;
let home: string;
let agenthubHome: string;
let project: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agenthub-config-'));
  home = join(base, 'home');
  agenthubHome = join(base, 'state');
  project = join(base, 'project');
  await mkdir(join(project, '.agenthub'), { recursive: true });
  await mkdir(agenthubHome, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('merges defaults < user < project < env < flags and records sources', async () => {
    await writeFile(
      join(agenthubHome, 'config.json'),
      JSON.stringify({ registry: 'https://user.example', channel: 'beta', telemetry: true }),
    );
    await writeFile(
      join(project, '.agenthub', 'config.json'),
      JSON.stringify({ registry: 'file:../skills-dev', agents: ['codex'] }),
    );
    const config = loadConfig({ cwd: project, home, agenthubHome, env: {} });
    expect(config.projectRoot).toBe(project);
    expect(config.effective).toEqual({
      registry: `file:${join(project, 'skills-dev')}`,
      agents: ['codex'],
      channel: 'beta',
      telemetry: true,
    });
    expect(config.sources).toEqual({
      registry: 'project',
      agents: 'project',
      channel: 'user',
      telemetry: 'user',
    });

    const overridden = loadConfig({
      cwd: project,
      home,
      agenthubHome,
      env: { AGENTHUB_REGISTRY: 'http://localhost:3000', AGENTHUB_CHANNEL: 'stable' },
      flags: { agents: ['cursor'] },
    });
    expect(overridden.effective.registry).toBe('http://localhost:3000');
    expect(overridden.sources).toMatchObject({ registry: 'env', channel: 'env', agents: 'flag' });
  });

  it('uses defaults outside a project', () => {
    const outside = loadConfig({ cwd: base, home, agenthubHome, env: {} });
    expect(outside.projectRoot).toBeNull();
    expect(outside.projectConfigPath).toBeNull();
    expect(outside.effective).toEqual({ agents: 'detected', channel: 'stable', telemetry: false });
  });

  it('rejects invalid values and unknown keys naming the file', async () => {
    await writeFile(
      join(agenthubHome, 'config.json'),
      JSON.stringify({ registry: 'http://evil.example' }),
    );
    let error: unknown;
    try {
      loadConfig({ cwd: project, home, agenthubHome, env: {} });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AgentHubError);
    expect((error as AgentHubError).code).toBe('VALIDATION');
    expect((error as AgentHubError).message).toContain('config.json');
    await writeFile(join(agenthubHome, 'config.json'), JSON.stringify({ regsitry: 'x' }));
    expect(() => loadConfig({ cwd: project, home, agenthubHome, env: {} })).toThrow(/regsitry/);
  });
});

describe('writeConfigValue', () => {
  it('sets, coerces and unsets values atomically after validation', async () => {
    const file = join(project, '.agenthub', 'config.json');
    await writeConfigValue(file, 'agents', 'claude-code, codex');
    await writeConfigValue(file, 'telemetry', 'false');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      agents: ['claude-code', 'codex'],
      telemetry: false,
    });
    await writeConfigValue(file, 'telemetry', undefined);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ agents: ['claude-code', 'codex'] });
    await expect(writeConfigValue(file, 'registry', 'ftp://nope')).rejects.toThrow(/registry/);
    await expect(writeConfigValue(file, 'colour', 'red')).rejects.toThrow(/unknown config key/);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ agents: ['claude-code', 'codex'] });
  });
});

describe('resolveVersion', () => {
  const versions = [
    { version: '1.0.0', digest: 'sha256:a', status: 'active' as const, agents: ['codex' as const] },
    { version: '1.2.0', digest: 'sha256:b', status: 'quarantined' as const },
    {
      version: '1.1.0',
      digest: 'sha256:c',
      status: 'active' as const,
      agents: ['claude-code' as const],
    },
    { version: '2.0.0-rc.1', digest: 'sha256:d', status: 'active' as const },
  ];

  it('honors status, channel, range and declared agents', () => {
    const pick = (opts: Parameters<typeof resolveVersion>[1]) => {
      const outcome = resolveVersion(versions, opts);
      return outcome.kind === 'ok' ? outcome.version.version : outcome.kind;
    };
    expect(pick({})).toBe('1.1.0');
    expect(pick({ channel: 'beta' })).toBe('2.0.0-rc.1');
    expect(pick({ agents: ['codex'] })).toBe('1.0.0');
    expect(pick({ range: '^1.2.0' })).toBe('none');
    expect(pick({ range: '1.2.0' })).toBe('none');
    expect(() => resolveVersion(versions, { range: 'not a range' })).toThrow(
      /invalid version range/,
    );
  });
});
