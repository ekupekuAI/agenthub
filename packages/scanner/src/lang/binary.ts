/** `file.binary`: executables, nested archives and binary files of unexpected types. */
import type { FileScan } from '../context';

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  sig.every((v, i) => b[at + i] === v);
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

const EXECUTABLES: { kind: string; test: (b: Uint8Array) => boolean }[] = [
  { kind: 'ELF executable', test: (b) => startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) },
  { kind: 'PE executable', test: (b) => startsWith(b, ascii('MZ')) },
  {
    kind: 'Mach-O executable',
    test: (b) =>
      startsWith(b, [0xfe, 0xed, 0xfa, 0xce]) ||
      startsWith(b, [0xfe, 0xed, 0xfa, 0xcf]) ||
      startsWith(b, [0xce, 0xfa, 0xed, 0xfe]) ||
      startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) ||
      startsWith(b, [0xca, 0xfe, 0xba, 0xbe]),
  },
  { kind: 'WebAssembly module', test: (b) => startsWith(b, [0x00, 0x61, 0x73, 0x6d]) },
];

const ARCHIVES: { kind: string; test: (b: Uint8Array) => boolean }[] = [
  {
    kind: 'zip',
    test: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]),
  },
  { kind: 'gzip', test: (b) => startsWith(b, [0x1f, 0x8b]) },
  { kind: '7z', test: (b) => startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { kind: 'rar', test: (b) => startsWith(b, ascii('Rar!')) },
  { kind: 'xz', test: (b) => startsWith(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) },
  { kind: 'bzip2', test: (b) => startsWith(b, ascii('BZh')) },
  { kind: 'zstd', test: (b) => startsWith(b, [0x28, 0xb5, 0x2f, 0xfd]) },
  { kind: 'cab', test: (b) => startsWith(b, ascii('MSCF')) },
  { kind: 'tar', test: (b) => startsWith(b, ascii('ustar'), 257) },
];

const ftyp = (b: Uint8Array): boolean => startsWith(b, ascii('ftyp'), 4);
const riff = (form: string) => (b: Uint8Array) =>
  startsWith(b, ascii('RIFF')) && startsWith(b, ascii(form), 8);

/** Expected binary types: images, fonts, media and documents, checked by signature. */
const MEDIA: Record<string, (b: Uint8Array) => boolean> = {
  png: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  jpeg: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  gif: (b) => startsWith(b, ascii('GIF8')),
  webp: riff('WEBP'),
  ico: (b) => startsWith(b, [0x00, 0x00, 0x01, 0x00]),
  cur: (b) => startsWith(b, [0x00, 0x00, 0x02, 0x00]),
  bmp: (b) => startsWith(b, ascii('BM')),
  tif: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  tiff: (b) => startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]),
  avif: ftyp,
  heic: ftyp,
  pdf: (b) => startsWith(b, ascii('%PDF')),
  woff: (b) => startsWith(b, ascii('wOFF')),
  woff2: (b) => startsWith(b, ascii('wOF2')),
  ttf: (b) => startsWith(b, [0x00, 0x01, 0x00, 0x00]) || startsWith(b, ascii('true')),
  otf: (b) => startsWith(b, ascii('OTTO')),
  mp3: (b) => startsWith(b, ascii('ID3')) || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  wav: riff('WAVE'),
  ogg: (b) => startsWith(b, ascii('OggS')),
  flac: (b) => startsWith(b, ascii('fLaC')),
  mp4: ftyp,
  m4a: ftyp,
  mov: ftyp,
  webm: (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3]),
};

/** Office and OpenDocument files are zip containers but expected document types. */
const DOCUMENTS = new Set(['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']);

function hex(bytes: Uint8Array): string {
  return Array.from(bytes.subarray(0, 8), (b) =>
    b.toString(16).toUpperCase().padStart(2, '0'),
  ).join(' ');
}

export function analyzeBinary(scan: FileScan, bytes: Uint8Array): void {
  const dot = scan.path.lastIndexOf('.');
  const ext = dot > scan.path.lastIndexOf('/') ? scan.path.slice(dot + 1).toLowerCase() : '';
  const evidence = `binary file, ${bytes.length} bytes, starts ${hex(bytes)}`;
  const report = (message: string, subject: string): void =>
    scan.add({ ruleId: 'file.binary', line: 0, message, subject, evidence });

  const exe = EXECUTABLES.find((s) => s.test(bytes));
  if (exe !== undefined) {
    report(
      `${exe.kind} shipped in the skill`,
      exe.kind.split(' ')[0]?.toLowerCase() ?? 'executable',
    );
    return;
  }

  const archive = ARCHIVES.find((s) => s.test(bytes));
  if (archive !== undefined && !(archive.kind === 'zip' && DOCUMENTS.has(ext))) {
    report(`Nested ${archive.kind} archive`, archive.kind);
    return;
  }
  if (DOCUMENTS.has(ext)) {
    if (archive?.kind !== 'zip') report(`Content does not match the .${ext} extension`, ext);
    return;
  }
  const check = MEDIA[ext];
  if (check !== undefined) {
    if (!check(bytes)) report(`Content does not match the .${ext} extension`, ext);
    return;
  }
  report(
    ext === '' ? 'Unexpected binary file' : `Unexpected binary file type (.${ext})`,
    ext === '' ? 'binary' : ext,
  );
}
