/** Text decoding, invisible-character classification and evidence excerpts. */

export const EVIDENCE_MAX = 120;

/**
 * Decodes bytes as UTF-8 text. Returns null for binary content: invalid UTF-8 or any NUL
 * byte (the same rule core uses for normalization, design §5.3). A leading BOM is dropped.
 */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function isBinaryContent(bytes: Uint8Array): boolean {
  return decodeText(bytes) === null;
}

/** Splits text into lines, accepting LF and CRLF endings. */
export function splitLines(text: string): string[] {
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

export type InvisibleKind = 'zero-width' | 'bidi' | 'tag' | 'control' | 'other';

/** Classifies characters that render as nothing (or reorder text) and so can hide content. */
export function invisibleKind(cp: number): InvisibleKind | null {
  if ((cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || cp === 0xfeff) return 'zero-width';
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return 'bidi';
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'tag';
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 'control';
  if (
    cp === 0x00ad ||
    cp === 0x034f ||
    cp === 0x061c ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180f) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    (cp >= 0x2061 && cp <= 0x206f) ||
    cp === 0x3164 ||
    cp === 0xffa0 ||
    (cp >= 0xfff9 && cp <= 0xfffb) ||
    (cp >= 0x1d173 && cp <= 0x1d17a) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  ) {
    return 'other';
  }
  return null;
}

export function escapeCodePoint(cp: number): string {
  return `\\u{${cp.toString(16).toUpperCase().padStart(4, '0')}}`;
}

/** Renders control, zero-width, bidi, tag and other invisible characters as `\u{XXXX}`. */
export function escapeInvisible(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out += invisibleKind(cp) === null ? ch : escapeCodePoint(cp);
  }
  return out;
}

/**
 * Builds a finding excerpt of at most 120 UTF-16 code units. Tabs become spaces, invisible
 * characters are escaped, and long lines are cut around `focus` (a UTF-16 index into
 * `line`) with an ellipsis on each cut side. An escape is never split.
 */
export function makeEvidence(line: string, focus = 0): string {
  const pieces: string[] = [];
  let focusPiece = 0;
  let index = 0;
  for (const ch of line) {
    if (index <= focus) focusPiece = pieces.length;
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '\t') pieces.push(' ');
    else pieces.push(invisibleKind(cp) === null ? ch : escapeCodePoint(cp));
    index += ch.length;
  }
  // Trim plain whitespace at both ends.
  let first = 0;
  let last = pieces.length;
  while (first < last && pieces[first] === ' ') first++;
  while (last > first && pieces[last - 1] === ' ') last--;
  const kept = pieces.slice(first, last);
  focusPiece = Math.min(Math.max(focusPiece - first, 0), Math.max(kept.length - 1, 0));

  const full = kept.join('');
  if (full.length <= EVIDENCE_MAX) return full;

  const start = Math.max(0, focusPiece - 30);
  let out = start > 0 ? '…' : '';
  let i = start;
  for (; i < kept.length; i++) {
    const piece = kept[i] as string;
    const reserve = i < kept.length - 1 ? 1 : 0;
    if (out.length + piece.length + reserve > EVIDENCE_MAX) break;
    out += piece;
  }
  if (i < kept.length) out += '…';
  return out;
}
