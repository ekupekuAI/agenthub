import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { AgentHubError } from './errors';
import { comparePaths } from './paths';

const FILE_HASH = /^sha256:([0-9a-f]{64})$/;

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 'sha256:<hex>' of one file's (normalized) bytes. */
export function fileHash(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

/**
 * Content digest (design §5.5): SHA-256 over one line per file, sorted by path in UTF-8 byte
 * order, each line `<hex>  <path>\n`. Independent of compression and archive layout.
 */
export function contentDigest(fileHashes: Record<string, string>): string {
  const entries = Object.entries(fileHashes).sort(([a], [b]) => comparePaths(a, b));
  let manifest = '';
  for (const [path, hash] of entries) {
    const match = FILE_HASH.exec(hash);
    if (match === null) {
      throw new AgentHubError('INTEGRITY', `malformed file hash for "${path}": ${hash}`, {
        path,
        hash,
      });
    }
    manifest += `${match[1]}  ${path}\n`;
  }
  return `sha256:${sha256Hex(Buffer.from(manifest, 'utf8'))}`;
}

/** 'sha256:<hex>' of the raw archive bytes, for download integrity. */
export function archiveDigest(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}
