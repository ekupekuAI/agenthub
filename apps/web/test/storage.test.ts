import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertValidKey, LocalFsStore, storageKeyFor } from '../src/storage';

const bytes = (text: string) => new TextEncoder().encode(text);
const keyOf = (b: Uint8Array) => `sha256/${createHash('sha256').update(b).digest('hex')}.skillpkg`;

describe('LocalFsStore', () => {
  let root: string;
  let store: LocalFsStore;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'agenthub-store-'));
    store = new LocalFsStore(path.join(root, 'artifacts'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stores and reads back an artifact', async () => {
    const data = bytes('hello');
    const key = keyOf(data);
    expect(await store.exists(key)).toBe(false);
    await store.put(key, data);
    expect(await store.exists(key)).toBe(true);
    expect(Buffer.from((await store.get(key)) ?? []).toString()).toBe('hello');
  });

  it('treats a repeated identical write as success', async () => {
    const data = bytes('same');
    const key = keyOf(data);
    await store.put(key, data);
    await expect(store.put(key, data)).resolves.toBeUndefined();
  });

  it('refuses to overwrite a key with different bytes', async () => {
    const data = bytes('original');
    const key = keyOf(data);
    await store.put(key, data);
    await expect(store.put(key, bytes('tampered'))).rejects.toThrow(/different content/);
    expect(Buffer.from((await store.get(key)) ?? []).toString()).toBe('original');
  });

  it('replaces a truncated leftover at the key instead of failing forever', async () => {
    const data = bytes('complete artifact contents');
    const key = keyOf(data);
    const file = path.join(root, 'artifacts', ...key.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data.slice(0, 5)); // an interrupted earlier write
    await store.put(key, data);
    expect(Buffer.from((await store.get(key)) ?? []).toString()).toBe('complete artifact contents');
  });

  it('accepts concurrent writes of the same bytes and leaves no temp files', async () => {
    const data = new Uint8Array(4 * 1024 * 1024).fill(7);
    const key = keyOf(data);
    await Promise.all([store.put(key, data), store.put(key, data), store.put(key, data)]);
    expect(Buffer.from((await store.get(key)) ?? []).equals(Buffer.from(data))).toBe(true);
    const dir = path.join(root, 'artifacts', 'sha256');
    expect((await readdir(dir)).some((f) => f.startsWith('.tmp-'))).toBe(false);
  });

  it('refuses bytes that do not match their content address', async () => {
    const key = keyOf(bytes('one'));
    await expect(store.put(key, bytes('two'))).rejects.toThrow(/do not match/);
    expect(await store.exists(key)).toBe(false);
  });

  it('deletes artifacts (missing keys are ignored)', async () => {
    const data = bytes('to be removed');
    const key = keyOf(data);
    await store.put(key, data);
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
    await expect(store.delete(key)).resolves.toBeUndefined();
  });

  it('returns null for a missing artifact', async () => {
    expect(await store.get(`sha256/${'0'.repeat(64)}.skillpkg`)).toBeNull();
  });

  it.each([
    '../escape.skillpkg',
    `sha256/../../${'a'.repeat(64)}.skillpkg`,
    `sha256/${'A'.repeat(64)}.skillpkg`,
    `sha256\\${'a'.repeat(64)}.skillpkg`,
    `/sha256/${'a'.repeat(64)}.skillpkg`,
    `C:/sha256/${'a'.repeat(64)}.skillpkg`,
    `sha256/${'a'.repeat(63)}.skillpkg`,
    `sha256/${'a'.repeat(64)}.skillpkg/..`,
    `sha256/${'a'.repeat(64)}.tgz`,
    '',
  ])('rejects the unsafe key %j', async (key) => {
    expect(() => assertValidKey(key)).toThrow(/Invalid artifact key/);
    await expect(store.put(key, bytes('x'))).rejects.toThrow(/Invalid artifact key/);
    await expect(store.get(key)).rejects.toThrow(/Invalid artifact key/);
  });

  it('never writes outside its root', async () => {
    const entries = await readdir(root);
    expect(entries).toEqual(['artifacts']);
  });

  it('derives keys from archive digests', () => {
    const hex = 'b'.repeat(64);
    expect(storageKeyFor(`sha256:${hex}`)).toBe(`sha256/${hex}.skillpkg`);
    expect(() => storageKeyFor('sha256:../../x')).toThrow(/Invalid artifact key/);
  });
});
