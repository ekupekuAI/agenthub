import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DetectContext, InstallPlan, RunResult } from '@agenthub/core';
import { resolveRegistry } from '@agenthub/core';
import { describe, expect, it } from 'vitest';
import { normalizeFileRegistry, parseConfigValue } from '../src/commands/config';
import { parseAgentIds } from '../src/commands/options';
import {
  addClaudeRelocationWarning,
  adjustUnknownRequirements,
  createRegistry,
  createRequirementProbe,
  createWiring,
  DEFAULT_REGISTRY,
  firstVersionToken,
  loadEffectiveConfig,
  neutralProbeCwd,
  parseAgentsEnv,
  resolvePaths,
  withDefaultRegistry,
} from '../src/wiring';

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

/**
 * A context whose `which` resolves every name (so nothing is hidden by a missing PATH entry)
 * and a runner that records every execution.
 */
function everythingOnPath(
  outputs: Record<string, RunResult>,
  opts: { binDir?: string } = {},
): {
  ctx: DetectContext;
  ran: string[];
  runner: (file: string, args: string[]) => Promise<RunResult>;
} {
  const ran: string[] = [];
  const binDir = opts.binDir ?? join(tmpdir(), 'agenthub-probe-bin');
  return {
    ran,
    ctx: {
      home: '/home/test',
      env: {},
      platform: process.platform,
      async which(command) {
        return join(binDir, process.platform === 'win32' ? `${command}.exe` : command);
      },
      async run(command, args) {
        ran.push([command, ...args].join(' '));
        return { code: 0, stdout: '9.9.9', stderr: '' };
      },
      async exists() {
        return false;
      },
      async listDir() {
        return [];
      },
    },
    async runner(file, args) {
      ran.push([file, ...args].join(' '));
      const base = basename(file).replace(/\.exe$/i, '');
      return outputs[base] ?? { code: 1, stdout: '', stderr: 'unexpected' };
    },
  };
}

describe('requirement probe', () => {
  it('reports the running node version without running anything', async () => {
    const { ctx, ran, runner } = everythingOnPath({});
    const probe = createRequirementProbe(ctx, { cwd: process.cwd(), runner });
    expect(await probe.runtime('node')).toBe(process.versions.node);
    expect(await probe.runtime('nodejs')).toBe(process.versions.node);
    expect(ran).toEqual([]);
  });

  it('tries python3, python, then py with fixed arguments', async () => {
    const { ctx, ran, runner } = everythingOnPath({
      python3: { code: 1, stdout: '', stderr: 'Python was not found' },
      python: { code: 1, stdout: '', stderr: '' },
      py: { code: 0, stdout: 'Python 3.12.4\n', stderr: '' },
    });
    const probe = createRequirementProbe(ctx, { cwd: process.cwd(), runner });
    expect(await probe.runtime('python')).toBe('3.12.4');
    expect(ran.map((line) => basename(line))).toEqual([
      expect.stringMatching(/^python3(\.exe)? --version$/),
      expect.stringMatching(/^python(\.exe)? --version$/),
      expect.stringMatching(/^py(\.exe)? --version$/),
    ]);
  });

  it('version-probes only allowlisted runtimes, each with fixed arguments', async () => {
    const { ctx, ran, runner } = everythingOnPath({
      deno: { code: 0, stdout: 'deno 2.1.4 (stable)', stderr: '' },
      go: { code: 0, stdout: 'go version go1.23.2 linux/amd64', stderr: '' },
      java: { code: 0, stdout: '', stderr: 'openjdk version "21.0.2" 2024-01-16' },
    });
    const probe = createRequirementProbe(ctx, { cwd: process.cwd(), runner });
    expect(await probe.runtime('deno')).toBe('2.1.4');
    expect(await probe.runtime('go')).toBe('1.23.2');
    expect(await probe.runtime('java')).toBe('21.0.2');
    expect(ran.map((line) => basename(line))).toEqual([
      expect.stringMatching(/^deno(\.exe)? --version$/),
      expect.stringMatching(/^go(\.exe)? version$/),
      expect.stringMatching(/^java(\.exe)? -version$/),
    ]);
  });

  it('never executes a program named by a manifest that is not on the allowlist', async () => {
    const { ctx, ran, runner } = everythingOnPath({});
    const probe = createRequirementProbe(ctx, { cwd: process.cwd(), runner });
    for (const name of ['yarn', 'mvn', 'calc', 'shutdown', 'shutdown.exe', 'evilrt', 'php']) {
      expect(await probe.runtime(name)).toBeNull();
      // Present on PATH, so it is reported as "cannot be checked", not as missing.
      expect(probe.unknown(name)).toMatch(/does not run/);
    }
    expect(await probe.runtime('../evil')).toBeNull();
    expect(probe.unknown('../evil')).toBeUndefined();
    expect(ran).toEqual([]);
    // Commands are looked up on PATH, never run.
    expect(await probe.command('evilrt')).toBe(true);
    expect(await probe.command('/bin/sh')).toBe(false);
    expect(ran).toEqual([]);
  });

  it('reports an absent non-allowlisted runtime as missing (no execution)', async () => {
    const { ctx, ran, runner } = everythingOnPath({});
    const probe = createRequirementProbe(
      { ...ctx, which: async () => null },
      { cwd: process.cwd(), runner },
    );
    expect(await probe.runtime('php')).toBeNull();
    expect(probe.unknown('php')).toBeUndefined();
    expect(ran).toEqual([]);
  });

  it('does not run allowlisted runtimes resolved inside the project or the working directory', async () => {
    const project = await mkdtemp(join(tmpdir(), 'agenthub-probe-project-'));
    try {
      const { ctx, ran, runner } = everythingOnPath(
        { deno: { code: 0, stdout: 'deno 2.1.4', stderr: '' } },
        { binDir: join(project, 'node_modules', '.bin') },
      );
      const inCwd = createRequirementProbe(ctx, { cwd: project, runner });
      expect(await inCwd.runtime('deno')).toBeNull();
      expect(inCwd.unknown('deno')).toMatch(/inside the project/);
      const inProject = createRequirementProbe(ctx, {
        cwd: tmpdir(),
        projectRoot: () => project,
        runner,
      });
      expect(await inProject.runtime('deno')).toBeNull();
      expect(inProject.unknown('deno')).toMatch(/inside the project/);
      expect(ran).toEqual([]);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('runs probes from a neutral folder', () => {
    const cwd = neutralProbeCwd();
    expect(cwd).not.toBe(process.cwd());
    expect(isAbsolute(cwd)).toBe(true);
  });

  it('turns an unknown-runtime blocker into an unchecked requirement with a hint', () => {
    const plan = {
      skill: { name: 'demo', version: '1.0.0', digest: 'sha256:x' },
      requirements: [
        { kind: 'runtime', name: 'php', constraint: '>=8', found: null, ok: false },
        { kind: 'runtime', name: 'ruby', constraint: '>=3', found: null, ok: false },
      ],
      blockers: [
        { code: 'INCOMPATIBLE', message: 'demo requires php >=8, php was not found' },
        { code: 'INCOMPATIBLE', message: 'demo requires ruby >=3, ruby was not found' },
      ],
      hints: [],
    } as unknown as InstallPlan;
    const adjusted = adjustUnknownRequirements(plan, {
      unknown: (name) => (name === 'php' ? 'agenthub does not run php' : undefined),
    });
    expect(adjusted.requirements[0]).toMatchObject({ name: 'php', ok: null });
    expect(adjusted.requirements[1]).toMatchObject({ name: 'ruby', ok: false });
    expect(adjusted.blockers.map((b) => b.message)).toEqual([
      'demo requires ruby >=3, ruby was not found',
    ]);
    expect(adjusted.hints.join('\n')).toMatch(/php/);
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

  it('refuses network file registries from project config', () => {
    const unc = [
      'file://attacker.example/share',
      'file:\\\\attacker.example\\share\\',
      'file://///attacker.example/share',
    ];
    for (const value of unc) {
      expect(() => createRegistry(value, tmpdir()), value).toThrow(
        expect.objectContaining({ code: 'USAGE' }),
      );
    }
    if (process.platform === 'win32') {
      // What a project config's `file://host/share` turns into (core may refuse it first).
      expect(() =>
        createRegistry(
          resolveRegistry('file://attacker.example/share', 'C:/repo/.agenthub'),
          tmpdir(),
        ),
      ).toThrow(/network path/);
    }
    // Local folders are fine.
    expect(createRegistry(`file:${tmpdir()}`, tmpdir()).id).toContain('file:');
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

  it('stores file registries so they resolve to the folder the user meant', () => {
    const project = resolve(tmpdir(), 'cfg-project');
    const file = join(project, '.agenthub', 'config.json');
    const cwd = project;
    const expected = `file:${join(project, 'reg')}`;
    // Relative to where the command was typed, stored relative to the config file.
    const stored = normalizeFileRegistry('file:./reg', { cwd, file, relative: true });
    expect(stored).toBe('file:../reg');
    expect(resolveRegistry(stored, dirname(file))).toBe(expected);
    // file:// URLs become paths.
    const url = pathToFileURL(join(project, 'reg')).href;
    expect(
      resolveRegistry(normalizeFileRegistry(url, { cwd, file, relative: true }), dirname(file)),
    ).toBe(expected);
    // User config: absolute.
    expect(normalizeFileRegistry('file:reg', { cwd, file, relative: false })).toBe(expected);
    expect(() => normalizeFileRegistry('file:', { cwd, file, relative: false })).toThrow(/empty/);
  });
});

describe('plan checks', () => {
  const userPlan = (agents: string[]) =>
    ({
      scope: 'user',
      targets: [{ dir: '.claude/skills', agents, action: 'create' }],
      issues: [],
    }) as unknown as InstallPlan;

  it('warns when $CLAUDE_CONFIG_DIR moves the user skills folder of claude-code', () => {
    const moved = { skillsDir: '/elsewhere/claude/skills' };
    const warned = addClaudeRelocationWarning(userPlan(['claude-code']), moved);
    expect(warned.issues).toEqual([
      expect.objectContaining({ level: 'warning', code: 'agent.claude-config-dir' }),
    ]);
    expect(warned.issues[0]?.message).toContain('/elsewhere/claude/skills');
    expect(addClaudeRelocationWarning(userPlan(['claude-code']), undefined).issues).toEqual([]);
    expect(addClaudeRelocationWarning(userPlan(['cursor']), moved).issues).toEqual([]);
    const project = { ...userPlan(['claude-code']), scope: 'project' } as InstallPlan;
    expect(addClaudeRelocationWarning(project, moved).issues).toEqual([]);
  });
});

describe('default registry', () => {
  const PUBLIC = 'https://registry.example.com';

  /** A project (with .git) and private AGENTHUB_HOME / user home folders. */
  async function world(): Promise<{
    base: string;
    project: string;
    env: Record<string, string | undefined>;
  }> {
    const base = await mkdtemp(join(tmpdir(), 'agenthub-default-registry-'));
    const project = join(base, 'project');
    await mkdir(join(project, '.git'), { recursive: true });
    await mkdir(join(base, 'home'), { recursive: true });
    const env = {
      AGENTHUB_HOME: join(base, 'state'),
      AGENTHUB_USER_HOME: join(base, 'home'),
      AGENTHUB_AGENTS: 'claude-code',
    };
    return { base, project, env };
  }

  it('has no built-in default in dev and test builds', () => {
    expect(DEFAULT_REGISTRY).toBeUndefined();
  });

  it('is used with source "default" when nothing configures a registry', async () => {
    const { base, project, env } = await world();
    try {
      const config = await loadEffectiveConfig({ cwd: project, env, defaultRegistry: PUBLIC });
      expect(config.effective.registry).toBe(PUBLIC);
      expect(config.sources.registry).toBe('default');
      const wiring = await createWiring({ cwd: project, env, defaultRegistry: PUBLIC });
      expect(wiring.registry?.id).toBe(PUBLIC);
      expect(wiring.registrySource).toBe('default');
      expect(wiring.registryError).toBeUndefined();
      // No default: no registry at all.
      const none = await createWiring({ cwd: project, env, defaultRegistry: null });
      expect(none.registry).toBeNull();
      expect(none.registrySource).toBeUndefined();
      const built = await createWiring({ cwd: project, env });
      expect(built.registry).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('loses to any configured registry', async () => {
    const { base, project, env } = await world();
    try {
      const fromEnv = await loadEffectiveConfig({
        cwd: project,
        env: { ...env, AGENTHUB_REGISTRY: 'https://env.example.com' },
        defaultRegistry: PUBLIC,
      });
      expect(fromEnv.effective.registry).toBe('https://env.example.com');
      expect(fromEnv.sources.registry).toBe('env');

      const fromFlag = await loadEffectiveConfig({
        cwd: project,
        env,
        flags: { registry: 'https://flag.example.com' },
        defaultRegistry: PUBLIC,
      });
      expect(fromFlag.sources.registry).toBe('flag');

      await mkdir(env.AGENTHUB_HOME as string, { recursive: true });
      await writeFile(
        join(env.AGENTHUB_HOME as string, 'config.json'),
        JSON.stringify({ registry: 'https://user.example.com' }),
      );
      const fromUser = await createWiring({ cwd: project, env, defaultRegistry: PUBLIC });
      expect(fromUser.registry?.id).toBe('https://user.example.com');
      expect(fromUser.registrySource).toBe('user');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('never lets an untrusted project registry replace it', async () => {
    const { base, project, env } = await world();
    try {
      await mkdir(join(project, '.agenthub', 'reg'), { recursive: true });
      await writeFile(
        join(project, '.agenthub', 'config.json'),
        JSON.stringify({ registry: 'file:./reg' }),
      );
      const config = await loadEffectiveConfig({ cwd: project, env, defaultRegistry: PUBLIC });
      expect(config.effective.registry).toBe(PUBLIC);
      expect(config.sources.registry).toBe('default');
      expect(config.ignoredProjectRegistry).toBe('file:./reg');
      expect(config.warnings?.join(' ')).toContain('ignoring "registry"');
      const wiring = await createWiring({ cwd: project, env, defaultRegistry: PUBLIC });
      expect(wiring.registry?.id).toBe(PUBLIC);
      expect(wiring.registrySource).toBe('default');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('leaves a configured registry untouched', () => {
    const loaded = {
      effective: { registry: 'file:/somewhere' },
      sources: { registry: 'user' as const },
      projectRoot: null,
      userConfigPath: '/u/config.json',
      projectConfigPath: null,
      warnings: [],
    };
    expect(withDefaultRegistry(loaded, PUBLIC)).toBe(loaded);
    expect(
      withDefaultRegistry({ ...loaded, effective: {}, sources: {} }, undefined).effective,
    ).toEqual({});
  });
});
