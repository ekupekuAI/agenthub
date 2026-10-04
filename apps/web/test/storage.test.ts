import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
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
