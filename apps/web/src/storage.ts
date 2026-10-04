import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Immutable, content-addressed artifact storage. */
export interface ArtifactStore {
  /** Writes once. Identical bytes under an existing key succeed; different bytes throw. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Returns null when the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
}

const KEY_RE = /^sha256\/[a-f0-9]{64}\.skillpkg$/;

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export function assertValidKey(key: string): void {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    throw new StorageError('Invalid artifact key');
  }
}

/** Key for an archive digest ('sha256:<hex>' or bare hex). */
export function storageKeyFor(archiveDigest: string): string {
  const hex = archiveDigest.startsWith('sha256:') ? archiveDigest.slice(7) : archiveDigest;
  const key = `sha256/${hex}.skillpkg`;
  assertValidKey(key);
  return key;
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash('sha256').update(bytes).digest();
}

export class LocalFsStore implements ArtifactStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private resolve(key: string): string {
    assertValidKey(key);
    const full = path.resolve(this.root, ...key.split('/'));
    // Defense in depth: the regex already rules out traversal.
    if (!full.startsWith(this.root + path.sep)) throw new StorageError('Invalid artifact key');
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readFile(file);
      if (!sha256(existing).equals(sha256(bytes))) {
        throw new StorageError(`Artifact ${key} already exists with different content`);
      }
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const file = this.resolve(key);
    try {
      return new Uint8Array(await readFile(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    const file = this.resolve(key);
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  }
}
