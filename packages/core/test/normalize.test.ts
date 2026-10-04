import { describe, expect, it } from 'vitest';
import { normalizeFile } from '../src/index';
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
