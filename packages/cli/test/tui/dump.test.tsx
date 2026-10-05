/**
 * Screen dumps for review (skipped unless AGENTHUB_TUI_DUMP names an output folder):
 *
 *   FORCE_COLOR=3 AGENTHUB_TUI_DUMP=<dir> npx vitest run packages/cli/test/tui/dump.test.tsx
 *
 * Every screen is driven through the real engine on a temporary machine (world.ts) and written
 * as <name>.ansi (colors, view with `cat` or `type` in a terminal) and <name>.txt (plain).
 */
import { EventEmitter } from 'node:events';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { render, renderToString } from 'ink';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { App } from '../../src/tui/app';
import { Wordmark } from '../../src/tui/components/wordmark';
import { ThemeContext, type View } from '../../src/tui/hooks/context';
import type { Session } from '../../src/tui/session';
import { asciiFold, createTheme, type TerminalCaps, type ThemeName } from '../../src/tui/theme';
import { KEY, plain } from './helpers';
import { createWorld, type World } from './world';

const out = process.env.AGENTHUB_TUI_DUMP;

class FakeStdout extends EventEmitter {
  frames: string[] = [];
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }
  isTTY = true;
  write = (frame: string): boolean => {
    this.frames.push(frame);
    return true;
  };
  last(): string {
    return this.frames[this.frames.length - 1] ?? '';
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write(data: string): void {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  }
  read(): string | null {
    const data = this.data;
    this.data = null;
    return data;
  }
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
}

const TRUECOLOR: TerminalCaps = { depth: 'truecolor', glyphs: 'unicode', motion: false };

interface Screen {
  stdout: FakeStdout;
  stdin: FakeStdin;
  unmount(): void;
}

function open(
  session: Session,
  view: View,
  opts: { caps?: TerminalCaps; theme?: ThemeName; columns?: number; rows?: number } = {},
): Screen {
  const columns = opts.columns ?? 120;
  const rows = opts.rows ?? 40;
  const stdout = new FakeStdout(columns, rows);
  const stdin = new FakeStdin();
  const instance = render(
    <App
      session={session}
      caps={opts.caps ?? TRUECOLOR}
      version="0.1.0"
      skipIntro
      initialTheme={opts.theme ?? 'dark'}
      initialView={view}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  return { stdout, stdin, unmount: () => instance.unmount() };
}

async function until(screen: Screen, test: (text: string) => boolean, ms = 30_000): Promise<void> {
  const started = Date.now();
  while (!test(plain(screen.stdout.last()))) {
    if (Date.now() - started > ms)
      throw new Error(`timed out; last frame:\n${plain(screen.stdout.last())}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // Let staged reveals and late effects settle.
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function keys(screen: Screen, ...sequence: string[]): Promise<void> {
  for (const key of sequence) {
    screen.stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

const written: string[] = [];

async function save(name: string, frame: string): Promise<void> {
  if (out === undefined) return;
  await writeFile(join(out, `${name}.ansi`), `${frame}\n`, 'utf8');
  await writeFile(join(out, `${name}.txt`), `${plain(frame)}\n`, 'utf8');
  written.push(name);
}

async function shot(screen: Screen, name: string): Promise<void> {
  await save(name, screen.stdout.last());
}

let world: World;

describe.skipIf(out === undefined)('screen dumps', () => {
  beforeAll(async () => {
    await mkdir(out ?? '.', { recursive: true });
    world = await createWorld();
  }, 120_000);

  afterAll(async () => {
    if (out !== undefined) {
      await writeFile(join(out, 'INDEX.txt'), `${written.join('\n')}\n`, 'utf8');
    }
    await world?.dispose();
  });

  it('dumps every screen', async () => {
    // Wordmark sweep, mid-animation and at rest.
    for (const [name, progress] of [
      ['01-intro-sweep-30', 0.3],
      ['01-intro-sweep-60', 0.6],
      ['01-intro-final', null],
    ] as const) {
      await save(
        name,
        renderToString(
          <ThemeContext.Provider value={createTheme('dark', TRUECOLOR)}>
            <Wordmark progress={progress} />
          </ThemeContext.Provider>,
          { columns: 60 },
        ),
      );
    }

    const session = world.session();
    let s = open(session, { kind: 'home' });
    await until(s, (t) => t.includes('[CC]') || t.includes(' CC '));
    await until(s, (t) => t.includes('installed'));
    await shot(s, '02-home');
    await keys(s, '/');
    await until(s, (t) => t.includes('COMMANDS'));
    await shot(s, '03-palette');
    await keys(s, 'a', 'p');
    await until(s, (t) => t.includes('/approve'));
    await shot(s, '04-palette-filtered');
    await keys(s, KEY.esc);
    s.unmount();

    s = open(session, { kind: 'search', query: 'skill' });
    await until(s, (t) => t.includes('result'));
    await keys(s, KEY.down);
    await shot(s, '05-search');
    s.unmount();

    s = open(session, { kind: 'detail', name: 'web-testing' });
    await until(s, (t) => t.includes('TRUST RECEIPT') && t.includes('FINDINGS'));
    await shot(s, '06-detail');
    s.unmount();

    s = open(session, { kind: 'install', target: 'web-testing@1.0.0' });
    await until(s, (t) => t.includes('Install web-testing 1.0.0?'));
    await shot(s, '07-install-plan');
    s.unmount();

    // Applying with motion on: keep the frames and pick one mid-transaction.
    s = open(
      session,
      { kind: 'install', target: 'web-testing@1.0.0' },
      {
        caps: { ...TRUECOLOR, motion: true },
      },
    );
    await until(s, (t) => t.includes('Install web-testing 1.0.0?'));
    await keys(s, 'y');
    await until(s, (t) => t.includes('committed in'));
    const mid = s.stdout.frames.find(
      (f) =>
        plain(f).includes('Installing web-testing') &&
        /Swapping|Verifying/.test(plain(f)) &&
        plain(f).includes('2/5'),
    );
    const anyApplying = s.stdout.frames.filter((f) => plain(f).includes('Installing web-testing'));
    await save('08-install-progress', mid ?? anyApplying[Math.floor(anyApplying.length / 2)] ?? '');
    await shot(s, '09-install-done');
    s.unmount();

    s = open(session, { kind: 'install', target: 'download-exec' });
    await until(s, (t) => t.includes('Nothing was written.'));
    await shot(s, '10-install-blocked');
    s.unmount();

    s = open(session, { kind: 'install', target: 'prompt-injection' });
    await until(s, (t) => t.includes('[y/N]') || t.includes('[Y/n]'));
    await shot(s, '11-install-warn-default-no');
    s.unmount();

    s = open(session, { kind: 'install', target: 'no-such-skill' });
    await until(s, (t) => t.includes('FAILED'));
    await shot(s, '12-error-card');
    s.unmount();

    s = open(session, { kind: 'updates' });
    await until(s, (t) => t.includes('CHANGE') && t.includes('web-testing'));
    await keys(s, KEY.enter);
    await until(s, (t) => t.includes(' new'));
    await shot(s, '13-updates-expanded');
    s.unmount();

    s = open(session, { kind: 'diff', name: 'web-testing' });
    await until(s, (t) => t.includes('Expansion') || t.includes('No expansion'));
    await shot(s, '14-diff');
    s.unmount();

    s = open(session, { kind: 'update-flow', name: 'web-testing' });
    await until(s, (t) => t.includes('explicit approval'));
    await shot(s, '15-update-needs-capability-approval');
    await keys(s, 'y');
    await until(s, (t) => t.includes('does not approve new capabilities'));
    await shot(s, '16-update-y-is-not-approval');
    await keys(s, 'a');
    await until(s, (t) => t.includes('[y/N]'));
    await shot(s, '17-update-approve-capabilities');
    await keys(s, 'y');
    await until(s, (t) => t.includes('committed in'));
    await shot(s, '18-update-done-rollback-key');
    await keys(s, 'r');
    await until(s, (t) => t.includes('Roll back web-testing'));
    await shot(s, '19-rollback-confirm');
    await keys(s, 'y');
    await until(s, (t) => t.includes('Rolled back'));
    await shot(s, '20-rollback-done');
    s.unmount();

    s = open(session, { kind: 'list' });
    await until(s, (t) => t.includes('APPROVAL') && t.includes('web-testing'));
    await shot(s, '21-list');
    s.unmount();

    // Hand-edit an installed file so verify shows drift.
    await appendFile(
      join(world.project, '.claude', 'skills', 'web-testing', 'SKILL.md'),
      '\nedited by hand\n',
    );
    s = open(session, { kind: 'verify' });
    await until(s, (t) => t.includes('differ from the lock') || t.includes('matches'));
    await shot(s, '22-verify-drift');
    s.unmount();

    s = open(session, { kind: 'doctor' });
    await until(s, (t) => t.includes('Requirements') && !t.includes('checking'));
    await shot(s, '23-doctor');
    s.unmount();

    s = open(session, { kind: 'approve', name: 'web-testing' });
    await until(s, (t) => t.includes('CANNOT APPROVE') || t.includes('[y/N]'));
    await shot(s, '24-approve');
    s.unmount();

    s = open(session, { kind: 'agents' });
    await until(s, (t) => t.includes('TARGET AGENTS'));
    await shot(s, '25-agents');
    s.unmount();

    s = open(session, { kind: 'help' });
    await until(s, (t) => t.includes('ENVIRONMENT'));
    await shot(s, '26-help');
    s.unmount();

    // The same plan in every degraded mode.
    const variants: [string, TerminalCaps, ThemeName][] = [
      ['27-plan-256-colors', { depth: '256', glyphs: 'unicode', motion: false }, 'dark'],
      ['28-plan-16-colors', { depth: '16', glyphs: 'unicode', motion: false }, 'dark'],
      ['29-plan-no-color', { depth: 'none', glyphs: 'unicode', motion: false }, 'dark'],
      ['30-plan-light', TRUECOLOR, 'light'],
      ['31-plan-ascii', { depth: '16', glyphs: 'ascii', motion: false }, 'dark'],
      ['32-plan-classic-console', { depth: 'truecolor', glyphs: 'compat', motion: false }, 'dark'],
    ];
    for (const [name, caps, theme] of variants) {
      s = open(session, { kind: 'install', target: 'prompt-injection' }, { caps, theme });
      await until(s, (t) => t.includes('[y/N]') || t.includes('[Y/n]'));
      if (caps.glyphs === 'ascii') await save(name, asciiFold(s.stdout.last()));
      else await shot(s, name);
      s.unmount();
    }
    s = open(
      session,
      { kind: 'home' },
      { columns: 80, rows: 24, caps: { depth: '16', glyphs: 'compat', motion: false } },
    );
    await until(s, (t) => t.includes('installed'));
    await shot(s, '33-home-80x24-classic-console');
    s.unmount();
  }, 300_000);
});
