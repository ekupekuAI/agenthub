/**
 * Text hygiene for values that come from uploads or request bodies and are stored, shown on
 * the site or printed by the CLI.
 */

/** C0/C1 control characters except tab, line feed and carriage return. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
/** Bidirectional overrides/isolates and marks, zero-width characters, BOM, Unicode tags. */
const INVISIBLE =
  /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

/** True when the text holds a control character other than tab, LF and CR. */
export function hasControlChars(text: string): boolean {
  CONTROL.lastIndex = 0;
  return CONTROL.test(text);
}

/**
 * Remove control, bidi-override, zero-width and tag characters. With `singleLine`, line
 * breaks and tabs become spaces and runs of whitespace collapse.
 */
export function cleanText(text: string, opts: { singleLine?: boolean; max?: number } = {}): string {
  let out = text.replace(CONTROL, '').replace(INVISIBLE, '');
  if (opts.singleLine) out = out.replace(/\s+/g, ' ').trim();
  if (opts.max !== undefined && out.length > opts.max) out = out.slice(0, opts.max);
  return out;
}

const NUL = String.fromCharCode(0);

/** Postgres text and jsonb cannot hold NUL; strip it from every string in a JSON value. */
export function stripNulDeep<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll(NUL, '') as T;
  if (Array.isArray(value)) return value.map((v) => stripNulDeep(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key.replaceAll(NUL, '')] = stripNulDeep(v);
    return out as T;
  }
  return value;
}
