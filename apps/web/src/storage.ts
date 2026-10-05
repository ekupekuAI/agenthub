import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Immutable, content-addressed artifact storage. */
export interface ArtifactStore {
  /**
   * Writes once, atomically. Identical bytes under an existing key succeed; different bytes
   * throw. Keys are content addresses, so the bytes must hash to the key.
   */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Returns null when the key does not exist. */
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  /** Removes an artifact (used to roll back a failed publish). Missing keys are ignored. */
  delete(key: string): Promise<void>;
}

const KEY_RE = /^sha256\/([a-f0-9]{64})\.skillpkg$/;

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

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/** Filesystems without hard links report one of these from link(). */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

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

  /** True when the file exists and hashes to `hex`. */
  private async holds(file: string, hex: string): Promise<boolean> {
    try {
      return sha256Hex(await readFile(file)) === hex;
    } catch (error) {
      if (errno(error) === 'ENOENT') return false;
      throw error;
    }
  }

  /**
   * Write to a unique temp file in the same directory, fsync it, then link it into place
   * (link never overwrites, so concurrent writers of the same bytes cannot see each other's
   * partial files). A file already at the key that does not hash to it is a leftover from an
   * interrupted write and is replaced. Readers only ever see complete artifacts.
   */
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const file = this.resolve(key);
    const hex = (KEY_RE.exec(key) as RegExpExecArray)[1] as string;
    if (sha256Hex(bytes) !== hex) {
      // A content address must match its content; anything else is a caller bug or tampering.
      if (await this.holds(file, hex)) {
        throw new StorageError(`Artifact ${key} already exists with different content`);
      }
      throw new StorageError(`Artifact bytes do not match the key ${key}`);
    }
    const dir = path.dirname(file);
    await mkdir(dir, { recursive: true });
    if (await this.holds(file, hex)) return;

    const temp = path.join(dir, `.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
    try {
      const handle = await open(temp, 'wx', 0o644);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await link(temp, file);
      } catch (error) {
        const code = errno(error);
        if (code !== 'EEXIST' && !NO_HARD_LINKS.has(code ?? '')) throw error;
        // Another writer finished first, a corrupt leftover sits at the key, or the
        // filesystem has no hard links. Replacing with verified identical bytes is safe.
        if (await this.holds(file, hex)) return;
        await rename(temp, file);
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    const file = this.resolve(key);
    try {
      return new Uint8Array(await readFile(file));
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
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

  async delete(key: string): Promise<void> {
    const file = this.resolve(key);
    try {
      await unlink(file);
    } catch (error) {
      if (errno(error) !== 'ENOENT') throw error;
    }
  }
}
