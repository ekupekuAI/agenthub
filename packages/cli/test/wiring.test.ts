import type { DetectContext, RunResult } from '@agenthub/core';
import { describe, expect, it } from 'vitest';
import { parseConfigValue } from '../src/commands/config';
import { parseAgentIds } from '../src/commands/options';
import {
  createRegistry,
  createRequirementProbe,
  firstVersionToken,
  parseAgentsEnv,
  resolvePaths,
} from '../src/wiring';

function fakeContext(commands: Record<string, RunResult>): DetectContext & { ran: string[] } {
  const ran: string[] = [];
  return {
    home: '/home/test',
    env: {},
    platform: 'linux',
    ran,
    async which(command) {
      return command in commands ? `/usr/bin/${command}` : null;
    },
    async run(command, args) {
      ran.push([command, ...args].join(' '));
      const name = command.split('/').pop() ?? command;
      return commands[name] ?? { code: null, stdout: '', stderr: 'not found' };
    },
    async exists() {
      return false;
    },
    async listDir() {
      return [];
    },
  };
}

describe('AGENTHUB_AGENTS', () => {
  it('synthesizes agent environments with optional confidence', () => {
    const agents = parseAgentsEnv('claude-code, codex:medium,,cursor:low,codex');
    expect(agents.map((a) => [a.id, a.confidence])).toEqual([
      ['claude-code', 'high'],
      ['codex', 'medium'],
      ['cursor', 'low'],
    ]);
    expect(agents[0]?.evidence).toEqual(['from AGENTHUB_AGENTS']);
  });

  it('rejects unknown agents and confidences', () => {
    expect(() => parseAgentsEnv('notepad')).toThrow(/unknown agent/);
    expect(() => parseAgentsEnv('codex:certain')).toThrow(/invalid confidence/);
  });
});

describe('--agent', () => {
  it('validates against the known agent ids', () => {
    expect(parseAgentIds('vscode,claude-code,vscode')).toEqual(['vscode', 'claude-code']);
    expect(() => parseAgentIds('emacs')).toThrow(/unknown agent/);
    expect(() => parseAgentIds(',')).toThrow(/at least one/);
  });
});

describe('requirement probe', () => {
  it('reports the running node version', async () => {
    const probe = createRequirementProbe(fakeContext({}));
    expect(await probe.runtime('node')).toBe(process.versions.node);
  });

  it('tries python3, python, then py', async () => {
    const ctx = fakeContext({ py: { code: 0, stdout: 'Python 3.12.4\n', stderr: '' } });
    const probe = createRequirementProbe(ctx);
    expect(await probe.runtime('python')).toBe('3.12.4');
  });

  it('reads other runtimes from <cmd> --version and never runs unsafe names', async () => {
    const ctx = fakeContext({ deno: { code: 0, stdout: 'deno 2.1.4 (stable)', stderr: '' } });
    const probe = createRequirementProbe(ctx);
    expect(await probe.runtime('deno')).toBe('2.1.4');
    expect(await probe.runtime('../evil')).toBeNull();
    expect(await probe.runtime('shutdown')).toBeNull();
    expect(ctx.ran.every((line) => !line.includes('evil') && !line.includes('shutdown'))).toBe(
      true,
    );
    expect(await probe.command('deno')).toBe(true);
    expect(await probe.command('/bin/sh')).toBe(false);
  });

  it('extracts the first version token', () => {
    expect(firstVersionToken('v22.11.0')).toBe('22.11.0');
    expect(firstVersionToken('version 7')).toBe('7');
    expect(firstVersionToken('none')).toBeNull();
  });
});

describe('registry and paths', () => {
  it('refuses unsupported or insecure registries', () => {
    expect(() => createRegistry('ftp://example.com', '/')).toThrow(/unsupported registry/);
    expect(() => createRegistry('http://example.com', '/')).toThrow(/https/);
    expect(createRegistry('https://registry.example.com/', '/').id).toBe(
      'https://registry.example.com',
    );
  });

  it('honors AGENTHUB_USER_HOME and AGENTHUB_HOME', () => {
    const paths = resolvePaths({ AGENTHUB_USER_HOME: '/tmp/h', AGENTHUB_HOME: '/tmp/s' });
    expect(paths.home.replaceAll('\\', '/')).toMatch(/\/tmp\/h$/);
    expect(paths.agenthubHome.replaceAll('\\', '/')).toMatch(/\/tmp\/s$/);
  });

  it('validates config values', () => {
    expect(parseConfigValue('agents', 'codex,cursor')).toEqual(['codex', 'cursor']);
    expect(parseConfigValue('agents', 'detected')).toBe('detected');
    expect(parseConfigValue('telemetry', 'false')).toBe(false);
    expect(() => parseConfigValue('channel', 'nightly')).toThrow(/stable/);
    expect(() => parseConfigValue('registry', 'http://example.com')).toThrow(/https/);
  });
});
