import { AgentHubError } from '@agenthub/core';
import { describe, expect, it } from 'vitest';
import {
  colorEnabled,
  errorEnvelope,
  exitCodeFor,
  Output,
  sanitizeForTerminal,
  stripControl,
  successEnvelope,
  toJson,
} from '../src/output';
import { run } from '../src/program';

function sink(isTTY = false) {
  const chunks: string[] = [];
  return {
    isTTY,
    chunks,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
}

describe('JSON envelope', () => {
  it('wraps success data', () => {
    expect(successEnvelope('list', { skills: [] })).toEqual({
      ok: true,
      command: 'list',
      data: { skills: [] },
    });
  });

  it('wraps AgentHubError with code, message and details', () => {
    const error = new AgentHubError('POLICY_BLOCKED', 'blocked by secrets.read', { rule: 'x' });
    expect(errorEnvelope('install', error)).toEqual({
      ok: false,
      command: 'install',
      error: { code: 'POLICY_BLOCKED', message: 'blocked by secrets.read', details: { rule: 'x' } },
    });
  });

  it('maps unknown errors to INTERNAL without a stack trace unless verbose', () => {
    const error = new Error('boom');
    const plain = errorEnvelope('doctor', error);
    expect(plain.error.code).toBe('INTERNAL');
    expect(plain.error.details).toBeUndefined();
    const verbose = errorEnvelope('doctor', error, true);
    expect(verbose.error.details).toMatchObject({ stack: expect.stringContaining('boom') });
  });

  it('escapes DEL and C1 characters in serialized JSON', () => {
    const json = toJson(successEnvelope('info', { text: 'a\u009b31mb\u007f\u0007' }));
    const raw = [...json].filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x7f && code <= 0x9f;
    });
    expect(raw).toEqual([]);
    expect(json).toContain('\\u009b');
    expect(JSON.parse(json).data.text).toBe('a\u009b31mb\u007f\u0007');
  });
});

describe('exit codes', () => {
  it.each([
    ['USAGE', 2],
    ['VALIDATION', 1],
    ['POLICY_BLOCKED', 3],
    ['INTEGRITY', 4],
    ['DRIFT', 4],
    ['INCOMPATIBLE', 5],
    ['CANCELLED', 130],
    ['REGISTRY', 1],
  ] as const)('%s → %i', (code, exit) => {
    expect(exitCodeFor(new AgentHubError(code, 'x'))).toBe(exit);
  });

  it('unknown errors exit 1', () => {
    expect(exitCodeFor(new TypeError('x'))).toBe(1);
    expect(exitCodeFor('string')).toBe(1);
  });

  it('recognizes AgentHubError-shaped errors from another module copy', () => {
    const foreign = Object.assign(new Error('drift'), { name: 'AgentHubError', code: 'DRIFT' });
    expect(exitCodeFor(foreign)).toBe(4);
  });
});

describe('terminal-injection guard', () => {
  it('strips C0, DEL and C1 control characters', () => {
    expect(stripControl('ok\u001b[2J\u0007\u0000\u007f\u009b\u0085done')).toBe('ok[2Jdone');
    expect(stripControl('line1\nline2\tx')).toBe('line1line2x');
    expect(stripControl('line1\nline2\tx', { keepNewlines: true })).toBe('line1\nline2\tx');
  });

  it('keeps our own color codes only when colors are on', () => {
    const colored = '\u001b[31mred\u001b[39m \u001b]0;title\u0007';
    expect(sanitizeForTerminal(colored, true)).toBe('\u001b[31mred\u001b[39m ]0;title');
    expect(sanitizeForTerminal(colored, false)).toBe('[31mred[39m ]0;title');
  });

  it('Output never writes raw escape sequences from data', () => {
    const stdout = sink(false);
    const stderr = sink(false);
    const out = new Output({ json: false, verbose: false, color: true, env: {}, stdout, stderr });
    out.print('skill \u001b]8;;http://evil\u0007name');
    expect(stdout.text()).toBe('skill ]8;;http://evilname\n');
  });
});

describe('colors', () => {
  it('are used only on a TTY without NO_COLOR or --no-color', () => {
    expect(colorEnabled({ write: () => true, isTTY: true }, {}, true)).toBe(true);
    expect(colorEnabled({ write: () => true, isTTY: false }, {}, true)).toBe(false);
    expect(colorEnabled({ write: () => true, isTTY: true }, { NO_COLOR: '1' }, true)).toBe(false);
    expect(colorEnabled({ write: () => true, isTTY: true }, {}, false)).toBe(false);
  });
});

describe('run()', () => {
  const runtime = () => ({
    cwd: process.cwd(),
    env: { NO_COLOR: '1' },
    stdout: sink(),
    stderr: sink(),
    stdin: process.stdin,
  });

  it('reports usage errors as one JSON object with exit 2', async () => {
    const rt = runtime();
    const code = await run(['--json', 'frobnicate'], rt);
    expect(code).toBe(2);
    const parsed = JSON.parse(rt.stdout.text());
    expect(parsed).toMatchObject({ ok: false, error: { code: 'USAGE' } });
  });

  it('rejects unknown agents in --agent', async () => {
    const rt = runtime();
    const code = await run(['list', '--agent', 'notepad', '--json'], rt);
    expect(code).toBe(2);
    expect(JSON.parse(rt.stdout.text()).error.message).toContain('unknown agent');
  });

  it('prints help with the environment variables', async () => {
    const rt = runtime();
    const code = await run(['--help'], rt);
    expect(code).toBe(0);
    const help = rt.stdout.text();
    for (const name of ['AGENTHUB_HOME', 'AGENTHUB_REGISTRY', 'NO_COLOR', 'AGENTHUB_AGENTS']) {
      expect(help).toContain(name);
    }
  });
});
