import type { DetectContext, RunResult } from '@agenthub/core';
import { describe, expect, it } from 'vitest';
import {
  claudeUserSkillsRelocation,
  DETECT_TIMEOUT_MS,
  detectAgents,
  getAdapter,
  parseVersion,
} from '../src/index';

const HOME = '/home/dev';

interface FakeOptions {
  env?: Record<string, string | undefined>;
  /** command -> resolved path */
  executables?: Record<string, string>;
  /** resolved path -> result (or an error to throw) */
  runs?: Record<string, RunResult | Error>;
  /** absolute paths that exist */
  paths?: string[];
  /** absolute dir -> entries */
  listings?: Record<string, string[]>;
  whichThrows?: boolean;
}

interface RunCall {
  command: string;
  args: string[];
  timeoutMs: number;
}

function fakeContext(options: FakeOptions = {}): DetectContext & { runCalls: RunCall[] } {
  const runCalls: RunCall[] = [];
  return {
    home: HOME,
    env: options.env ?? {},
    platform: 'linux',
    runCalls,
    async which(command) {
      if (options.whichThrows) throw new Error('PATH unreadable');
      return options.executables?.[command] ?? null;
    },
    async run(command, args, timeoutMs) {
      runCalls.push({ command, args, timeoutMs });
      const result = options.runs?.[command];
      if (result instanceof Error) throw result;
      return result ?? { code: null, stdout: '', stderr: 'not scripted' };
    },
    async exists(path) {
      return options.paths?.includes(path) ?? false;
    },
    async listDir(path) {
      return options.listings?.[path] ?? [];
    },
  };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });

describe('parseVersion', () => {
  it('takes the first major.minor[.patch] token', () => {
    expect(parseVersion('2.1.3 (Claude Code)')).toBe('2.1.3');
    expect(parseVersion('codex-cli 0.46.0')).toBe('0.46.0');
    expect(parseVersion('1.105.1\n7d842fb85a0275a4a8e4d7e040d2625abbf7f084\nx64')).toBe('1.105.1');
    expect(parseVersion('v24.1')).toBe('24.1');
  });

  it('returns undefined when there is no version', () => {
    expect(parseVersion('')).toBeUndefined();
    expect(parseVersion('command not found')).toBeUndefined();
  });

  it('stays fast on a 1 MiB run of digits (no quadratic backtracking)', () => {
    const started = performance.now();
    expect(parseVersion('1'.repeat(1024 * 1024))).toBeUndefined();
    expect(parseVersion(`${'1'.repeat(1024 * 1024)}.2`)).toBeUndefined();
    expect(parseVersion('9'.repeat(200_000).split('').join(' '))).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('only looks at the start of the output', () => {
    expect(parseVersion(`${'x'.repeat(10_000)} 1.2.3`)).toBeUndefined();
    expect(parseVersion('tool 1.2.3.4')).toBe('1.2.3');
  });
});

describe('claude-code detection', () => {
  const claude = getAdapter('claude-code');

  it('is high when claude --version answers', async () => {
    const ctx = fakeContext({
      executables: { claude: '/home/dev/.local/bin/claude' },
      runs: { '/home/dev/.local/bin/claude': ok('2.1.3 (Claude Code)\n') },
      paths: ['/home/dev/.claude'],
    });
    const env = await claude.detect(ctx);
    expect(env).toEqual({
      id: 'claude-code',
      displayName: 'Claude Code',
      confidence: 'high',
      version: '2.1.3',
      executable: '/home/dev/.local/bin/claude',
      evidence: [
        'found claude at ~/.local/bin/claude',
        'claude --version → 2.1.3',
        'found ~/.claude',
      ],
      status: 'verified',
    });
    expect(ctx.runCalls).toEqual([
      { command: '/home/dev/.local/bin/claude', args: ['--version'], timeoutMs: DETECT_TIMEOUT_MS },
    ]);
    expect(DETECT_TIMEOUT_MS).toBe(5000);
  });

  it('is medium when the executable exists but --version fails', async () => {
    const ctx = fakeContext({
      executables: { claude: '/usr/bin/claude' },
      runs: { '/usr/bin/claude': { code: null, stdout: '', stderr: 'timed out after 5000 ms' } },
    });
    const env = await claude.detect(ctx);
    expect(env?.confidence).toBe('medium');
    expect(env?.version).toBeUndefined();
    expect(env?.executable).toBe('/usr/bin/claude');
    expect(env?.evidence).toContain('claude --version failed: timed out after 5000 ms');
  });

  it('is medium when run() throws, and does not throw itself', async () => {
    const ctx = fakeContext({
      executables: { claude: '/usr/bin/claude' },
      runs: { '/usr/bin/claude': new Error('spawn EACCES') },
    });
    const env = await claude.detect(ctx);
    expect(env?.confidence).toBe('medium');
    expect(env?.evidence).toContain('claude --version failed: spawn EACCES');
  });

  it('is medium when --version exits non-zero', async () => {
    const ctx = fakeContext({
      executables: { claude: '/usr/bin/claude' },
      runs: { '/usr/bin/claude': { code: 1, stdout: '9.9.9', stderr: 'boom\n' } },
    });
    const env = await claude.detect(ctx);
    expect(env?.confidence).toBe('medium');
    expect(env?.version).toBeUndefined();
    expect(env?.evidence).toContain('claude --version failed: exit code 1: boom');
  });

  it('is medium when --version prints no version', async () => {
    const ctx = fakeContext({
      executables: { claude: '/usr/bin/claude' },
      runs: { '/usr/bin/claude': ok('Claude Code\n') },
    });
    const env = await claude.detect(ctx);
    expect(env?.confidence).toBe('medium');
    expect(env?.evidence).toContain('claude --version printed no version');
  });

  it('is medium from CLAUDE_CONFIG_DIR alone', async () => {
    const ctx = fakeContext({ env: { CLAUDE_CONFIG_DIR: '/cfg/claude' }, paths: ['/cfg/claude'] });
    const env = await claude.detect(ctx);
    expect(env?.confidence).toBe('medium');
    expect(env?.executable).toBeUndefined();
    expect(env?.evidence[0]).toBe('found $CLAUDE_CONFIG_DIR (/cfg/claude)');
    expect(ctx.runCalls).toEqual([]);
  });

  it('warns when CLAUDE_CONFIG_DIR moves the user skills folder away from ~/.claude', async () => {
    const ctx = fakeContext({
      env: { CLAUDE_CONFIG_DIR: '/cfg/claude' },
      paths: ['/cfg/claude', '/home/dev/.claude'],
    });
    expect(claudeUserSkillsRelocation(ctx)).toEqual({
      configDir: '/cfg/claude',
      skillsDir: '/cfg/claude/skills',
    });
    const env = await claude.detect(ctx);
    expect(env?.evidence).toContain(
      '$CLAUDE_CONFIG_DIR moves the user skills folder to /cfg/claude/skills; user-scope installs to ~/.claude/skills are not loaded',
    );
  });

  it('does not warn when CLAUDE_CONFIG_DIR is unset, relative or ~/.claude', async () => {
    for (const value of [undefined, 'relative/dir', '~/.claude', '/home/dev/.claude/']) {
      const ctx = fakeContext({ env: { CLAUDE_CONFIG_DIR: value }, paths: ['/home/dev/.claude'] });
      expect(claudeUserSkillsRelocation(ctx), String(value)).toBeUndefined();
      const env = await claude.detect(ctx);
      expect(env?.evidence.some((line) => line.includes('moves'))).toBe(false);
    }
  });

  it('is null without any evidence, even if which() throws', async () => {
    expect(await claude.detect(fakeContext())).toBeNull();
    expect(await claude.detect(fakeContext({ whichThrows: true }))).toBeNull();
    // CLAUDE_CONFIG_DIR set but missing on disk is not evidence.
    expect(await claude.detect(fakeContext({ env: { CLAUDE_CONFIG_DIR: '/nope' } }))).toBeNull();
  });
});

describe('codex detection', () => {
  const codex = getAdapter('codex');

  it('is high when codex --version answers', async () => {
    const ctx = fakeContext({
      executables: { codex: '/usr/local/bin/codex' },
      runs: { '/usr/local/bin/codex': ok('codex-cli 0.46.0\n') },
    });
    const env = await codex.detect(ctx);
    expect(env?.confidence).toBe('high');
    expect(env?.version).toBe('0.46.0');
    expect(env?.evidence).toContain('codex --version → 0.46.0');
  });

  it('is medium from ~/.codex or $CODEX_HOME alone', async () => {
    const home = await codex.detect(fakeContext({ paths: ['/home/dev/.codex'] }));
    expect(home?.confidence).toBe('medium');
    expect(home?.evidence).toEqual(['found ~/.codex']);

    const relocated = await codex.detect(
      fakeContext({ env: { CODEX_HOME: '~/work/codex' }, paths: ['/home/dev/work/codex'] }),
    );
    expect(relocated?.confidence).toBe('medium');
    expect(relocated?.evidence).toEqual(['found $CODEX_HOME (~/work/codex)']);
  });

  it('is null without any evidence', async () => {
    expect(await codex.detect(fakeContext())).toBeNull();
  });
});

describe('cursor detection', () => {
  const cursor = getAdapter('cursor');

  it('is high when cursor --version answers (first line is the version)', async () => {
    const ctx = fakeContext({
      executables: { cursor: '/opt/cursor/bin/cursor' },
      runs: { '/opt/cursor/bin/cursor': ok('3.15.6\nabc1234\nx64\n') },
      paths: ['/home/dev/.cursor'],
    });
    const env = await cursor.detect(ctx);
    expect(env?.confidence).toBe('high');
    expect(env?.version).toBe('3.15.6');
    expect(env?.evidence).toEqual([
      'found cursor at /opt/cursor/bin/cursor',
      'cursor --version → 3.15.6',
      'found ~/.cursor',
    ]);
  });

  it('is medium from ~/.cursor alone', async () => {
    const env = await cursor.detect(fakeContext({ paths: ['/home/dev/.cursor'] }));
    expect(env?.confidence).toBe('medium');
    expect(env?.evidence).toEqual(['found ~/.cursor']);
  });

  it('is null without any evidence', async () => {
    expect(await cursor.detect(fakeContext())).toBeNull();
  });
});

describe('vscode detection', () => {
  const vscode = getAdapter('vscode');
  const extensions = '/home/dev/.vscode/extensions';
  const codeFound = {
    executables: { code: '/usr/bin/code' },
    runs: { '/usr/bin/code': ok('1.105.1\n7d842fb\nx64\n') },
  };

  it('is high with code --version and Copilot Chat installed', async () => {
    const env = await vscode.detect(
      fakeContext({
        ...codeFound,
        listings: { [extensions]: ['ms-python.python-2026.1.0', 'github.copilot-chat-0.32.0'] },
      }),
    );
    expect(env?.confidence).toBe('high');
    expect(env?.version).toBe('1.105.1');
    expect(env?.displayName).toBe('VS Code + GitHub Copilot');
    expect(env?.evidence).toContain(
      'found Copilot extension github.copilot-chat-0.32.0 in ~/.vscode/extensions',
    );
  });

  it('accepts the plain github.copilot extension', async () => {
    const env = await vscode.detect(
      fakeContext({ ...codeFound, listings: { [extensions]: ['github.copilot-1.300.0'] } }),
    );
    expect(env?.confidence).toBe('high');
  });

  it('does not mistake other github.copilot-* extensions for Copilot', async () => {
    const env = await vscode.detect(
      fakeContext({ ...codeFound, listings: { [extensions]: ['github.copilot-labs-0.1.0'] } }),
    );
    expect(env?.confidence).toBe('medium');
  });

  it('is medium with code but without Copilot', async () => {
    const env = await vscode.detect(fakeContext(codeFound));
    expect(env?.confidence).toBe('medium');
    expect(env?.version).toBe('1.105.1');
    expect(env?.evidence).toContain('GitHub Copilot extension not found');
  });

  it('is high with Copilot Chat built into VS Code (per-commit layout)', async () => {
    const env = await vscode.detect(
      fakeContext({
        executables: { code: '/opt/vscode/bin/code' },
        runs: { '/opt/vscode/bin/code': ok('1.138.0\nabc\nx64\n') },
        listings: {
          '/opt/vscode': ['7debcd0e2a', 'bin', 'Code.exe'],
          '/opt/vscode/7debcd0e2a/resources/app/extensions': ['git', 'copilot', 'npm'],
        },
      }),
    );
    expect(env?.confidence).toBe('high');
    expect(env?.evidence).toContain(
      'found built-in Copilot extension at /opt/vscode/7debcd0e2a/resources/app/extensions/copilot',
    );
  });

  it('finds built-in Copilot in the flat and macOS layouts', async () => {
    const flat = await vscode.detect(
      fakeContext({
        executables: { code: '/usr/share/code/bin/code' },
        runs: { '/usr/share/code/bin/code': ok('1.138.0') },
        listings: { '/usr/share/code/resources/app/extensions': ['copilot-chat'] },
      }),
    );
    expect(flat?.confidence).toBe('high');
    const app = '/Applications/Visual Studio Code.app/Contents/Resources/app';
    const mac = await vscode.detect(
      fakeContext({
        executables: { code: `${app}/bin/code` },
        runs: { [`${app}/bin/code`]: ok('1.138.0') },
        listings: { [`${app}/extensions`]: ['copilot'] },
      }),
    );
    expect(mac?.confidence).toBe('high');
  });

  it('does not take unrelated built-in extensions for Copilot', async () => {
    const env = await vscode.detect(
      fakeContext({
        executables: { code: '/opt/vscode/bin/code' },
        runs: { '/opt/vscode/bin/code': ok('1.138.0') },
        listings: { '/opt/vscode/resources/app/extensions': ['copilot-labs', 'git'] },
      }),
    );
    expect(env?.confidence).toBe('medium');
  });

  it('is medium when code --version fails, even with Copilot', async () => {
    const env = await vscode.detect(
      fakeContext({
        executables: { code: '/usr/bin/code' },
        runs: { '/usr/bin/code': new Error('EINVAL') },
        listings: { [extensions]: ['github.copilot-chat-0.32.0'] },
      }),
    );
    expect(env?.confidence).toBe('medium');
  });

  it('is medium from the Copilot extension alone', async () => {
    const env = await vscode.detect(
      fakeContext({ listings: { [extensions]: ['github.copilot-chat-0.32.0'] } }),
    );
    expect(env?.confidence).toBe('medium');
    expect(env?.executable).toBeUndefined();
  });

  it('is null without code and without Copilot', async () => {
    expect(await vscode.detect(fakeContext())).toBeNull();
  });
});

describe('detectAgents', () => {
  it('returns agents with evidence in AGENT_IDS order', async () => {
    const ctx = fakeContext({
      executables: { code: '/usr/bin/code', claude: '/usr/bin/claude' },
      runs: { '/usr/bin/code': ok('1.105.1'), '/usr/bin/claude': ok('2.1.3 (Claude Code)') },
      paths: ['/home/dev/.cursor'],
    });
    const found = await detectAgents(ctx);
    expect(found.map((env) => [env.id, env.confidence])).toEqual([
      ['claude-code', 'high'],
      ['cursor', 'medium'],
      ['vscode', 'medium'],
    ]);
  });

  it('only ever runs --version with the detection timeout', async () => {
    const ctx = fakeContext({
      executables: { claude: '/b/claude', codex: '/b/codex', cursor: '/b/cursor', code: '/b/code' },
    });
    await detectAgents(ctx);
    expect(ctx.runCalls).toHaveLength(4);
    for (const call of ctx.runCalls) {
      expect(call.args).toEqual(['--version']);
      expect(call.timeoutMs).toBe(5000);
    }
  });

  it('resolves to [] when every context call throws', async () => {
    const broken: DetectContext = {
      home: HOME,
      env: {},
      platform: 'linux',
      which: () => Promise.reject(new Error('which failed')),
      run: () => Promise.reject(new Error('run failed')),
      exists: () => Promise.reject(new Error('exists failed')),
      listDir: () => Promise.reject(new Error('listDir failed')),
    };
    await expect(detectAgents(broken)).resolves.toEqual([]);
  });
});
