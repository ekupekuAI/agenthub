import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSkillArchive } from '@agenthub/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/program';

let dir: string;

function sink() {
  const chunks: string[] = [];
  return { isTTY: false, chunks, write: (c: string) => chunks.push(c) > 0 };
}

async function pack(args: string[]) {
  const stdout = sink();
  const stderr = sink();
  const code = await run(['pack', ...args, '--json'], {
    cwd: dir,
    env: { NO_COLOR: '1' },
    stdout,
    stderr,
    stdin: process.stdin,
  });
  return { code, envelope: JSON.parse(stdout.chunks.join('')), stderr: stderr.chunks.join('') };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agenthub-pack-'));
  for (const [name, manifest] of [
    ['with-manifest', 'schema: 1\nversion: 1.0.0\n'],
    ['no-manifest', null],
  ] as const) {
    await mkdir(join(dir, name));
    await writeFile(
      join(dir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Test skill for packing.\n---\n# ${name}\n`,
    );
    if (manifest !== null) await writeFile(join(dir, name, 'agenthub.yaml'), manifest);
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('pack --version', () => {
  it('stamps the version into the archive', async () => {
    const out = join(dir, 'a.skillpkg');
    const result = await pack([join(dir, 'with-manifest'), '--version', '2.3.4', '-o', out]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.envelope.data.version).toBe('2.3.4');
    const pkg = readSkillArchive(new Uint8Array(await readFile(out)));
    expect(pkg.version).toBe('2.3.4');
    expect(pkg.digest).toBe(result.envelope.data.digest);
  });

  it('adds a minimal agenthub.yaml when the skill has none', async () => {
    const out = join(dir, 'b.skillpkg');
    const result = await pack([join(dir, 'no-manifest'), '--version', '0.2.0', '-o', out]);
    expect(result.code, result.stderr).toBe(0);
    const pkg = readSkillArchive(new Uint8Array(await readFile(out)));
    expect(pkg.version).toBe('0.2.0');
  });

  it('rejects an invalid version with a usage error', async () => {
    const result = await pack([join(dir, 'with-manifest'), '--version', 'one']);
    expect(result.code).toBe(2);
    expect(result.envelope.error.code).toBe('USAGE');
  });

  it('defaults the output name to <name>-<version>.skillpkg in the working folder', async () => {
    const result = await pack([join(dir, 'with-manifest')]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.envelope.data.file).toBe(join(dir, 'with-manifest-1.0.0.skillpkg'));
  });

  it('refuses to overwrite an existing default output without --force', async () => {
    const file = join(dir, 'with-manifest-1.0.0.skillpkg');
    await writeFile(file, 'precious');
    const refused = await pack([join(dir, 'with-manifest')]);
    expect(refused.code).toBe(2);
    expect(refused.envelope.error.message).toMatch(/--force/);
    expect(await readFile(file, 'utf8')).toBe('precious');

    const forced = await pack([join(dir, 'with-manifest'), '--force']);
    expect(forced.code, forced.stderr).toBe(0);
    expect((await readFile(file)).byteLength).toBe(forced.envelope.data.sizeBytes);
  });

  it('never writes through a symbolic link at the output path', async (context) => {
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'do not touch');
    const link = join(dir, 'linked.skillpkg');
    try {
      await symlink(victim, link, 'file');
    } catch {
      context.skip(); // creating symbolic links needs a privilege on this machine
      return;
    }
    for (const args of [
      ['-o', link],
      ['-o', link, '--force'],
    ]) {
      const result = await pack([join(dir, 'with-manifest'), ...args]);
      expect(result.code).not.toBe(0);
      expect(result.envelope.error.message).toMatch(/symbolic link|not a regular file/);
    }
    expect(await readFile(victim, 'utf8')).toBe('do not touch');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('refuses a folder at the output path', async () => {
    await mkdir(join(dir, 'a-folder.skillpkg'));
    const result = await pack([join(dir, 'with-manifest'), '-o', join(dir, 'a-folder.skillpkg')]);
    expect(result.code).not.toBe(0);
    expect(result.envelope.error.message).toMatch(/not a regular file/);
  });
});
