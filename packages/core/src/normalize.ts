import type { PackageFile } from './types';

const CR = 0x0d;
const LF = 0x0a;

/** True when the bytes are valid UTF-8 and contain no NUL byte. */
export function isTextContent(content: Uint8Array): boolean {
  if (content.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

/** Replace every CRLF pair with LF. Lone CR bytes are kept. Always returns a new array. */
export function crlfToLf(content: Uint8Array): Uint8Array {
  const out = new Uint8Array(content.length);
  let length = 0;
  for (let i = 0; i < content.length; i++) {
    const byte = content[i] as number;
    if (byte === CR && content[i + 1] === LF) continue;
    out[length++] = byte;
  }
  return out.slice(0, length);
}

/**
 * Normalize one package file (design §5.3): text files (valid UTF-8, no NUL) get LF line
 * endings; binary files are copied byte-exact. Executable when the content starts with "#!".
 */
export function normalizeFile(path: string, content: Uint8Array): PackageFile {
  const text = isTextContent(content);
  return {
    path,
    content: text ? crlfToLf(content) : new Uint8Array(content),
    kind: text ? 'text' : 'binary',
    executable: content[0] === 0x23 && content[1] === 0x21,
  };
}
