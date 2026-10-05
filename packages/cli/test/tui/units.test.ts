import { describe, expect, it } from 'vitest';
import {
  COMMANDS,
  filterCommands,
  fuzzyScore,
  paletteQuery,
  parseInput,
  resolveCommand,
} from '../../src/tui/commands';
import { fit, safe, safeInput, safeLines } from '../../src/tui/sanitize';
import {
  createTheme,
  detectCaps,
  detectColorDepth,
  detectGlyphs,
  forceColorLevel,
  GLYPHS,
  hexToAnsi256,
  mixHex,
  paletteFor,
} from '../../src/tui/theme';

describe('command palette filter', () => {
  it('ranks a prefix first, then substrings, then subsequences', () => {
    expect(filterCommands('ins')[0]?.command.name).toBe('install');
    expect(filterCommands('up')[0]?.command.name).toBe('update');
    expect(filterCommands('lst')[0]?.command.name).toBe('list');
    expect(filterCommands('rb')[0]?.command.name).toBe('rollback');
  });

  it('lists every command for an empty query, in palette order', () => {
    expect(filterCommands('').map((m) => m.command.name)).toEqual(COMMANDS.map((c) => c.name));
  });

  it('matches aliases and descriptions, and nothing else', () => {
    expect(filterCommands('q')[0]?.command.name).toBe('quit');
    expect(filterCommands('ls')[0]?.command.name).toBe('list');
    expect(filterCommands('snapshot').map((m) => m.command.name)).toContain('rollback');
    expect(filterCommands('zzzz')).toEqual([]);
  });

  it('reports matched positions for highlighting', () => {
    expect(fuzzyScore('dr', 'doctor')?.positions).toEqual([0, 5]);
    expect(fuzzyScore('doc', 'doctor')?.positions).toEqual([0, 1, 2]);
    expect(fuzzyScore('xyz', 'doctor')).toBeNull();
  });

  it('parses commands, arguments and plain-text searches', () => {
    expect(parseInput('  ')).toEqual({ kind: 'empty' });
    expect(parseInput('web testing')).toEqual({ kind: 'search', query: 'web testing' });
    const parsed = parseInput('/install web-testing@^1.2');
    expect(parsed).toMatchObject({ kind: 'command', name: 'install', args: ['web-testing@^1.2'] });
    expect(parseInput('/frobnicate')).toMatchObject({ kind: 'command', command: null });
    expect(resolveCommand('doc')?.name).toBe('doctor');
    expect(resolveCommand('exit')?.name).toBe('quit');
    // "re" is ambiguous (remove, registry): no guess.
    expect(resolveCommand('re')).toBeNull();
  });

  it('opens the palette only while a command name is typed', () => {
    expect(paletteQuery('/')).toBe('');
    expect(paletteQuery('/ins')).toBe('ins');
    expect(paletteQuery('/install x')).toBeNull();
    expect(paletteQuery('web')).toBeNull();
  });

  it('never offers a model command', () => {
    expect(COMMANDS.some((c) => (c.name as string) === 'model')).toBe(false);
  });
});

describe('terminal capabilities and theme', () => {
  const win = (env: Record<string, string | undefined>, build = 26100) => ({
    env,
    platform: 'win32' as const,
    colorFlag: true,
    windowsBuild: build,
  });
  const posix = (env: Record<string, string | undefined>, colorFlag = true) => ({
    env,
    platform: 'linux' as const,
    colorFlag,
  });

  it('turns colors off for NO_COLOR, --no-color, FORCE_COLOR=0 and dumb terminals', () => {
    expect(detectColorDepth(posix({ NO_COLOR: '1', COLORTERM: 'truecolor' }))).toBe('none');
    expect(detectColorDepth(posix({ COLORTERM: 'truecolor' }, false))).toBe('none');
    expect(detectColorDepth(posix({ FORCE_COLOR: '0' }))).toBe('none');
    expect(detectColorDepth(posix({ TERM: 'dumb' }))).toBe('none');
    // An empty NO_COLOR does not count (no-color.org).
    expect(detectColorDepth(posix({ NO_COLOR: '', COLORTERM: '24bit' }))).toBe('truecolor');
  });

  it('degrades truecolor → 256 → 16', () => {
    expect(detectColorDepth(posix({ COLORTERM: 'truecolor' }))).toBe('truecolor');
    expect(detectColorDepth(posix({ TERM: 'xterm-256color' }))).toBe('256');
    expect(detectColorDepth(posix({ TERM: 'xterm' }))).toBe('16');
    expect(detectColorDepth(posix({ FORCE_COLOR: '2', COLORTERM: 'truecolor' }))).toBe('256');
    expect(detectColorDepth(win({ WT_SESSION: 'x' }))).toBe('truecolor');
    expect(detectColorDepth(win({}, 19045))).toBe('truecolor');
    expect(detectColorDepth(win({}, 10586))).toBe('256');
    expect(detectColorDepth(win({}, 9600))).toBe('16');
  });

  it('uses WGL4 glyphs on the classic console and ASCII on request', () => {
    expect(detectGlyphs(win({}))).toBe('compat');
    expect(detectGlyphs(win({ WT_SESSION: 'x' }))).toBe('unicode');
    expect(detectGlyphs(win({ TERM_PROGRAM: 'vscode' }))).toBe('unicode');
    expect(detectGlyphs(win({ AGENTHUB_UNICODE: '1' }))).toBe('unicode');
    expect(detectGlyphs(posix({}))).toBe('unicode');
    expect(detectGlyphs(posix({ AGENTHUB_ASCII: '1' }))).toBe('ascii');
    expect(detectGlyphs(win({ WT_SESSION: 'x', AGENTHUB_ASCII: 'true' }))).toBe('ascii');
    for (const glyph of [...Object.values(GLYPHS.ascii)].flat()) {
      if (typeof glyph === 'string') expect(glyph).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it('honours AGENTHUB_REDUCED_MOTION', () => {
    expect(detectCaps(posix({ AGENTHUB_REDUCED_MOTION: '1' })).motion).toBe(false);
    expect(detectCaps(posix({ AGENTHUB_REDUCED_MOTION: '0' })).motion).toBe(true);
    expect(detectCaps(posix({})).motion).toBe(true);
  });

  it('maps the brand palette to each depth', () => {
    expect(paletteFor('dark', 'truecolor').signal).toBe('#C5F04A');
    expect(paletteFor('dark', 'truecolor').warn).toBe('#F5B544');
    expect(paletteFor('dark', 'truecolor').block).toBe('#FF7A85');
    expect(paletteFor('dark', '256').signal).toMatch(/^ansi256\(\d+\)$/);
    expect(paletteFor('dark', '16').signal).toBe('greenBright');
    expect(paletteFor('light', 'truecolor').signal).toBe('#3F6212');
    expect(Object.values(paletteFor('mono', 'truecolor')).every((c) => c === undefined)).toBe(true);
    expect(Object.values(paletteFor('dark', 'none')).every((c) => c === undefined)).toBe(true);
    expect(createTheme('mono', { depth: 'truecolor', glyphs: 'unicode', motion: true }).color).toBe(
      false,
    );
  });

  it('converts colors to the nearest xterm-256 index', () => {
    expect(hexToAnsi256('#000000')).toBe(16);
    expect(hexToAnsi256('#ffffff')).toBe(231);
    expect(hexToAnsi256('#808080')).toBe(244);
    expect(hexToAnsi256('#C5F04A')).toBe(191);
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('tells chalk the same depth', () => {
    expect(forceColorLevel('none')).toBe('0');
    expect(forceColorLevel('16')).toBe('1');
    expect(forceColorLevel('256')).toBe('2');
    expect(forceColorLevel('truecolor')).toBe('3');
  });
});

describe('sanitizing untrusted text', () => {
  const esc = '\u001b';
  it('removes escape sequences, bidi overrides and zero-width characters', () => {
    const hostile = `evil${esc}]0;title${String.fromCharCode(7)}${esc}[2J\u202Etxt.exe\u200B`;
    const cleaned = safe(hostile);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the sanitizer must remove these
    expect(cleaned).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u200b]/);
    expect(cleaned).toContain('evil');
  });

  it('keeps lines apart but strips controls inside them', () => {
    expect(safeLines(`a${esc}[31m\nb\tc`)).toEqual(['a[31m', 'b  c']);
  });

  it('flattens typed or pasted input to one printable line', () => {
    expect(safeInput(`web\r\ntest${esc}[A`)).toBe('web test[A');
  });

  it('shortens with an ellipsis', () => {
    expect(fit('abcdef', 4)).toBe('abc…');
    expect(fit('abc', 4)).toBe('abc');
    expect(fit('abcdef', 4, '...')).toBe('a...');
  });
});

describe('ASCII mode', () => {
  it('folds every symbol to one ASCII cell and keeps escape sequences', async () => {
    const { asciiFold } = await import('../../src/tui/theme');
    const { asciiStream } = await import('../../src/tui/launch');
    expect(asciiFold('✔ allow · ⚠ warn — ✖ block … → ●')).toBe('+ allow - ! warn - x block . > *');
    expect(asciiFold('\u001b[32mok\u001b[39m')).toBe('\u001b[32mok\u001b[39m');
    expect(asciiFold('日本')).toBe('??');
    const chunks: string[] = [];
    const stream = asciiStream({ columns: 80, write: (chunk: string) => chunks.push(chunk) > 0 });
    stream.write('╭ ✔ ok');
    expect(chunks).toEqual(['? + ok']);
    expect(stream.columns).toBe(80);
  });
});
