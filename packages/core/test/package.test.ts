import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSkillPackage,
  contentDigest,
  DEFAULT_LIMITS,
  fileHash,
  loadSkillFromDir,
} from '../src/index';
import {
  catchError,
  catchErrorAsync,
  decode,
  encode,
  issueCodes,
  PNG_BYTES,
  sampleFiles,
  skillMd,
  toCrlf,
  VALID_MANIFEST,
  VALID_SKILL_MD,
} from './helpers';

describe('buildSkillPackage', () => {
  it('builds a normalized, sorted, content-addressed package', () => {
    const pkg = buildSkillPackage(sampleFiles(), { folderName: 'web-testing' });
    expect(pkg.name).toBe('web-testing');
    expect(pkg.version).toBe('1.3.0');
    expect(pkg.manifest?.targets).toEqual(['claude-code', 'cursor']);
    expect(pkg.frontmatter.license).toBe('MIT');
    expect(pkg.body).toBe('# Usage\n\nRun the script.\n');
    expect(pkg.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'agenthub.yaml',
      'assets/logo.png',
      'references/a/b.md',
      'scripts/run.sh',
    ]);
    expect(pkg.files.find((f) => f.path === 'scripts/run.sh')?.executable).toBe(true);
    expect(pkg.files.find((f) => f.path === 'assets/logo.png')?.kind).toBe('binary');
    expect(Object.keys(pkg.fileHashes)).toEqual(pkg.files.map((file) => file.path));
    for (const file of pkg.files) expect(pkg.fileHashes[file.path]).toBe(fileHash(file.content));
    expect(pkg.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pkg.digest).toBe(contentDigest(pkg.fileHashes));
    expect(pkg.issues).toEqual([]);
  });

  it('sorts files by UTF-8 bytes', () => {
    const pkg = buildSkillPackage(
      sampleFiles({ 'b.md': 'b', 'B2.md': 'B', 'é.md': 'e', 'a.md': 'a' }),
    );
    expect(pkg.files.map((f) => f.path).slice(0, 4)).toEqual([
      'B2.md',
      'SKILL.md',
      'a.md',
      'agenthub.yaml',
    ]);
    expect(pkg.files.at(-1)?.path).toBe('é.md');
  });

  it('returns warnings in issues', () => {
    const pkg = buildSkillPackage(
      sampleFiles({ 'SKILL.md': skillMd('name: web-testing\ndescription: x\nmodel: opus') }),
    );
    expect(pkg.issues.map((issue) => issue.code)).toEqual(['frontmatter.unknown-key']);
    expect(pkg.frontmatter.model).toBe('opus');
  });

  it('uses 0.0.0-local+<digest8> when there is no manifest or version', () => {
    const files = sampleFiles().filter((file) => file.path !== 'agenthub.yaml');
    const pkg = buildSkillPackage(files);
    expect(pkg.manifest).toBeNull();
    expect(pkg.version).toBe(`0.0.0-local+${pkg.digest.slice(7, 15)}`);
  });

  it('lets opts.version override the manifest version', () => {
    expect(buildSkillPackage(sampleFiles(), { version: '2.0.0-rc.1' }).version).toBe('2.0.0-rc.1');
  });

  it('rejects an invalid opts.version', () => {
    const error = catchError(() => buildSkillPackage(sampleFiles(), { version: 'latest' }));
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual(['version.invalid']);
  });

  it('gives CRLF and LF variants the same digest and keeps binary bytes exact', () => {
    const lf = buildSkillPackage(sampleFiles());
    const crlf = buildSkillPackage(
      sampleFiles({
        'SKILL.md': toCrlf(VALID_SKILL_MD),
        'agenthub.yaml': toCrlf(VALID_MANIFEST),
        'scripts/run.sh': toCrlf('#!/bin/sh\necho "running"\n'),
      }),
    );
    expect(crlf.digest).toBe(lf.digest);
    expect(crlf.fileHashes).toEqual(lf.fileHashes);
    expect(crlf.files.find((f) => f.path === 'assets/logo.png')?.content).toEqual(PNG_BYTES);
  });

  it('changes the digest when binary CRLF bytes change', () => {
    const one = buildSkillPackage(sampleFiles({ 'a.bin': new Uint8Array([0, 0x0d, 0x0a]) }));
    const two = buildSkillPackage(sampleFiles({ 'a.bin': new Uint8Array([0, 0x0a]) }));
    expect(one.digest).not.toBe(two.digest);
  });

  it('enforces the folder name only when given', () => {
    expect(buildSkillPackage(sampleFiles()).name).toBe('web-testing');
    const error = catchError(() => buildSkillPackage(sampleFiles(), { folderName: 'other' }));
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual(['name.folder-mismatch']);
  });

  it('requires SKILL.md at the root', () => {
    const files = sampleFiles().filter((file) => file.path !== 'SKILL.md');
    expect(issueCodes(catchError(() => buildSkillPackage(files)))).toEqual(['skillmd.missing']);
    const nested = [...files, { path: 'docs/SKILL.md', content: encode(VALID_SKILL_MD) }];
    expect(issueCodes(catchError(() => buildSkillPackage(nested)))).toEqual(['skillmd.missing']);
  });

  it('requires SKILL.md to be UTF-8 text', () => {
    const error = catchError(() => buildSkillPackage(sampleFiles({ 'SKILL.md': PNG_BYTES })));
    expect(issueCodes(error)).toEqual(['skillmd.encoding']);
  });

  it('throws every frontmatter and manifest error together', () => {
    const error = catchError(() =>
      buildSkillPackage(
        sampleFiles({
          'SKILL.md': skillMd('name: Bad\nmetadata: { n: 1 }'),
          'agenthub.yaml': 'schema: 1\nversion: nope\n',
        }),
      ),
    );
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual([
      'name.format',
      'description.missing',
      'metadata.value-type',
      'manifest.custom',
    ]);
  });

  it.each([
    ['unsafe path', { '../evil.sh': 'x' }, 'path.unsafe'],
    ['reserved name', { 'CON.txt': 'x' }, 'path.unsafe'],
    ['case collision', { 'Notes.md': 'x', 'notes.md': 'y' }, 'path.case-collision'],
  ])('rejects %s', (_label, extra, code) => {
    const error = catchError(() => buildSkillPackage(sampleFiles(extra)));
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toContain(code);
  });

  it('rejects duplicate paths and file/directory conflicts', () => {
    const dup = [...sampleFiles(), { path: 'SKILL.md', content: encode(VALID_SKILL_MD) }];
    expect(issueCodes(catchError(() => buildSkillPackage(dup)))).toContain('path.duplicate');
    const conflict = sampleFiles({ scripts: 'x' });
    expect(issueCodes(catchError(() => buildSkillPackage(conflict)))).toContain('path.conflict');
  });

  it('enforces file count, file size and total size limits', () => {
    const small = { ...DEFAULT_LIMITS, maxFiles: 3 };
    expect(
      issueCodes(catchError(() => buildSkillPackage(sampleFiles(), { limits: small }))),
    ).toEqual(['package.too-many-files']);
    const perFile = { ...DEFAULT_LIMITS, maxFileBytes: 1000 };
    const big = sampleFiles({ 'big.txt': 'x'.repeat(1001) });
    expect(issueCodes(catchError(() => buildSkillPackage(big, { limits: perFile })))).toEqual([
      'file.too-large',
    ]);
    const total = { ...DEFAULT_LIMITS, maxTotalBytes: 1200 };
    expect(issueCodes(catchError(() => buildSkillPackage(big, { limits: total })))).toEqual([
      'package.too-large',
    ]);
  });
});

describe('loadSkillFromDir', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'agenthub-core-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeTree(dir: string, files: Record<string, string | Uint8Array>) {
    for (const [path, content] of Object.entries(files)) {
      const target = join(dir, ...path.split('/'));
      await mkdir(join(target, '..'), { recursive: true });
      await writeFile(target, content);
    }
  }

  async function makeSkill(folder: string, extra: Record<string, string | Uint8Array> = {}) {
    const dir = join(root, folder);
    await writeTree(dir, {
      'SKILL.md': VALID_SKILL_MD,
      'agenthub.yaml': VALID_MANIFEST,
      'scripts/run.sh': '#!/bin/sh\necho "running"\n',
      'references/a/b.md': '# Reference\n\nDetails.\n',
      'assets/logo.png': PNG_BYTES,
      ...extra,
    });
    return dir;
  }

  it('loads a folder, skipping excluded names, with the same digest as in memory', async () => {
    const dir = await makeSkill(join('ok', 'web-testing'), {
      '.git/config': '[core]\n',
      'node_modules/dep/index.js': 'module.exports = 1;\n',
      '.agenthub/agenthub.lock': '{}\n',
      '.DS_Store': new Uint8Array([0, 1, 2]),
      'assets/Thumbs.db': new Uint8Array([0, 1, 2]),
    });
    await mkdir(join(dir, 'empty-dir'));
    const pkg = await loadSkillFromDir(dir);
    expect(pkg.files.map((f) => f.path)).toEqual([
      'SKILL.md',
      'agenthub.yaml',
      'assets/logo.png',
      'references/a/b.md',
      'scripts/run.sh',
    ]);
    expect(pkg.digest).toBe(buildSkillPackage(sampleFiles()).digest);
  });

  it('gives a CRLF checkout the same digest as the LF version', async () => {
    const dir = await makeSkill(join('crlf', 'web-testing'), {
      'SKILL.md': toCrlf(VALID_SKILL_MD),
      'references/a/b.md': toCrlf('# Reference\n\nDetails.\n'),
    });
    const pkg = await loadSkillFromDir(dir, { version: '9.9.9' });
    expect(pkg.digest).toBe(buildSkillPackage(sampleFiles()).digest);
    expect(pkg.version).toBe('9.9.9');
    expect(decode(pkg.files[0]?.content ?? new Uint8Array())).not.toContain('\r');
  });

  it('requires the folder name to equal the skill name', async () => {
    const dir = await makeSkill(join('mismatch', 'other-name'));
    const error = await catchErrorAsync(() => loadSkillFromDir(dir));
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual(['name.folder-mismatch']);
  });

  it('reports a missing folder as NOT_FOUND', async () => {
    const error = await catchErrorAsync(() => loadSkillFromDir(join(root, 'missing', 'x')));
    expect(error.code).toBe('NOT_FOUND');
  });

  it('stops early when a file exceeds the size limit', async () => {
    const dir = await makeSkill(join('big', 'web-testing'), { 'data.txt': 'x'.repeat(2048) });
    const error = await catchErrorAsync(() =>
      loadSkillFromDir(dir, { limits: { ...DEFAULT_LIMITS, maxFileBytes: 1024 } }),
    );
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual(['file.too-large']);
  });

  it('rejects a symlinked directory (junction on Windows)', async () => {
    const dir = await makeSkill(join('junction', 'web-testing'));
    const outside = join(root, 'junction', 'outside');
    await writeTree(outside, { 'secret.txt': 'secret\n' });
    await symlink(outside, join(dir, 'linked'), 'junction');
    const error = await catchErrorAsync(() => loadSkillFromDir(dir));
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toContain('"linked"');
    expect(issueCodes(error)).toEqual(['path.symlink']);
  });

  it('rejects a symlinked file', async (ctx) => {
    const dir = await makeSkill(join('symlink', 'web-testing'));
    const outside = join(root, 'symlink', 'secret.txt');
    await writeFile(outside, 'secret\n');
    try {
      await symlink(outside, join(dir, 'references', 'leak.md'), 'file');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        ctx.skip('creating file symlinks needs extra privileges on this system');
        return;
      }
      throw error;
    }
    const error = await catchErrorAsync(() => loadSkillFromDir(dir));
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toContain('references/leak.md');
  });
});
