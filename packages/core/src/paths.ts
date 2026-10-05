import { Buffer } from 'node:buffer';
import { DEFAULT_LIMITS } from './limits';
import type { PackageLimits } from './types';

/** Windows device names, reserved with or without an extension (design §5.4). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/** Characters Windows refuses in file names; ':' is handled separately (alternate data streams). */
const WINDOWS_INVALID_CHARS = new Set(['<', '>', '"', '|', '?', '*']);

/** ustar field sizes, in bytes. */
const USTAR_NAME_BYTES = 100;
const USTAR_PREFIX_BYTES = 155;

/** Compare two paths by their UTF-8 bytes (the package sort order). */
export function comparePaths(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function isControlChar(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/** True for a Windows device name such as `con`, `nul`, `com1` or `lpt9` (any case). */
export function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED.test(name);
}

/**
 * Characters that render as nothing, as blank space, or as a path separator: Unicode
 * whitespace other than the ASCII space, default-ignorable code points (variation selectors,
 * Hangul fillers, the combining grapheme joiner, tag characters), line/paragraph separators,
 * the braille blank and slash look-alikes.
 */
const INVISIBLE_OR_CONFUSABLE =
  /[\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}⠀⁄∕∖╱╲⧵⧸⧹﹨／＼]|[^\S ]/u;

/** Characters escaped by {@link escapeForDisplay}. */
const UNSAFE_FOR_DISPLAY =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]|[^\S ]/u;

const SHORT_ESCAPES: Record<string, string> = {
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '"': '\\"',
  '\\': '\\\\',
};

/**
 * Make an untrusted string safe to print inside double quotes in a terminal, log or error
 * message: quotes and backslashes are escaped as in JSON, and every control, invisible,
 * bidi, unpaired-surrogate or non-ASCII whitespace character becomes a `\uXXXX` escape
 * (`\u{XXXXX}` above U+FFFF). For plain text the result equals `JSON.stringify(s).slice(1, -1)`.
 */
export function escapeForDisplay(value: string): string {
  return escapeChars(value, true);
}

/**
 * Like {@link escapeForDisplay} but leaves quotes and backslashes alone: for text that is
 * already a message (such as a validator's), where only unsafe characters must go.
 */
export function escapeUnsafeChars(value: string): string {
  return escapeChars(value, false);
}

function escapeChars(value: string, quote: boolean): string {
  let out = '';
  for (const ch of value) {
    const short = quote || (ch !== '"' && ch !== '\\') ? SHORT_ESCAPES[ch] : undefined;
    if (short !== undefined) {
      out += short;
    } else if (UNSAFE_FOR_DISPLAY.test(ch)) {
      const cp = ch.codePointAt(0) as number;
      out += cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Split a path into the ustar `prefix` and `name` fields, or return null when it cannot be
 * stored in a plain ustar header (name ≤ 100 bytes, prefix ≤ 155 bytes, split at a '/').
 */
export function splitTarPath(path: string): { prefix: string; name: string } | null {
  if (Buffer.byteLength(path, 'utf8') <= USTAR_NAME_BYTES) return { prefix: '', name: path };
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(name, 'utf8') > USTAR_NAME_BYTES) return null;
    if (name.length > 0 && Buffer.byteLength(prefix, 'utf8') <= USTAR_PREFIX_BYTES) {
      return { prefix, name };
    }
  }
  return null;
}

function checkSegment(segment: string, path: string): string | null {
  if (segment === '') return `path "${path}" contains an empty segment`;
  if (segment === '.' || segment === '..') {
    return `path "${path}" contains a "${segment}" segment`;
  }
  if (segment.toLowerCase() === '.git') return `path "${path}" contains a ".git" segment`;
  if (segment === '__proto__') return `path "${path}" uses the reserved name "__proto__"`;
  if (segment.endsWith(' ') || segment.endsWith('.')) {
    return `path "${path}" has a name ending in a space or dot ("${segment}")`;
  }
  const base = (segment.split('.')[0] ?? '').replace(/ +$/, '');
  if (WINDOWS_RESERVED.test(base)) {
    return `path "${path}" uses the Windows reserved name "${segment}"`;
  }
  return null;
}

/**
 * Check one package path against the path-safety rules (design §5.4).
 * Returns a human-readable reason when the path is rejected, or null when it is safe.
 */
export function checkPackagePath(
  path: string,
  limits: PackageLimits = DEFAULT_LIMITS,
): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'path is empty';
  const shown = escapeForDisplay(path);
  for (let i = 0; i < path.length; i++) {
    if (isControlChar(path.charCodeAt(i))) {
      return `path "${shown}" contains a control character`;
    }
  }
  if (/\p{Cs}/u.test(path)) return `path "${shown}" is not valid Unicode (unpaired surrogate)`;
  if (/\p{Cf}/u.test(path)) {
    return `path "${shown}" contains an invisible formatting character (such as a bidi override)`;
  }
  if (INVISIBLE_OR_CONFUSABLE.test(path)) {
    return `path "${shown}" contains an invisible, blank or slash-like character`;
  }
  if (path.includes('\\')) return `path "${path}" contains a backslash`;
  if (path.startsWith('/')) return `path "${path}" is absolute`;
  if (/^[A-Za-z]:/.test(path)) return `path "${path}" starts with a drive letter`;
  if (path.includes(':')) return `path "${path}" contains ":"`;
  for (const ch of path) {
    if (WINDOWS_INVALID_CHARS.has(ch)) {
      return `path "${path}" contains "${ch}", which is not allowed in Windows file names`;
    }
  }
  if (path.normalize('NFC') !== path) return `path "${path}" is not in Unicode NFC form`;
  if (path.length > limits.maxPathLength) {
    return `path "${path}" is longer than ${limits.maxPathLength} characters`;
  }
  const segments = path.split('/');
  for (const segment of segments) {
    const problem = checkSegment(segment, path);
    if (problem !== null) return problem;
  }
  if (segments.length > limits.maxDepth) {
    return `path "${path}" is nested deeper than ${limits.maxDepth} levels`;
  }
  if (splitTarPath(path) === null) {
    return `path "${path}" is too long to store in a ustar archive`;
  }
  return null;
}

function foldCase(value: string): string {
  return value.normalize('NFC').toUpperCase().toLowerCase();
}

/**
 * Return every path that collides with another path when compared case-insensitively,
 * including collisions between directory names (`A/x.md` and `a/y.md`). Sorted, unique.
 */
export function findCaseCollisions(paths: string[]): string[] {
  const spellings = new Map<string, Set<string>>();
  const prefixesOf = (path: string): string[] => {
    const segments = path.split('/');
    return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  };
  for (const path of paths) {
    for (const prefix of prefixesOf(path)) {
      const key = foldCase(prefix);
      const set = spellings.get(key) ?? new Set<string>();
      set.add(prefix);
      spellings.set(key, set);
    }
  }
  const colliding = new Set<string>();
  for (const set of spellings.values()) {
    if (set.size > 1) for (const spelling of set) colliding.add(spelling);
  }
  if (colliding.size === 0) return [];
  const result = new Set<string>();
  for (const path of paths) {
    if (prefixesOf(path).some((prefix) => colliding.has(prefix))) result.add(path);
  }
  return [...result].sort(comparePaths);
}
