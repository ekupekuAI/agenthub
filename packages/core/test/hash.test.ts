import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { archiveDigest, contentDigest, fileHash, sha256Hex } from '../src/index';
import { catchError, encode } from './helpers';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('hashing', () => {
  it('computes SHA-256 hex and prefixed file hashes', () => {
    expect(sha256Hex(encode('abc'))).toBe(ABC_SHA256);
    expect(fileHash(encode('abc'))).toBe(`sha256:${ABC_SHA256}`);
    expect(archiveDigest(encode('abc'))).toBe(`sha256:${ABC_SHA256}`);
  });

  it('builds the content digest from sorted "<hex>  <path>" lines', () => {
    const a = fileHash(encode('a'));
    const b = fileHash(encode('b'));
    const hashes = { 'b.md': b, 'SKILL.md': a, 'a/x.md': a };
    const manifest = `${a.slice(7)}  SKILL.md\n${a.slice(7)}  a/x.md\n${b.slice(7)}  b.md\n`;
    const expected = `sha256:${createHash('sha256').update(manifest).digest('hex')}`;
    expect(contentDigest(hashes)).toBe(expected);
  });

  it('is independent of key insertion order and sorts by UTF-8 bytes', () => {
    const h = fileHash(encode('x'));
    // U+FF21 (3 UTF-8 bytes, 0xEF..) sorts after U+1F600 (4 bytes, 0xF0..) in UTF-16 order
    // but before it in UTF-8 byte order.
    const one = { '\u{1F600}.md': h, 'Ａ.md': h, 'a.md': h };
    const two = { 'a.md': h, 'Ａ.md': h, '\u{1F600}.md': h };
    expect(contentDigest(one)).toBe(contentDigest(two));
    const manifest = `${h.slice(7)}  a.md\n${h.slice(7)}  Ａ.md\n${h.slice(7)}  \u{1F600}.md\n`;
    expect(contentDigest(one)).toBe(
      `sha256:${createHash('sha256').update(manifest).digest('hex')}`,
    );
  });

  it('changes when any file hash or path changes', () => {
    const h = fileHash(encode('x'));
    expect(contentDigest({ 'a.md': h })).not.toBe(contentDigest({ 'b.md': h }));
    expect(contentDigest({ 'a.md': h })).not.toBe(contentDigest({ 'a.md': fileHash(encode('y')) }));
  });

  it('rejects malformed file hashes', () => {
    const error = catchError(() => contentDigest({ 'a.md': 'md5:abc' }));
    expect(error.code).toBe('INTEGRITY');
  });
});
