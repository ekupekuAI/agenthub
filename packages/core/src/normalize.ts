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

/**
 * Extensions of files that are always text: scripts and source code an agent may run, markup
 * an agent may read, and common data/config formats. Such a file is never classified as
 * binary just because it holds a stray invalid UTF-8 byte, so it cannot dodge the scanner.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // markup and prose
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'rst',
  'adoc',
  'asciidoc',
  'org',
  'tex',
  'html',
  'htm',
  'xhtml',
  'xml',
  'svg',
  'css',
  'scss',
  'less',
  // shells and Windows scripts
  'sh',
  'bash',
  'zsh',
  'ksh',
  'csh',
  'tcsh',
  'fish',
  'command',
  'ps1',
  'psm1',
  'psd1',
  'bat',
  'cmd',
  'vbs',
  'vba',
  'wsf',
  'ahk',
  'applescript',
  // programming languages
  'js',
  'mjs',
  'cjs',
  'jsx',
  'ts',
  'mts',
  'cts',
  'tsx',
  'py',
  'pyw',
  'pyi',
  'rb',
  'pl',
  'pm',
  'php',
  'lua',
  'r',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'cs',
  'scala',
  'groovy',
  'gradle',
  'awk',
  'sed',
  'tcl',
  'dart',
  'jl',
  'ex',
  'exs',
  'erl',
  'hs',
  'clj',
  'el',
  'nim',
  'zig',
  'sql',
  // data and configuration
  'json',
  'jsonc',
  'json5',
  'jsonl',
  'ndjson',
  'ipynb',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'csv',
  'tsv',
  'mk',
  'make',
  'cmake',
  'dockerfile',
]);

/** Extension-less file names that are always text. */
const TEXT_BASENAMES: ReadonlySet<string> = new Set([
  'makefile',
  'dockerfile',
  'containerfile',
  'justfile',
  'rakefile',
  'gemfile',
  'procfile',
  'vagrantfile',
  'brewfile',
]);

function startsWithShebang(content: Uint8Array): boolean {
  return content[0] === 0x23 && content[1] === 0x21;
}

/**
 * True when the path names a file that must be text: a script, source, markup or text/config
 * format by extension (case-insensitive) or a well-known extension-less text file name.
 */
export function isTextPath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (TEXT_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  return dot !== -1 && TEXT_EXTENSIONS.has(base.slice(dot + 1));
}

/** True when the file must be handled as text: a text path, or content starting with "#!". */
function mustBeText(path: string, content: Uint8Array): boolean {
  return isTextPath(path) || startsWithShebang(content);
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0): boolean =>
  signature.every((value, i) => bytes[at + i] === value);
const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0));

/** Leading signatures of executables and archives (shipped binaries the scanner must see). */
const BINARY_SIGNATURES: readonly (readonly number[])[] = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  ascii('MZ'), // PE
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O
  [0x00, 0x61, 0x73, 0x6d], // WebAssembly
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06], // zip
  [0x1f, 0x8b], // gzip
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  ascii('Rar!'),
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  ascii('BZh'),
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  ascii('MSCF'), // cab
];

function hasBinarySignature(content: Uint8Array): boolean {
  return (
    BINARY_SIGNATURES.some((signature) => startsWith(content, signature)) ||
    startsWith(content, ascii('ustar'), 257)
  );
}

/**
 * Encoding rule for files that must be text ({@link isTextPath}, or content starting with
 * "#!"). Returns a reason when the file is rejected, or null when it is acceptable:
 * - valid UTF-8 without NUL bytes: accepted;
 * - any NUL byte (binary content, UTF-16 or a planted NUL): rejected;
 * - invalid UTF-8 starting with an executable or archive signature: rejected;
 * - other invalid UTF-8 (such as Latin-1 text): accepted, and classified as text.
 * Files that need not be text (images, fonts, unknown types) are always accepted here.
 * Together with {@link normalizeFile} this means no script, source or markdown file ever
 * reaches the scanner as opaque binary, and no shipped executable or archive hides behind a
 * script extension.
 */
export function checkFileEncoding(path: string, content: Uint8Array): string | null {
  if (isTextContent(content) || !mustBeText(path, content)) return null;
  if (content.includes(0)) {
    return `"${path}" must be UTF-8 text but contains NUL bytes (binary data and UTF-16 are not allowed in scripts, source, markdown or text files)`;
  }
  if (hasBinarySignature(content)) {
    return `"${path}" must be text but contains executable or archive data`;
  }
  return null;
}

/**
 * Replace every CRLF with LF, treating a run of CRs right before an LF as part of the line
 * ending (`\r\r\n` becomes `\n`). Lone CR bytes are kept. Idempotent:
 * `crlfToLf(crlfToLf(x))` equals `crlfToLf(x)`. Linear time. Always returns a new array.
 */
export function crlfToLf(content: Uint8Array): Uint8Array {
  const out = new Uint8Array(content.length);
  let length = 0;
  let i = 0;
  while (i < content.length) {
    const byte = content[i] as number;
    if (byte !== CR) {
      out[length++] = byte;
      i++;
      continue;
    }
    let end = i + 1;
    while (content[end] === CR) end++;
    if (content[end] !== LF) {
      for (; i < end; i++) out[length++] = CR;
    }
    i = end;
  }
  return out.slice(0, length);
}

/**
 * Normalize one package file (design §5.3). A file is text when it is valid UTF-8 without NUL
 * bytes, or when it must be text (script, source, markdown or text format by name, or "#!"
 * content) and has no NUL byte; text files get LF line endings, so their hash survives a CRLF
 * checkout. Everything else is binary and copied byte-exact. Executable when the content
 * starts with "#!". Idempotent: normalizing the normalized content changes nothing.
 */
export function normalizeFile(path: string, content: Uint8Array): PackageFile {
  const text = isTextContent(content) || (mustBeText(path, content) && !content.includes(0));
  return {
    path,
    content: text ? crlfToLf(content) : new Uint8Array(content),
    kind: text ? 'text' : 'binary',
    executable: startsWithShebang(content),
  };
}
