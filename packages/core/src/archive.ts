import { Buffer, constants as bufferConstants } from 'node:buffer';
import { gunzipSync, gzipSync } from 'node:zlib';
import { AgentHubError } from './errors';
import { DEFAULT_LIMITS } from './limits';
import type { RawFile } from './package';
import { buildSkillPackage } from './package';
import { checkPackagePath, comparePaths, splitTarPath } from './paths';
import type { PackageLimits, SkillPackage } from './types';

const BLOCK = 512;

/** Header field offsets and sizes (POSIX ustar). */
const F = {
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  mtime: [136, 12],
  checksum: [148, 8],
  typeflag: [156, 1],
  linkname: [157, 100],
  magic: [257, 6],
  version: [263, 2],
  uname: [265, 32],
  gname: [297, 32],
  devmajor: [329, 8],
  devminor: [337, 8],
  prefix: [345, 155],
} as const satisfies Record<string, readonly [number, number]>;

const ENTRY_TYPES: Record<string, string> = {
  '1': 'hard link',
  '2': 'symbolic link',
  '3': 'character device',
  '4': 'block device',
  '5': 'directory',
  '6': 'FIFO',
  '7': 'contiguous file',
  x: 'pax extended header',
  g: 'pax global header',
  L: 'GNU long name',
  K: 'GNU long link name',
};

export interface TarEntry {
  path: string;
  content: Uint8Array;
  mode?: number;
  /** One-character typeflag; defaults to '0' (regular file). */
  type?: string;
  linkName?: string;
}

function writeString(header: Uint8Array, [offset, size]: readonly [number, number], value: string) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > size) {
    throw new AgentHubError('VALIDATION', `tar header field too long: "${value}"`);
  }
  header.set(bytes, offset);
}

function writeOctal(header: Uint8Array, field: readonly [number, number], value: number) {
  const digits = value.toString(8).padStart(field[1] - 1, '0');
  if (digits.length > field[1] - 1) {
    throw new AgentHubError('VALIDATION', `tar header value too large: ${value}`);
  }
  writeString(header, field, `${digits}\0`);
}

function headerChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    const inChecksumField = i >= F.checksum[0] && i < F.checksum[0] + F.checksum[1];
    sum += inChecksumField ? 0x20 : (header[i] as number);
  }
  return sum;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Write an uncompressed POSIX ustar archive. Low level: performs no path or type validation,
 * so it can also produce hostile archives for tests. mtime, uid and gid are always 0.
 */
export function createTar(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const split = splitTarPath(entry.path);
    if (split === null) {
      throw new AgentHubError('VALIDATION', `path too long for a ustar header: "${entry.path}"`);
    }
    const header = new Uint8Array(BLOCK);
    writeString(header, F.name, split.name);
    writeOctal(header, F.mode, entry.mode ?? 0o644);
    writeOctal(header, F.uid, 0);
    writeOctal(header, F.gid, 0);
    writeOctal(header, F.size, entry.content.length);
    writeOctal(header, F.mtime, 0);
    header[F.typeflag[0]] = (entry.type ?? '0').charCodeAt(0) || 0;
    writeString(header, F.linkname, entry.linkName ?? '');
    writeString(header, F.magic, 'ustar\0');
    writeString(header, F.version, '00');
    writeOctal(header, F.devmajor, 0);
    writeOctal(header, F.devminor, 0);
    writeString(header, F.prefix, split.prefix);
    const checksum = headerChecksum(header).toString(8).padStart(6, '0');
    writeString(header, F.checksum, `${checksum}\0 `);
    chunks.push(header);
    if (entry.content.length > 0) {
      chunks.push(entry.content);
      const padding = (BLOCK - (entry.content.length % BLOCK)) % BLOCK;
      if (padding > 0) chunks.push(new Uint8Array(padding));
    }
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  return concat(chunks);
}

function integrity(message: string, details?: unknown): AgentHubError {
  return new AgentHubError('INTEGRITY', message, details);
}

function invalid(message: string, path?: string): AgentHubError {
  const issue = { level: 'error' as const, code: 'archive.entry', message };
  return new AgentHubError('VALIDATION', message, {
    issues: [path === undefined ? issue : { ...issue, path }],
  });
}

function fieldBytes(block: Uint8Array, [offset, size]: readonly [number, number]): Uint8Array {
  const bytes = block.subarray(offset, offset + size);
  const nul = bytes.indexOf(0);
  return nul === -1 ? bytes : bytes.subarray(0, nul);
}

function readName(block: Uint8Array, field: readonly [number, number]): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(fieldBytes(block, field));
  } catch {
    throw invalid('archive entry name is not valid UTF-8');
  }
}

function readOctal(block: Uint8Array, field: readonly [number, number], label: string): number {
  if (((block[field[0]] as number) & 0x80) !== 0) {
    throw integrity(`archive header uses an unsupported base-256 ${label}`);
  }
  const text = Buffer.from(fieldBytes(block, field)).toString('latin1').trim();
  if (!/^[0-7]{1,12}$/.test(text)) throw integrity(`archive header has a malformed ${label}`);
  return Number.parseInt(text, 8);
}

function isZeroBlock(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte !== 0) return false;
  return true;
}

/**
 * Parse an uncompressed ustar archive into regular files. Every header checksum is verified;
 * any entry that is not a regular file (links, directories, devices, pax/GNU extensions) is
 * rejected, as are unsafe paths, duplicates and entries over the limits.
 */
export function readTarEntries(tar: Uint8Array, limits: PackageLimits = DEFAULT_LIMITS): RawFile[] {
  const files: RawFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let offset = 0;
  while (true) {
    if (offset + BLOCK > tar.length)
      throw integrity('archive is truncated (no end-of-archive marker)');
    const header = tar.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      if (!isZeroBlock(tar.subarray(offset))) {
        throw integrity('archive has unexpected data after the end-of-archive marker');
      }
      return files;
    }

    const stored = readOctal(header, F.checksum, 'checksum');
    const actual = headerChecksum(header);
    if (stored !== actual) {
      throw integrity(`archive header checksum mismatch at byte ${offset}`, {
        offset,
        expected: stored,
        actual,
      });
    }
    const magic = Buffer.from(header.subarray(F.magic[0], F.magic[0] + 8)).toString('latin1');
    if (magic !== 'ustar\u000000') throw invalid('archive is not a POSIX ustar archive');

    const name = readName(header, F.name);
    const prefix = readName(header, F.prefix);
    const path = prefix === '' ? name : `${prefix}/${name}`;
    const typeByte = header[F.typeflag[0]] as number;
    const type = String.fromCharCode(typeByte);
    if (typeByte !== 0 && type !== '0') {
      const kind =
        ENTRY_TYPES[type] ?? `type "${typeByte < 0x20 ? `\\x${typeByte.toString(16)}` : type}"`;
      throw invalid(
        `unsupported archive entry "${path}" (${kind}); only regular files are allowed`,
        path,
      );
    }

    const problem = checkPackagePath(path, limits);
    if (problem !== null) throw invalid(`unsafe archive entry: ${problem}`, path);
    if (seen.has(path)) throw invalid(`duplicate archive entry "${path}"`, path);
    seen.add(path);
    if (seen.size > limits.maxFiles) {
      throw invalid(`archive has more than ${limits.maxFiles} files`, path);
    }

    const size = readOctal(header, F.size, 'size');
    if (size > limits.maxFileBytes) {
      throw invalid(
        `archive entry "${path}" is ${size} bytes; the limit is ${limits.maxFileBytes}`,
        path,
      );
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw invalid(`archive is larger than ${limits.maxTotalBytes} bytes unpacked`, path);
    }
    const start = offset + BLOCK;
    if (start + size > tar.length) throw integrity(`archive is truncated inside "${path}"`);
    files.push({ path, content: tar.slice(start, start + size) });
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
}

/** Everything except path length and depth, which were enforced when the package was built. */
const PACK_PATH_RULES: PackageLimits = {
  ...DEFAULT_LIMITS,
  maxPathLength: Number.MAX_SAFE_INTEGER,
  maxDepth: Number.MAX_SAFE_INTEGER,
};

/**
 * Pack a skill into a deterministic `.skillpkg` (gzip-compressed ustar, design §5.3): files in
 * UTF-8 path order, mode 0755 for "#!" files else 0644, gzip mtime 0 and OS byte 0xff.
 */
export function packSkill(pkg: SkillPackage): Uint8Array {
  const files = [...pkg.files].sort((a, b) => comparePaths(a.path, b.path));
  for (const file of files) {
    const problem = checkPackagePath(file.path, PACK_PATH_RULES);
    if (problem !== null) throw invalid(`cannot pack: ${problem}`, file.path);
  }
  const tar = createTar(
    files.map((file) => ({
      path: file.path,
      content: file.content,
      mode: file.executable ? 0o755 : 0o644,
      type: '0',
    })),
  );
  const gz = new Uint8Array(gzipSync(tar, { level: 9 }));
  gz.fill(0, 4, 8);
  gz[9] = 0xff;
  return gz;
}

function gunzip(bytes: Uint8Array, limits: PackageLimits): Uint8Array {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw integrity('archive is not gzip-compressed');
  }
  const maxOutputLength = Math.min(
    limits.maxTotalBytes + BLOCK * (limits.maxFiles * 2 + 2),
    bufferConstants.MAX_LENGTH,
  );
  try {
    return new Uint8Array(gunzipSync(bytes, { maxOutputLength }));
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      throw integrity(
        `archive expands beyond ${maxOutputLength} bytes (size limit exceeded or decompression bomb)`,
        { maxOutputLength },
      );
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    throw integrity(`archive is corrupt: ${message}`, { cause: code });
  }
}

export interface ReadArchiveOptions {
  limits?: PackageLimits;
  /** When given, the computed content digest must equal it (INTEGRITY otherwise). */
  expectedDigest?: string;
  /** When given, the frontmatter `name` must equal it. */
  folderName?: string;
}

/**
 * Read and fully validate a `.skillpkg`: bounded gunzip, strict ustar parsing (regular files
 * only), path safety and limits, SKILL.md/agenthub.yaml validation, and an optional digest check.
 */
export function readSkillArchive(bytes: Uint8Array, opts: ReadArchiveOptions = {}): SkillPackage {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const files = readTarEntries(gunzip(bytes, limits), limits);
  const pkg = buildSkillPackage(
    files,
    opts.folderName === undefined ? { limits } : { limits, folderName: opts.folderName },
  );
  if (opts.expectedDigest !== undefined && pkg.digest !== opts.expectedDigest) {
    throw integrity(`content digest mismatch: expected ${opts.expectedDigest}, got ${pkg.digest}`, {
      expected: opts.expectedDigest,
      actual: pkg.digest,
    });
  }
  return pkg;
}
