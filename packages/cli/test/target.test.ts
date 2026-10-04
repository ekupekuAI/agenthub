import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyTarget, looksLikePath, parseRegistrySpec } from '../src/target';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agenthub-target-'));
  await mkdir(join(dir, 'my-skill'));
  await writeFile(join(dir, 'my-skill-1.0.0.skillpkg'), 'x');
  await writeFile(join(dir, 'notes.txt'), 'x');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('classifyTarget', () => {
  it('treats an existing folder as a dir source', async () => {
    expect(await classifyTarget('my-skill', { cwd: dir })).toEqual({
      kind: 'dir',
      path: join(dir, 'my-skill'),
    });
    expect(await classifyTarget(join(dir, 'my-skill'), { cwd: '/' })).toMatchObject({
      kind: 'dir',
    });
  });

  it('treats an existing .skillpkg file as a file source', async () => {
    expect(await classifyTarget('./my-skill-1.0.0.skillpkg', { cwd: dir })).toEqual({
      kind: 'file',
      path: join(dir, 'my-skill-1.0.0.skillpkg'),
    });
  });

  it('parses name and name@range as registry sources', async () => {
    expect(await classifyTarget('web-testing', { cwd: dir })).toEqual({
      kind: 'registry',
      name: 'web-testing',
    });
    expect(await classifyTarget('web-testing@^1.2.0', { cwd: dir })).toEqual({
      kind: 'registry',
      name: 'web-testing',
      range: '^1.2.0',
    });
    expect(parseRegistrySpec('web-testing@1.0.0')).toEqual({
      kind: 'registry',
      name: 'web-testing',
      range: '1.0.0',
    });
  });

  it('rejects invalid names, ranges and non-package files', async () => {
    await expect(classifyTarget('Web_Testing', { cwd: dir })).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(classifyTarget('web-testing@', { cwd: dir })).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(classifyTarget('web-testing@$(rm)', { cwd: dir })).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(classifyTarget('notes.txt', { cwd: dir })).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(classifyTarget('', { cwd: dir })).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('reports missing paths as NOT_FOUND instead of guessing a registry name', async () => {
    await expect(classifyTarget('./missing-skill', { cwd: dir })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(classifyTarget('gone.skillpkg', { cwd: dir })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('uses an injected stat function', async () => {
    const source = await classifyTarget('anything', { cwd: dir, stat: async () => 'dir' });
    expect(source.kind).toBe('dir');
  });

  it('recognizes path-like input', () => {
    expect(looksLikePath('./x')).toBe(true);
    expect(looksLikePath('a/b')).toBe(true);
    expect(looksLikePath('C:\\skills\\x')).toBe(true);
    expect(looksLikePath('x.skillpkg')).toBe(true);
    expect(looksLikePath('web-testing')).toBe(false);
  });
});
