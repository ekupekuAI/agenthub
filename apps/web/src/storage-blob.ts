import { createHash } from 'node:crypto';
import { MAX_UPLOAD_BYTES } from './config';
import { type ArtifactStore, assertValidKey, StorageError } from './storage';

/**
 * The part of the `@vercel/blob` API this store uses. Injected in tests; by default the real
 * SDK is imported lazily.
 */
export interface BlobApi {
  put(
    pathname: string,
    body: Buffer,
    options: {
      access: 'public' | 'private';
      token: string;
      addRandomSuffix: false;
      allowOverwrite: false;
      contentType: string;
      cacheControlMaxAge: number;
    },
  ): Promise<unknown>;
  head(pathname: string, options: { token: string }): Promise<unknown>;
  get(
    pathname: string,
    options: { access: 'public' | 'private'; token: string },
  ): Promise<{ statusCode: number; stream: ReadableStream<Uint8Array> | null } | null>;
  del(pathname: string, options: { token: string }): Promise<void>;
}

export interface VercelBlobStoreOptions {
  token: string;
  /** Must match the store: 'private' (recommended) or 'public'. */
  access: 'public' | 'private';
  api?: BlobApi;
}

const KEY_RE = /^sha256\/([a-f0-9]{64})\.skillpkg$/;
/** Stored artifacts are uploads, so nothing larger than an upload is ever read back. */
const MAX_ARTIFACT_BYTES = MAX_UPLOAD_BYTES;

function hexOf(key: string): string {
  assertValidKey(key);
  return (KEY_RE.exec(key) as RegExpExecArray)[1] as string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The SDK's BlobNotFoundError (matched by message: class names do not survive bundling). */
function isNotFound(error: unknown): boolean {
  const message = (error as { message?: string } | null)?.message ?? '';
  return /requested blob does not exist/i.test(message);
}

async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new StorageError('Stored artifact is larger than any upload can be');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

let sdk: Promise<BlobApi> | undefined;
function loadSdk(): Promise<BlobApi> {
  sdk ??= import('@vercel/blob').then((m) => m as unknown as BlobApi);
  return sdk;
}

/**
 * Immutable, content-addressed artifact storage in Vercel Blob.
 *
 * - Keys are `sha256/<hex>.skillpkg`, used as the blob pathname without a random suffix, and
 *   every write is `allowOverwrite: false`: a stored artifact is never replaced.
 * - `put` checks the bytes against the key first and treats an existing blob with the same
 *   content as success (also when a concurrent publish wrote it first).
 * - `get` re-hashes what it reads and refuses anything that does not match its key.
 * - Private stores are recommended. On a public store the URLs are unguessable only in the
 *   sense that they are content addresses; packages are public anyway once published, but
 *   quarantined or revoked ones would stay reachable to someone who knows the digest.
 */
export class VercelBlobStore implements ArtifactStore {
  private readonly token: string;
  private readonly access: 'public' | 'private';
  private readonly api: () => Promise<BlobApi>;

  constructor(opts: VercelBlobStoreOptions) {
    if (!opts.token) throw new StorageError('A Vercel Blob token is required');
    this.token = opts.token;
    this.access = opts.access;
    const injected = opts.api;
    this.api = injected ? () => Promise.resolve(injected) : loadSdk;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const hex = hexOf(key);
    if (sha256Hex(bytes) !== hex) {
      throw new StorageError(`Artifact bytes do not match the key ${key}`);
    }
    if (await this.holds(key, hex)) return;
    const api = await this.api();
    try {
      await api.put(key, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
        access: this.access,
        token: this.token,
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: 'application/octet-stream',
        // Content-addressed: the bytes behind a key never change.
        cacheControlMaxAge: 365 * 24 * 60 * 60,
      });
    } catch (error) {
      // A concurrent publish of the same package may have written it first (the SDK reports
      // that as an error because overwriting is not allowed).
      if (await this.holds(key, hex).catch(() => false)) return;
      throw new StorageError(
        `Could not store ${key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const hex = hexOf(key);
    const bytes = await this.read(key);
    if (bytes === null) return null;
    if (sha256Hex(bytes) !== hex) {
      throw new StorageError(`Stored artifact ${key} does not match its content address`);
    }
    return bytes;
  }

  async exists(key: string): Promise<boolean> {
    assertValidKey(key);
    const api = await this.api();
    try {
      await api.head(key, { token: this.token });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    const api = await this.api();
    try {
      await api.del(key, { token: this.token });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  /** True when a blob exists at `key` with exactly the content `hex`; throws on a mismatch. */
  private async holds(key: string, hex: string): Promise<boolean> {
    if (!(await this.exists(key))) return false;
    const existing = await this.read(key);
    if (existing === null) return false;
    if (sha256Hex(existing) !== hex) {
      throw new StorageError(`Artifact ${key} already exists with different content`);
    }
    return true;
  }

  private async read(key: string): Promise<Uint8Array | null> {
    const api = await this.api();
    let result: Awaited<ReturnType<BlobApi['get']>>;
    try {
      result = await api.get(key, { access: this.access, token: this.token });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    if (result?.statusCode !== 200 || !result.stream) return null;
    return readCapped(result.stream, MAX_ARTIFACT_BYTES);
  }
}
