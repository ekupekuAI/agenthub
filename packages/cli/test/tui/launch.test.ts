import { describe, expect, it, vi } from 'vitest';

const launched = vi.fn(async () => 0);

vi.mock('../../src/tui/launch', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/tui/launch')>();
  return { ...original, launchTui: launched };
});

const { tuiRequest } = await import('../../src/tui/launch');
const { run } = await import('../../src/program');

function sink(isTTY: boolean) {
  const chunks: string[] = [];
  return {
    isTTY,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
}

function runtime(tty: boolean, env: Record<string, string | undefined> = {}) {
  return {
    // Temp folders from the test guard (test/setup.ts): nothing here may reach the real home.
    cwd: process.env.AGENTHUB_USER_HOME ?? '',
    env: {
      AGENTHUB_HOME: process.env.AGENTHUB_HOME,
      AGENTHUB_USER_HOME: process.env.AGENTHUB_USER_HOME,
      ...env,
    },
    stdout: sink(tty),
    stderr: sink(tty),
    stdin: { isTTY: tty } as unknown as NodeJS.ReadStream,
  };
}

describe('when the interactive mode opens', () => {
  const tty = runtime(true);

  it('opens for agenthub alone on a terminal, with --no-color or -g', () => {
    expect(tuiRequest([], tty)).toEqual({ global: false, color: true });
    expect(tuiRequest(['--no-color'], tty)).toEqual({ global: false, color: false });
    expect(tuiRequest(['-g'], tty)).toEqual({ global: true, color: true });
  });

  it('never opens for a subcommand or other flags', () => {
    for (const argv of [
      ['list'],
      ['install', 'x'],
      ['--json'],
      ['--help'],
      ['-y'],
      ['list', '--json'],
    ]) {
      expect(tuiRequest(argv, tty)).toBeNull();
    }
  });

  it('never opens without a terminal, in CI, on a dumb terminal or with AGENTHUB_NO_TUI', () => {
    expect(tuiRequest([], runtime(false))).toBeNull();
    expect(tuiRequest([], { ...tty, stdout: sink(false) })).toBeNull();
    expect(tuiRequest([], runtime(true, { CI: 'true' }))).toBeNull();
    expect(tuiRequest([], runtime(true, { TERM: 'dumb' }))).toBeNull();
    expect(tuiRequest([], runtime(true, { AGENTHUB_NO_TUI: '1' }))).toBeNull();
    // CI=false does not count.
    expect(tuiRequest([], runtime(true, { CI: 'false' }))).not.toBeNull();
  });
});

describe('run()', () => {
  it('prints the classic help without a terminal', async () => {
    launched.mockClear();
    const rt = runtime(false);
    await run([], rt);
    expect(launched).not.toHaveBeenCalled();
    expect(rt.stdout.text()).toContain('Usage: agenthub');
  });

  it('runs subcommands classically even on a terminal', async () => {
    launched.mockClear();
    const rt = runtime(true);
    const code = await run(['--version'], rt);
    expect(code).toBe(0);
    expect(rt.stdout.text()).toMatch(/\d+\.\d+\.\d+/);
    await run(['frobnicate', '--json'], rt);
    expect(JSON.parse(rt.stdout.text().split('\n').slice(1).join('\n'))).toMatchObject({
      ok: false,
    });
    expect(launched).not.toHaveBeenCalled();
  });

  it('opens the interactive mode for agenthub alone on a terminal', async () => {
    launched.mockClear();
    const code = await run([], runtime(true));
    expect(code).toBe(0);
    expect(launched).toHaveBeenCalledTimes(1);
  });
});
