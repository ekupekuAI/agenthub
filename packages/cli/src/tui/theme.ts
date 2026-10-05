/**
 * Terminal capabilities, palettes and glyphs for the interactive mode.
 *
 * Brand (docs/specs/2026-10-04-web-design.md): ink background, one signal color (lime) that means
 * trusted/verified, amber for WARN, red for BLOCK, blue for info. Every status also carries a
 * word and a glyph, so nothing depends on color alone (NO_COLOR, mono theme, 16 colors).
 */
import { release } from 'node:os';

export type ThemeName = 'dark' | 'light' | 'mono';
export type ColorDepth = 'none' | '16' | '256' | 'truecolor';
export type GlyphMode = 'unicode' | 'compat' | 'ascii';

export interface TerminalCaps {
  depth: ColorDepth;
  glyphs: GlyphMode;
  /** False with AGENTHUB_REDUCED_MOTION=1: final states render immediately. */
  motion: boolean;
}

export interface CapsInput {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** --no-color */
  colorFlag: boolean;
  /** Windows build number (os.release()), for VT color support on conhost. */
  windowsBuild?: number;
}

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/** Color depth: NO_COLOR / --no-color → none; FORCE_COLOR levels; then terminal sniffing. */
export function detectColorDepth(input: CapsInput): ColorDepth {
  const { env } = input;
  if (!input.colorFlag) return 'none';
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 'none';
    if (force === '1') return '16';
    if (force === '2') return '256';
    if (force === '3') return 'truecolor';
  }
  if (env.TERM === 'dumb') return 'none';
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
  if (env.WT_SESSION !== undefined) return 'truecolor';
  const program = env.TERM_PROGRAM ?? '';
  if (/^(vscode|iTerm\.app|WezTerm|ghostty|Hyper|Tabby)$/.test(program)) return 'truecolor';
  if (input.platform === 'win32') {
    // conhost has rendered 24-bit VT colors since Windows 10 1703 (build 14931 preview).
    const build = input.windowsBuild ?? 0;
    if (build >= 14931) return 'truecolor';
    return build >= 10586 ? '256' : '16';
  }
  if (/-256(color)?$/i.test(env.TERM ?? '')) return '256';
  return '16';
}

/**
 * Glyph set. The classic Command Prompt (conhost with Consolas) has no font fallback, so it gets
 * symbols from the WGL4 set every console font has; AGENTHUB_ASCII=1 forces plain ASCII and
 * AGENTHUB_UNICODE=1 the full set.
 */
export function detectGlyphs(input: CapsInput): GlyphMode {
  const { env } = input;
  if (truthy(env.AGENTHUB_ASCII)) return 'ascii';
  if (truthy(env.AGENTHUB_UNICODE)) return 'unicode';
  if (env.TERM === 'dumb') return 'ascii';
  if (input.platform === 'win32') {
    const modern =
      env.WT_SESSION !== undefined ||
      env.TERM_PROGRAM !== undefined ||
      env.ConEmuANSI === 'ON' ||
      env.TERM !== undefined;
    return modern ? 'unicode' : 'compat';
  }
  return 'unicode';
}

export function windowsBuild(): number {
  const parts = release().split('.');
  return Number.parseInt(parts[2] ?? '0', 10) || 0;
}

export function detectCaps(input: CapsInput): TerminalCaps {
  return {
    depth: detectColorDepth(input),
    glyphs: detectGlyphs(input),
    motion: !truthy(input.env.AGENTHUB_REDUCED_MOTION),
  };
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

/** A color Ink understands ('#rrggbb', 'ansi256(n)', a named color) or undefined (no color). */
export type Color = string | undefined;

export interface Palette {
  text: Color;
  muted: Color;
  subtle: Color;
  border: Color;
  /** Lime: trusted, verified, success, the brand mark. */
  signal: Color;
  /** Text drawn on a signal fill. */
  onSignal: Color;
  info: Color;
  warn: Color;
  block: Color;
  /** Background of selected rows and chips; undefined = use inverse. */
  surface: Color;
  /** Brighter highlight used by the wordmark sweep. */
  glow: Color;
}

type Hex = `#${string}`;

interface HexPalette {
  text: Hex;
  muted: Hex;
  subtle: Hex;
  border: Hex;
  signal: Hex;
  onSignal: Hex;
  info: Hex;
  warn: Hex;
  block: Hex;
  surface: Hex;
  glow: Hex;
}

/** Brand tokens (web design spec §2), dark and light. */
export const BRAND: Record<'dark' | 'light', HexPalette> = {
  dark: {
    text: '#ECEEF0',
    muted: '#A3ABB5',
    subtle: '#7C8591',
    border: '#353B43',
    signal: '#C5F04A',
    onSignal: '#0B0C0E',
    info: '#7CC4FA',
    warn: '#F5B544',
    block: '#FF7A85',
    surface: '#1C2025',
    glow: '#F1FFD1',
  },
  light: {
    text: '#14161A',
    muted: '#4A515B',
    subtle: '#667080',
    border: '#CFCFC6',
    signal: '#3F6212',
    onSignal: '#14161A',
    info: '#075985',
    warn: '#92400E',
    block: '#B4233A',
    surface: '#EAEAE3',
    glow: '#8DB51B',
  },
};

const NAMED_16: Record<'dark' | 'light', Palette> = {
  dark: {
    text: 'white',
    muted: 'gray',
    subtle: 'gray',
    border: 'gray',
    signal: 'greenBright',
    onSignal: 'black',
    info: 'cyanBright',
    warn: 'yellowBright',
    block: 'redBright',
    surface: undefined,
    glow: 'whiteBright',
  },
  light: {
    text: 'black',
    muted: 'gray',
    subtle: 'gray',
    border: 'gray',
    signal: 'green',
    onSignal: 'black',
    info: 'blue',
    warn: 'yellow',
    block: 'red',
    surface: undefined,
    glow: 'greenBright',
  },
};

const NONE: Palette = {
  text: undefined,
  muted: undefined,
  subtle: undefined,
  border: undefined,
  signal: undefined,
  onSignal: undefined,
  info: undefined,
  warn: undefined,
  block: undefined,
  surface: undefined,
  glow: undefined,
};

export function parseHex(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function toHex([r, g, b]: [number, number, number]): Hex {
  const part = (n: number): string => Math.round(n).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Linear mix of two hex colors, t in [0, 1]. */
export function mixHex(a: string, b: string, t: number): Hex {
  const x = parseHex(a);
  const y = parseHex(b);
  const k = Math.min(1, Math.max(0, t));
  return toHex([x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k]);
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** Nearest xterm-256 index (6×6×6 cube or the gray ramp). */
export function hexToAnsi256(hex: string): number {
  const [r, g, b] = parseHex(hex);
  const nearest = (v: number): number => {
    let best = 0;
    for (let i = 1; i < CUBE.length; i += 1) {
      if (Math.abs((CUBE[i] ?? 0) - v) < Math.abs((CUBE[best] ?? 0) - v)) best = i;
    }
    return best;
  };
  const ri = nearest(r);
  const gi = nearest(g);
  const bi = nearest(b);
  const cube = 16 + 36 * ri + 6 * gi + bi;
  const cubeRgb = [CUBE[ri] ?? 0, CUBE[gi] ?? 0, CUBE[bi] ?? 0];
  const avg = (r + g + b) / 3;
  const grayIndex = Math.min(23, Math.max(0, Math.round((avg - 8) / 10)));
  const grayValue = 8 + grayIndex * 10;
  const dist = (c: number[]): number =>
    ((c[0] ?? 0) - r) ** 2 + ((c[1] ?? 0) - g) ** 2 + ((c[2] ?? 0) - b) ** 2;
  return dist([grayValue, grayValue, grayValue]) < dist(cubeRgb) ? 232 + grayIndex : cube;
}

export function paletteFor(theme: ThemeName, depth: ColorDepth): Palette {
  if (theme === 'mono' || depth === 'none') return NONE;
  if (depth === '16') return NAMED_16[theme];
  const brand = BRAND[theme];
  if (depth === 'truecolor') return { ...brand };
  const out = {} as Palette;
  for (const [key, value] of Object.entries(brand) as [keyof HexPalette, Hex][]) {
    out[key] = `ansi256(${hexToAnsi256(value)})`;
  }
  return out;
}

/**
 * A color for a point of a gradient between two brand colors. Truecolor mixes; 256 colors maps
 * the mix to the nearest index; 16 colors and no color switch at the midpoint.
 */
export function gradientColor(
  theme: ThemeName,
  depth: ColorDepth,
  from: keyof HexPalette,
  to: keyof HexPalette,
  t: number,
): Color {
  if (theme === 'mono' || depth === 'none') return undefined;
  if (depth === '16') return NAMED_16[theme][t < 0.5 ? from : to];
  const mixed = mixHex(BRAND[theme][from], BRAND[theme][to], t);
  return depth === 'truecolor' ? mixed : `ansi256(${hexToAnsi256(mixed)})`;
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

export type BorderName = 'round' | 'single' | 'classic';

export interface Glyphs {
  ok: string;
  warn: string;
  block: string;
  info: string;
  pointer: string;
  prompt: string;
  bullet: string;
  dot: string;
  sep: string;
  arrow: string;
  up: string;
  down: string;
  enter: string;
  ellipsis: string;
  hr: string;
  vbar: string;
  plus: string;
  minus: string;
  tilde: string;
  barFull: string;
  barEmpty: string;
  /** Pixels of the wordmark: top half, bottom half, both. */
  pixelTop: string;
  pixelBottom: string;
  pixelFull: string;
  spinner: readonly string[];
  border: BorderName;
  pending: string;
}

export const GLYPHS: Record<GlyphMode, Glyphs> = {
  unicode: {
    ok: '✔',
    warn: '⚠',
    block: '✖',
    info: '●',
    pointer: '❯',
    prompt: '›',
    bullet: '•',
    dot: '●',
    sep: '·',
    arrow: '→',
    up: '↑',
    down: '↓',
    enter: '↵',
    ellipsis: '…',
    hr: '─',
    vbar: '│',
    plus: '+',
    minus: '−',
    tilde: '~',
    barFull: '█',
    barEmpty: '░',
    pixelTop: '▀',
    pixelBottom: '▄',
    pixelFull: '█',
    spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    border: 'round',
    pending: '○',
  },
  // WGL4 only: renders in Consolas and Lucida Console on the classic console.
  compat: {
    ok: '√',
    warn: '▲',
    block: '×',
    info: '●',
    pointer: '►',
    prompt: '›',
    bullet: '•',
    dot: '●',
    sep: '·',
    arrow: '→',
    up: '↑',
    down: '↓',
    enter: '↵',
    ellipsis: '…',
    hr: '─',
    vbar: '│',
    plus: '+',
    minus: '-',
    tilde: '~',
    barFull: '█',
    barEmpty: '░',
    pixelTop: '▀',
    pixelBottom: '▄',
    pixelFull: '█',
    spinner: ['·', '•', '●', '•'],
    border: 'single',
    pending: '○',
  },
  ascii: {
    ok: '+',
    warn: '!',
    block: 'x',
    info: '*',
    pointer: '>',
    prompt: '>',
    bullet: '*',
    dot: '*',
    sep: '|',
    arrow: '->',
    up: '^',
    down: 'v',
    enter: 'enter',
    ellipsis: '...',
    hr: '-',
    vbar: '|',
    plus: '+',
    minus: '-',
    tilde: '~',
    barFull: '#',
    barEmpty: '.',
    pixelTop: '"',
    pixelBottom: '_',
    pixelFull: '#',
    spinner: ['|', '/', '-', '\\'],
    border: 'classic',
    pending: 'o',
  },
};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

export interface Theme {
  name: ThemeName;
  depth: ColorDepth;
  palette: Palette;
  glyphs: Glyphs;
  motion: boolean;
  /** True when colors are drawn at all (inverse/bold carry state otherwise). */
  color: boolean;
}

export function createTheme(name: ThemeName, caps: TerminalCaps): Theme {
  const palette = paletteFor(name, caps.depth);
  return {
    name,
    depth: name === 'mono' ? 'none' : caps.depth,
    palette,
    glyphs: GLYPHS[caps.glyphs],
    motion: caps.motion,
    color: name !== 'mono' && caps.depth !== 'none',
  };
}

/** chalk's FORCE_COLOR level for a depth, so Ink draws exactly what the theme chose. */
export function forceColorLevel(depth: ColorDepth): '0' | '1' | '2' | '3' {
  switch (depth) {
    case 'none':
      return '0';
    case '16':
      return '1';
    case '256':
      return '2';
    default:
      return '3';
  }
}

// ---------------------------------------------------------------------------
// ASCII output
// ---------------------------------------------------------------------------

/** One-cell replacements, so folding never shifts a layout. */
const ASCII_FOLD: Record<string, string> = {
  '…': '.',
  '·': '-',
  '—': '-',
  '–': '-',
  '−': '-',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '→': '>',
  '←': '<',
  '↑': '^',
  '↓': 'v',
  '›': '>',
  '✔': '+',
  '✖': 'x',
  '⚠': '!',
  '●': '*',
  '•': '*',
  '○': 'o',
};

/**
 * With AGENTHUB_ASCII=1 every character that reaches the terminal is ASCII: known symbols fold
 * to a one-cell equivalent, anything else non-ASCII (e.g. in a skill summary) becomes "?".
 * Escape sequences are ASCII already and pass through.
 */
export function asciiFold(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x80 ? char : (ASCII_FOLD[char] ?? '?');
  }
  return out;
}
