import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { StorageError, storageKeyFor } from '../src/storage';
import { type BlobApi, VercelBlobStore } from '../src/storage-blob';

/** In-memory stand-in for the Vercel Blob SDK, with its overwrite and not-found behavior. */
function fakeBlob() {
  const blobs = new Map<string, { bytes: Buffer; access: string }>();
  const calls: string[] = [];
  const notFound = () => new Error('Vercel Blob: The requested blob does not exist');
  const api: BlobApi = {
    async put(pathname, body, options) {
      calls.push(`put ${pathname}`);
      expect(options.addRandomSuffix).toBe(false);
      expect(options.allowOverwrite).toBe(false);
      if (blobs.has(pathname)) {
        throw new Error('Vercel Blob: This blob already exists, use `allowOverwrite: true`.');
      }
      blobs.set(pathname, { bytes: Buffer.from(body), access: options.access });
      return {};
    },
    async head(pathname) {
      calls.push(`head ${pathname}`);
      if (!blobs.has(pathname)) throw notFound();
      return {};
    },
    async get(pathname, options) {
      calls.push(`get ${pathname}`);
      const blob = blobs.get(pathname);
      if (!blob) return null;
      expect(options.access).toBe(blob.access);
      const bytes = new Uint8Array(blob.bytes);
      return {
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            // Two chunks, like a real response body.
            controller.enqueue(bytes.slice(0, 3));
            controller.enqueue(bytes.slice(3));
            controller.close();
          },
        }),
      };
    },
    async del(pathname) {
      calls.push(`del ${pathname}`);
      if (!blobs.delete(pathname)) throw notFound();
    },
  };
  return { api, blobs, calls };
}

const bytes = new TextEncoder().encode('a content-addressed package');
const key = storageKeyFor(createHash('sha256').update(bytes).digest('hex'));

describe('VercelBlobStore', () => {
  it('writes once under the content address and reads back verified bytes', async () => {
    const fake = fakeBlob();
    const store = new VercelBlobStore({ token: 't', access: 'private', api: fake.api });
    expect(await store.exists(key)).toBe(false);
    expect(await store.get(key)).toBeNull();
    await store.put(key, bytes);
    expect(fake.blobs.get(key)?.access).toBe('private');
    expect(await store.exists(key)).toBe(true);
    expect(Buffer.from((await store.get(key)) as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
  });

  it('never overwrites: identical bytes are a no-op, a lost race is success', async () => {
    const fake = fakeBlob();
    const store = new VercelBlobStore({ token: 't', access: 'private', api: fake.api });
    await store.put(key, bytes);
    fake.calls.length = 0;
    await store.put(key, bytes);
    expect(fake.calls.filter((c) => c.startsWith('put'))).toEqual([]);

    // Two writers that both saw "missing": the second put is refused by the store and the
    // writer confirms the stored bytes instead.
    const racing = fakeBlob();
    const a = new VercelBlobStore({ token: 't', access: 'private', api: racing.api });
    await Promise.all([a.put(key, bytes), a.put(key, bytes)]);
    expect(racing.blobs.size).toBe(1);
  });

  it('refuses bytes that do not match the key, and invalid keys', async () => {
    const store = new VercelBlobStore({ token: 't', access: 'private', api: fakeBlob().api });
    await expect(store.put(key, new TextEncoder().encode('other'))).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(store.put('../escape.skillpkg', bytes)).rejects.toBeInstanceOf(StorageError);
    await expect(store.get('sha256/abc.skillpkg')).rejects.toBeInstanceOf(StorageError);
  });

  it('detects tampered content on read and on a repeated write', async () => {
    const fake = fakeBlob();
    const store = new VercelBlobStore({ token: 't', access: 'public', api: fake.api });
    fake.blobs.set(key, { bytes: Buffer.from('tampered'), access: 'public' });
    await expect(store.get(key)).rejects.toThrow(/does not match its content address/);
    await expect(store.put(key, bytes)).rejects.toThrow(/already exists with different content/);
  });

  it('deletes, ignoring missing keys', async () => {
    const fake = fakeBlob();
    const store = new VercelBlobStore({ token: 't', access: 'private', api: fake.api });
    await store.put(key, bytes);
    await store.delete(key);
    await store.delete(key);
    expect(await store.exists(key)).toBe(false);
  });
});
