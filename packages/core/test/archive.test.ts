import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { TarEntry } from '../src/index';
import {
  archiveDigest,
  buildSkillPackage,
  createTar,
  DEFAULT_LIMITS,
  packSkill,
  readSkillArchive,
  readTarEntries,
} from '../src/index';
import {
  catchError,
  encode,
  hasControlChar,
  issueCodes,
  issuesOf,
  PNG_BYTES,
  sampleFiles,
  toCrlf,
  VALID_MANIFEST,
  VALID_SKILL_MD,
} from './helpers';

const gzip = (bytes: Uint8Array): Uint8Array => new Uint8Array(gzipSync(bytes));

/** A tar with a valid skill plus the given extra entries. */
function hostileArchive(extra: TarEntry[]): Uint8Array {
  return gzip(
    createTar([
      { path: 'SKILL.md', content: encode(VALID_SKILL_MD) },
      { path: 'agenthub.yaml', content: encode(VALID_MANIFEST) },
      ...extra,
    ]),
  );
}

/** Mutate one tar header and recompute its checksum so only the mutation is tested. */
function rewriteHeader(tar: Uint8Array, offset: number, mutate: (header: Uint8Array) => void) {
  const header = tar.subarray(offset, offset + 512);
  mutate(header);
  header.fill(0x20, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.set(encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
}

describe('packSkill', () => {
  it('round-trips a package with the same digest and files', () => {
    const pkg = buildSkillPackage(sampleFiles());
    const restored = readSkillArchive(packSkill(pkg));
    expect(restored.digest).toBe(pkg.digest);
    expect(restored.version).toBe(pkg.version);
    expect(restored.files).toEqual(pkg.files);
    expect(restored.files.find((f) => f.path === 'assets/logo.png')?.content).toEqual(PNG_BYTES);
  });

  it('produces identical bytes for the same input', () => {
    const a = packSkill(buildSkillPackage(sampleFiles()));
    const b = packSkill(buildSkillPackage([...sampleFiles()].reverse()));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(archiveDigest(a)).toBe(archiveDigest(b));
  });

  it('produces identical bytes for CRLF and LF inputs', () => {
    const lf = packSkill(buildSkillPackage(sampleFiles()));
    const crlf = packSkill(buildSkillPackage(sampleFiles({ 'SKILL.md': toCrlf(VALID_SKILL_MD) })));
    expect(Buffer.from(crlf).equals(Buffer.from(lf))).toBe(true);
  });

  it('writes a normalized gzip header and ustar entries', () => {
    const bytes = packSkill(buildSkillPackage(sampleFiles()));
    expect([...bytes.subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08]);
    expect([...bytes.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(bytes[9]).toBe(0xff);

    const tar = new Uint8Array(gunzipSync(bytes));
    const headers = new Map<string, string>();
    let offset = 0;
    while (tar[offset] !== 0) {
      const header = Buffer.from(tar.subarray(offset, offset + 512));
      const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
      headers.set(name, header.toString('latin1', 100, 108));
      expect(header.toString('latin1', 136, 148)).toBe('00000000000\0');
      expect(header.toString('latin1', 257, 265)).toBe('ustar\u000000');
      expect(String.fromCharCode(header[156] ?? 0)).toBe('0');
      const size = Number.parseInt(header.toString('latin1', 124, 135), 8);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    expect([...headers.keys()]).toEqual([
      'SKILL.md',
      'agenthub.yaml',
      'assets/logo.png',
      'references/a/b.md',
      'scripts/run.sh',
    ]);
    expect(headers.get('scripts/run.sh')).toBe('0000755\0');
    expect(headers.get('SKILL.md')).toBe('0000644\0');
    expect(tar.length % 512).toBe(0);
  });

  it('stores long paths with the ustar prefix field', () => {
    const long = `${'d'.repeat(90)}/${'e'.repeat(60)}.md`;
    const pkg = buildSkillPackage(sampleFiles({ [long]: 'long\n' }));
    const restored = readSkillArchive(packSkill(pkg));
    expect(restored.files.map((f) => f.path)).toContain(long);
    expect(restored.digest).toBe(pkg.digest);
  });

  it('refuses to pack an unsafe path', () => {
    const pkg = buildSkillPackage(sampleFiles());
    const tampered = { ...pkg, files: [...pkg.files, { ...pkg.files[0], path: '../x' }] };
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed package
    const error = catchError(() => packSkill(tampered as any));
    expect(error.code).toBe('VALIDATION');
  });
});

describe('readSkillArchive', () => {
  it('accepts a matching expectedDigest and an old-style "\\0" typeflag', () => {
    const pkg = buildSkillPackage(sampleFiles());
    expect(readSkillArchive(packSkill(pkg), { expectedDigest: pkg.digest }).name).toBe(
      'web-testing',
    );
    const legacy = hostileArchive([{ path: 'notes.md', content: encode('n\n'), type: '\0' }]);
    expect(readSkillArchive(legacy).files.map((f) => f.path)).toContain('notes.md');
  });

  it('rejects an expectedDigest mismatch with INTEGRITY', () => {
    const pkg = buildSkillPackage(sampleFiles());
    const other = `sha256:${'0'.repeat(64)}`;
    const error = catchError(() => readSkillArchive(packSkill(pkg), { expectedDigest: other }));
    expect(error.code).toBe('INTEGRITY');
    expect(error.details).toEqual({ expected: other, actual: pkg.digest });
  });

  it('checks the folder name when given', () => {
    const bytes = packSkill(buildSkillPackage(sampleFiles()));
    expect(readSkillArchive(bytes, { folderName: 'web-testing' }).name).toBe('web-testing');
    const error = catchError(() => readSkillArchive(bytes, { folderName: 'other' }));
    expect(issueCodes(error)).toEqual(['name.folder-mismatch']);
  });

  it.each<[string, TarEntry]>([
    ['symlink', { path: 'leak', content: new Uint8Array(), type: '2', linkName: '/etc/passwd' }],
    ['hard link', { path: 'hard', content: new Uint8Array(), type: '1', linkName: 'SKILL.md' }],
    ['directory', { path: 'scripts/', content: new Uint8Array(), type: '5' }],
    ['character device', { path: 'tty', content: new Uint8Array(), type: '3' }],
    ['FIFO', { path: 'pipe', content: new Uint8Array(), type: '6' }],
    ['pax header', { path: 'PaxHeader', content: encode('30 path=../../evil\n'), type: 'x' }],
    ['pax global header', { path: 'global', content: encode('20 comment=hi\n'), type: 'g' }],
    ['GNU long name', { path: '././@LongLink', content: encode('../evil\0'), type: 'L' }],
  ])('rejects a %s entry with VALIDATION', (_label, entry) => {
    const error = catchError(() => readSkillArchive(hostileArchive([entry])));
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toMatch(/unsupported archive entry/);
    expect(error.message).toContain(entry.path);
  });

  it.each([
    ['parent traversal', '../evil'],
    ['nested traversal', 'scripts/../../evil'],
    ['absolute path', '/abs'],
    ['drive letter', 'C:/x'],
    ['reserved name', 'CON.txt'],
    ['backslash', 'scripts\\run.sh'],
    ['.git directory', '.git/hooks/post-checkout'],
  ])('rejects a %s entry with VALIDATION', (_label, path) => {
    const error = catchError(() =>
      readSkillArchive(hostileArchive([{ path, content: encode('x') }])),
    );
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toMatch(/unsafe archive entry/);
  });

  it('rejects names that collide by case', () => {
    const error = catchError(() =>
      readSkillArchive(
        hostileArchive([
          { path: 'A.md', content: encode('a') },
          { path: 'a.md', content: encode('b') },
        ]),
      ),
    );
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual(['path.case-collision', 'path.case-collision']);
  });

  it('rejects duplicate entries', () => {
    const error = catchError(() =>
      readSkillArchive(
        hostileArchive([
          { path: 'x.md', content: encode('first') },
          { path: 'x.md', content: encode('second') },
        ]),
      ),
    );
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toMatch(/duplicate/);
  });

  it('rejects a corrupted header checksum with INTEGRITY', () => {
    const tar = createTar([{ path: 'SKILL.md', content: encode(VALID_SKILL_MD) }]);
    tar[0] = 'X'.charCodeAt(0);
    const error = catchError(() => readSkillArchive(gzip(tar)));
    expect(error.code).toBe('INTEGRITY');
    expect(error.message).toMatch(/checksum/);
  });

  it('rejects a non-ustar header with VALIDATION', () => {
    const tar = createTar([{ path: 'SKILL.md', content: encode(VALID_SKILL_MD) }]);
    rewriteHeader(tar, 0, (header) => header.set(encode('ustar  \0'), 257));
    expect(catchError(() => readSkillArchive(gzip(tar))).code).toBe('VALIDATION');
  });

  it('rejects base-256 sizes with INTEGRITY', () => {
    const tar = createTar([{ path: 'SKILL.md', content: encode(VALID_SKILL_MD) }]);
    rewriteHeader(tar, 0, (header) => {
      header[124] = 0x80;
    });
    expect(catchError(() => readSkillArchive(gzip(tar))).code).toBe('INTEGRITY');
  });

  it('rejects truncated gzip data with INTEGRITY', () => {
    const bytes = packSkill(buildSkillPackage(sampleFiles()));
    const error = catchError(() => readSkillArchive(bytes.subarray(0, bytes.length / 2)));
    expect(error.code).toBe('INTEGRITY');
  });

  it('rejects data that is not gzip with INTEGRITY', () => {
    const tar = createTar([{ path: 'SKILL.md', content: encode(VALID_SKILL_MD) }]);
    expect(catchError(() => readSkillArchive(tar)).code).toBe('INTEGRITY');
    expect(catchError(() => readSkillArchive(new Uint8Array())).code).toBe('INTEGRITY');
  });

  it('rejects a truncated tar with INTEGRITY', () => {
    const tar = createTar([{ path: 'SKILL.md', content: encode(VALID_SKILL_MD) }]);
    const cut = tar.subarray(0, 512 + 100);
    expect(catchError(() => readSkillArchive(gzip(cut))).code).toBe('INTEGRITY');
    const noEnd = tar.subarray(0, tar.length - 1024);
    expect(catchError(() => readSkillArchive(gzip(noEnd))).code).toBe('INTEGRITY');
  });

  it('rejects data hidden after the end-of-archive marker with INTEGRITY', () => {
    const tar = createTar([{ path: 'SKILL.md', content: encode(VALID_SKILL_MD) }]);
    const hidden = createTar([{ path: 'hidden.sh', content: encode('#!/bin/sh\n') }]);
    const joined = new Uint8Array(tar.length + hidden.length);
    joined.set(tar);
    joined.set(hidden, tar.length);
    expect(catchError(() => readSkillArchive(gzip(joined))).code).toBe('INTEGRITY');
  });

  it('enforces size and count limits with VALIDATION', () => {
    const bytes = hostileArchive([{ path: 'big.txt', content: encode('x'.repeat(4096)) }]);
    const perFile = catchError(() =>
      readSkillArchive(bytes, { limits: { ...DEFAULT_LIMITS, maxFileBytes: 1024 } }),
    );
    expect(perFile.code).toBe('VALIDATION');
    expect(perFile.message).toMatch(/big\.txt/);

    const total = catchError(() =>
      readSkillArchive(bytes, { limits: { ...DEFAULT_LIMITS, maxTotalBytes: 2048 } }),
    );
    expect(total.code).toBe('VALIDATION');

    const count = catchError(() =>
      readSkillArchive(bytes, { limits: { ...DEFAULT_LIMITS, maxFiles: 2 } }),
    );
    expect(count.code).toBe('VALIDATION');
    expect(count.message).toMatch(/more than 2 files/);
  });

  it('stops a decompression bomb before it is fully inflated', () => {
    const bomb = hostileArchive([{ path: 'zeros.txt', content: new Uint8Array(4 * 1024 * 1024) }]);
    expect(bomb.length).toBeLessThan(64 * 1024);
    const limits = { ...DEFAULT_LIMITS, maxFiles: 4, maxTotalBytes: 64 * 1024 };
    const error = catchError(() => readSkillArchive(bomb, { limits }));
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual(['package.too-large']);
    expect(error.message).toMatch(/decompression bomb/);
  });

  it('stops a decompression bomb with the default limits', () => {
    const bomb = hostileArchive([{ path: 'zeros.txt', content: new Uint8Array(12 * 1024 * 1024) }]);
    expect(catchError(() => readSkillArchive(bomb)).code).toBe('VALIDATION');
  });

  it('reports an honest oversized package as VALIDATION, not INTEGRITY', () => {
    const big = hostileArchive([
      { path: 'a.txt', content: new Uint8Array(5 * 1024 * 1024).fill(0x61) },
      { path: 'b.txt', content: new Uint8Array(5 * 1024 * 1024).fill(0x62) },
      { path: 'c.txt', content: new Uint8Array(1024 * 1024).fill(0x63) },
    ]);
    const error = catchError(() => readSkillArchive(big));
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual(['package.too-large']);
  });
});

describe('readSkillArchive: hidden bytes', () => {
  const valid = (): Uint8Array => packSkill(buildSkillPackage(sampleFiles()));
  const join = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  };

  it('accepts the packer output', () => {
    expect(readSkillArchive(valid()).name).toBe('web-testing');
  });

  it('rejects data after the gzip stream', () => {
    const zeroThenGarbage = join(valid(), new Uint8Array([0, 0x41, 0x42, 0x43]));
    expect(catchError(() => readSkillArchive(zeroThenGarbage)).code).toBe('INTEGRITY');
    const zeros = join(valid(), new Uint8Array(1000));
    expect(catchError(() => readSkillArchive(zeros)).code).toBe('INTEGRITY');
  });

  it('rejects a multi-member gzip', () => {
    const second = gzip(encode('payload'));
    expect(catchError(() => readSkillArchive(join(valid(), second))).code).toBe('INTEGRITY');
  });

  it('rejects a corrupted gzip trailer', () => {
    const bytes = valid();
    bytes[bytes.length - 6] = (bytes[bytes.length - 6] as number) ^ 0xff;
    expect(catchError(() => readSkillArchive(bytes)).code).toBe('INTEGRITY');
  });

  it('accepts a gzip header with a file name and comment', () => {
    const tar = new Uint8Array(gunzipSync(valid()));
    const plain = gzip(tar);
    const header = new Uint8Array(plain.subarray(0, 10));
    header[3] = 0x08 | 0x10;
    const withName = join(header, encode('pkg.tar\0note\0'), plain.subarray(10));
    expect(readSkillArchive(withName).name).toBe('web-testing');
  });

  it('rejects non-zero padding after a tar entry', () => {
    const tar = createTar([
      { path: 'SKILL.md', content: encode(VALID_SKILL_MD) },
      { path: 'agenthub.yaml', content: encode(VALID_MANIFEST) },
    ]);
    const end = 512 + encode(VALID_SKILL_MD).length;
    tar[end] = 0x41;
    expect(catchError(() => readSkillArchive(gzip(tar))).code).toBe('INTEGRITY');
  });
});

describe('readSkillArchive: entry names', () => {
  it.each([
    '.agenthub/config.json',
    'node_modules/x/index.js',
    '.DS_Store',
    'sub/Thumbs.db',
    'desktop.ini',
  ])('rejects the pack-excluded entry %s', (path) => {
    const error = catchError(() =>
      readSkillArchive(hostileArchive([{ path, content: encode('{}') }])),
    );
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual(['path.excluded']);
  });

  it('escapes control characters in the name of an unsupported entry', () => {
    const name = 'evil\u001b[2J\u001b[31mFAKE\u009b';
    const error = catchError(() =>
      readSkillArchive(hostileArchive([{ path: name, content: new Uint8Array(), type: '2' }])),
    );
    expect(error.code).toBe('VALIDATION');
    expect(hasControlChar(error.message)).toBe(false);
    for (const issue of issuesOf(error)) expect(hasControlChar(issue.path ?? '')).toBe(false);
    expect(error.message).toContain('\\u001b');
  });

  it('keeps a byte order mark in an entry name so it is rejected', () => {
    const tar = createTar([
      { path: 'SKILL.mdx', content: encode(VALID_SKILL_MD) },
      { path: 'agenthub.yaml', content: encode(VALID_MANIFEST) },
    ]);
    rewriteHeader(tar, 0, (header) => {
      header.fill(0, 0, 100);
      header.set([0xef, 0xbb, 0xbf, ...encode('SKILL.md')], 0);
    });
    const error = catchError(() => readSkillArchive(gzip(tar)));
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toMatch(/invisible/);
  });
});

describe('createTar / readTarEntries', () => {
  it('round-trips raw entries', () => {
    const entries = [
      { path: 'a.txt', content: encode('hello') },
      { path: 'empty.txt', content: new Uint8Array() },
      { path: 'block.bin', content: new Uint8Array(512).fill(7) },
    ];
    expect(readTarEntries(createTar(entries))).toEqual(entries);
  });

  it('rejects a path that cannot fit a ustar header', () => {
    expect(
      catchError(() => createTar([{ path: 'n'.repeat(101), content: encode('x') }])).code,
    ).toBe('VALIDATION');
  });
});
