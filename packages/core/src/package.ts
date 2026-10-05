import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import semver from 'semver';
import { AgentHubError } from './errors';
import { contentDigest, fileHash } from './hash';
import { DEFAULT_LIMITS } from './limits';
import { MANIFEST_FILE, parseManifest } from './manifest';
import { checkFileEncoding, isTextContent, normalizeFile } from './normalize';
import { checkPackagePath, comparePaths, escapeForDisplay, findCaseCollisions } from './paths';
import { parseSkillMd } from './skillmd';
import type {
  PackageFile,
  PackageLimits,
  SkillManifest,
  SkillPackage,
  ValidationIssue,
} from './types';

export const SKILL_FILE = 'SKILL.md';

/**
 * Names never part of a skill (design §5.3): skipped when loading a skill from a folder and
 * rejected, in any letter case and at any depth, in archives and in-memory builds.
 */
export const EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  '.agenthub',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

const EXCLUDED_LOWER: ReadonlySet<string> = new Set(
  [...EXCLUDED_NAMES].map((name) => name.toLowerCase()),
);

/** True when one path segment is an excluded name (compared case-insensitively). */
export function isExcludedName(segment: string): boolean {
  return EXCLUDED_LOWER.has(segment.toLowerCase());
}

/** The first segment of `path` that is an excluded name, or null. */
export function excludedSegment(path: string): string | null {
  return path.split('/').find(isExcludedName) ?? null;
}

export interface RawFile {
  path: string;
  content: Uint8Array;
}

export interface BuildOptions {
  /** When given, the frontmatter `name` must equal it. */
  folderName?: string;
  /** Overrides the manifest version; must be a valid semver version. */
  version?: string;
  limits?: PackageLimits;
}

function fail(issues: ValidationIssue[], subject = 'skill package'): never {
  const errors = issues.filter((issue) => issue.level === 'error');
  const first = errors[0];
  const summary = first === undefined ? 'invalid' : first.message;
  const more = errors.length > 1 ? ` (and ${errors.length - 1} more)` : '';
  throw new AgentHubError('VALIDATION', `${subject} is invalid: ${summary}${more}`, { issues });
}

function pathError(code: string, message: string, path: string): ValidationIssue {
  return { level: 'error', code, message, path };
}

/** Limit and path-safety checks shared by every source (folder, archive, in-memory). */
export function checkRawFiles(files: readonly RawFile[], limits: PackageLimits): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (files.length > limits.maxFiles) {
    issues.push({
      level: 'error',
      code: 'package.too-many-files',
      message: `package has ${files.length} files; the limit is ${limits.maxFiles}`,
    });
  }
  let total = 0;
  const seen = new Set<string>();
  for (const file of files) {
    const shown = escapeForDisplay(file.path);
    const problem = checkPackagePath(file.path, limits);
    if (problem !== null) {
      issues.push(pathError('path.unsafe', problem, file.path));
    } else {
      const excluded = excludedSegment(file.path);
      if (excluded !== null) {
        issues.push(
          pathError(
            'path.excluded',
            `path "${shown}" contains "${excluded}", which is never part of a skill package`,
            file.path,
          ),
        );
      }
      // SKILL.md and agenthub.yaml must be strict UTF-8; buildSkillPackage reports them itself.
      const encoding =
        file.path === SKILL_FILE || file.path === MANIFEST_FILE
          ? null
          : checkFileEncoding(file.path, file.content);
      if (encoding !== null) issues.push(pathError('file.encoding', encoding, file.path));
    }
    if (seen.has(file.path)) {
      issues.push(pathError('path.duplicate', `duplicate path "${shown}"`, file.path));
    }
    seen.add(file.path);
    if (file.content.length > limits.maxFileBytes) {
      issues.push(
        pathError(
          'file.too-large',
          `file "${shown}" is ${file.content.length} bytes; the limit is ${limits.maxFileBytes}`,
          file.path,
        ),
      );
    }
    total += file.content.length;
  }
  if (total > limits.maxTotalBytes) {
    issues.push({
      level: 'error',
      code: 'package.too-large',
      message: `package is ${total} bytes unpacked; the limit is ${limits.maxTotalBytes}`,
    });
  }
  for (const path of findCaseCollisions([...seen])) {
    issues.push(
      pathError(
        'path.case-collision',
        `path "${path}" differs from another path only by case`,
        path,
      ),
    );
  }
  const conflicts = new Set<string>();
  for (const path of seen) {
    const segments = path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      if (seen.has(dir)) conflicts.add(dir);
    }
  }
  for (const dir of conflicts) {
    issues.push(pathError('path.conflict', `"${dir}" is both a file and a directory`, dir));
  }
  return issues;
}

/**
 * Strict UTF-8 decode (no NUL, no invalid bytes) for SKILL.md and agenthub.yaml. A leading byte
 * order mark is kept so that exactly one is stripped later, by the parser.
 */
function decodeText(file: PackageFile): string | null {
  if (!isTextContent(file.content)) return null;
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(file.content);
}

/** Prefix manifest issue messages with the file name, so errors say which file is wrong. */
function manifestIssue(issue: ValidationIssue): ValidationIssue {
  const prefix = `${MANIFEST_FILE}: `;
  return issue.message.startsWith(prefix) ? issue : { ...issue, message: prefix + issue.message };
}

/**
 * Version used when neither the caller nor agenthub.yaml gives one: a prerelease of 0.0.0 that
 * carries the first 12 hex digits of the content digest, so it is valid semver, accepted by
 * {@link buildSkillPackage}'s own version check, and different for different contents.
 */
function localVersion(digest: string): string {
  const hex = digest.slice('sha256:'.length, 'sha256:'.length + 12);
  // A numeric prerelease identifier may not have a leading zero.
  return /^0\d*$/.test(hex) ? `0.0.0-local.x${hex}` : `0.0.0-local.${hex}`;
}

/**
 * Build a validated, normalized, content-addressed skill package from raw files (design §5).
 * Throws AgentHubError('VALIDATION') listing every error; warnings are returned in `issues`.
 */
export function buildSkillPackage(
  rawFiles: readonly RawFile[],
  opts: BuildOptions = {},
): SkillPackage {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const rawIssues = checkRawFiles(rawFiles, limits);
  if (rawIssues.length > 0) fail(rawIssues);

  const files = rawFiles
    .map((file) => normalizeFile(file.path, file.content))
    .sort((a, b) => comparePaths(a.path, b.path));

  const skillFile = files.find((file) => file.path === SKILL_FILE);
  if (skillFile === undefined) {
    fail([
      {
        level: 'error',
        code: 'skillmd.missing',
        message: `${SKILL_FILE} is missing from the package root`,
        path: SKILL_FILE,
      },
    ]);
  }
  const skillText = decodeText(skillFile);
  if (skillText === null) {
    fail([
      {
        level: 'error',
        code: 'skillmd.encoding',
        message: `${SKILL_FILE} must be UTF-8 text`,
        path: SKILL_FILE,
      },
    ]);
  }

  const parsed = parseSkillMd(
    skillText,
    opts.folderName === undefined ? {} : { folderName: opts.folderName },
  );
  const issues = [...parsed.issues];

  let manifest: SkillManifest | null = null;
  const manifestFile = files.find((file) => file.path === MANIFEST_FILE);
  if (manifestFile !== undefined) {
    const manifestText = decodeText(manifestFile);
    if (manifestText === null) {
      issues.push({
        level: 'error',
        code: 'manifest.encoding',
        message: `${MANIFEST_FILE} must be UTF-8 text`,
        path: MANIFEST_FILE,
      });
    } else {
      try {
        manifest = parseManifest(manifestText);
      } catch (cause) {
        if (!(cause instanceof AgentHubError) || cause.code !== 'VALIDATION') throw cause;
        const details = cause.details as { issues?: ValidationIssue[] } | undefined;
        issues.push(...(details?.issues ?? []).map(manifestIssue));
      }
    }
  }

  if (opts.version !== undefined && semver.valid(opts.version) !== opts.version) {
    issues.push({
      level: 'error',
      code: 'version.invalid',
      message: `version "${opts.version}" is not a valid semver version`,
    });
  }

  if (issues.some((issue) => issue.level === 'error')) fail(issues);

  const fileHashes: Record<string, string> = Object.fromEntries(
    files.map((file) => [file.path, fileHash(file.content)]),
  );
  const digest = contentDigest(fileHashes);
  const version = opts.version ?? manifest?.version ?? localVersion(digest);

  return {
    name: parsed.frontmatter.name,
    version,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    manifest,
    files,
    fileHashes,
    digest,
    issues: issues.filter((issue) => issue.level === 'warning'),
  };
}

function ioError(cause: unknown, path: string): AgentHubError {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new AgentHubError('NOT_FOUND', `skill folder not found: ${path}`, { path });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AgentHubError('IO', `cannot read ${path}: ${message}`, { path, cause: code });
}

function walkFailure(code: string, message: string, path: string): never {
  throw new AgentHubError('VALIDATION', message, { issues: [pathError(code, message, path)] });
}

/**
 * Load a skill from a folder. Symlinks (and any non-regular file) inside the folder are
 * rejected; the {@link EXCLUDED_NAMES} (any letter case) are skipped.
 * The folder's own name must equal the frontmatter `name`.
 */
export async function loadSkillFromDir(
  dir: string,
  opts: { version?: string; limits?: PackageLimits } = {},
): Promise<SkillPackage> {
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const root = resolve(dir);
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      throw new AgentHubError('VALIDATION', `not a directory: ${root}`, { path: root });
    }
  } catch (cause) {
    if (cause instanceof AgentHubError) throw cause;
    throw ioError(cause, root);
  }

  const files: RawFile[] = [];
  let total = 0;

  const walk = async (absolute: string, segments: string[]): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(absolute);
    } catch (cause) {
      throw ioError(cause, absolute);
    }
    names.sort();
    for (const name of names) {
      if (isExcludedName(name)) continue;
      const childSegments = [...segments, name];
      const relative = childSegments.join('/');
      const childPath = join(absolute, name);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(childPath);
      } catch (cause) {
        throw ioError(cause, childPath);
      }
      if (childSegments.length > limits.maxDepth) {
        walkFailure(
          'path.unsafe',
          `path "${relative}" is nested deeper than ${limits.maxDepth} levels`,
          relative,
        );
      }
      if (info.isSymbolicLink()) {
        walkFailure(
          'path.symlink',
          `symbolic links are not allowed in a skill: "${relative}"`,
          relative,
        );
      }
      if (info.isDirectory()) {
        await walk(childPath, childSegments);
        continue;
      }
      if (!info.isFile()) {
        walkFailure('path.special', `"${relative}" is not a regular file`, relative);
      }
      if (files.length + 1 > limits.maxFiles) {
        walkFailure(
          'package.too-many-files',
          `skill has more than ${limits.maxFiles} files`,
          relative,
        );
      }
      if (info.size > limits.maxFileBytes) {
        walkFailure(
          'file.too-large',
          `file "${relative}" is ${info.size} bytes; the limit is ${limits.maxFileBytes}`,
          relative,
        );
      }
      total += info.size;
      if (total > limits.maxTotalBytes) {
        walkFailure(
          'package.too-large',
          `skill is larger than ${limits.maxTotalBytes} bytes unpacked`,
          relative,
        );
      }
      let content: Buffer;
      try {
        content = await readFile(childPath);
      } catch (cause) {
        throw ioError(cause, childPath);
      }
      files.push({ path: relative, content: new Uint8Array(content) });
    }
  };

  await walk(root, []);

  const buildOptions: BuildOptions = { folderName: basename(root), limits };
  if (opts.version !== undefined) buildOptions.version = opts.version;
  return buildSkillPackage(files, buildOptions);
}
