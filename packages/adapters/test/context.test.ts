import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AGENT_IDS } from '@agenthub/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createNodeDetectContext,
  detectAgents,
  getAdapter,
  getEnvVar,
  isFullyQualified,
  pathExtensions,
  searchPathEntries,
} from '../src/index';

const isWindows = process.platform === 'win32';

/** The real environment with PATH replaced, so cmd.exe and friends still work. */
function envWithPath(pathValue: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== 'PATH') env[key] = value;
  }
  env.PATH = pathValue;
  return env;
}

/** Writes a fake executable that prints `output` (or exits with `exitCode`). */
async function writeTool(dir: string, name: string, output: string, exitCode = 0): Promise<string> {
  if (isWindows) {
    const file = path.join(dir, `${name}.cmd`);
    const lines = ['@echo off', ...(output ? [`echo ${output}`] : []), `exit /b ${exitCode}`];
    await writeFile(file, `${lines.join('\r\n')}\r\n`);
    return file;
  }
  const file = path.join(dir, name);
  const lines = ['#!/bin/sh', ...(output ? [`echo "${output}"`] : []), `exit ${exitCode}`];
  await writeFile(file, `${lines.join('\n')}\n`);
  await chmod(file, 0o755);
  return file;
}

let root: string;
let bin: string;
let toolPath: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agenthub-adapters-'));
  bin = path.join(root, 'bin');
  await mkdir(bin);
  toolPath = await writeTool(bin, 'tool', 'tool 1.2.3');
  await writeTool(bin, 'failing', '', 3);
  // Present but not runnable: no PATHEXT extension on Windows, no execute bit on POSIX.
  await writeFile(path.join(bin, isWindows ? 'plain.txt' : 'plain'), 'not a program\n');
  if (isWindows) await writeFile(path.join(bin, 'plain'), 'not a program\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createNodeDetectContext().which', () => {
  it('finds an executable on a custom PATH', async () => {
    const ctx = createNodeDetectContext({ env: envWithPath(bin) });
    expect(await ctx.which('tool')).toBe(toolPath);
  });

  it('resolves an absolute path given without extension', async () => {
    const ctx = createNodeDetectContext({ env: envWithPath('') });
    expect(await ctx.which(path.join(bin, 'tool'))).toBe(toolPath);
  });

  it('returns null for a missing command', async () => {
    const ctx = createNodeDetectContext({ env: envWithPath(bin) });
    expect(await ctx.which('definitely-not-a-real-tool-4711')).toBeNull();
  });

  it('returns null for a file that is not executable', async () => {
    const ctx = createNodeDetectContext({ env: envWithPath(bin) });
    expect(await ctx.which('plain')).toBeNull();
  });

  it('ignores empty and relative PATH entries even when the tool sits in the cwd', async () => {
    // A lookup that kept '', '.' or 'bin' would resolve them against the cwd and find the tool.
    const previous = process.cwd();
    process.chdir(root);
    try {
      const ctx = createNodeDetectContext({
        cwd: path.join(root, 'elsewhere'),
        env: envWithPath(['', '.', 'bin', `.${path.sep}bin`].join(path.delimiter)),
      });
      expect(await ctx.which('tool')).toBeNull();
    } finally {
      process.chdir(previous);
    }
  });

  it('skips PATH entries inside the project root, but still finds trusted ones', async () => {
    const project = path.join(root, 'project-root');
    const dotBin = path.join(project, 'node_modules', '.bin');
    await mkdir(dotBin, { recursive: true });
    await writeTool(dotBin, 'tool', 'tool 9.9.9');
    const ctx = createNodeDetectContext({
      projectRoot: project,
      env: envWithPath([dotBin, bin].join(path.delimiter)),
    });
    expect(await ctx.which('tool')).toBe(toolPath);
    expect(await ctx.which(path.join(dotBin, 'tool'))).toBeNull();
  });

  it("skips node_modules/.bin folders on the working directory's ancestor chain", async () => {
    const mono = path.join(root, 'mono');
    const pkg = path.join(mono, 'packages', 'app');
    const dotBin = path.join(mono, 'node_modules', '.bin');
    await mkdir(pkg, { recursive: true });
    await mkdir(dotBin, { recursive: true });
    await writeTool(dotBin, 'claude', '9.9.9');
    const ctx = createNodeDetectContext({ cwd: pkg, env: envWithPath(dotBin) });
    expect(await ctx.which('claude')).toBeNull();
  });

  it('treats a working directory at home as untrusted only for the folder itself', async () => {
    const home = path.join(root, 'home-cwd');
    const homeBin = path.join(home, '.local', 'bin');
    await mkdir(homeBin, { recursive: true });
    const homeTool = await writeTool(homeBin, 'hometool', 'hometool 1.0.0');
    await writeTool(home, 'roottool', 'roottool 1.0.0');
    const ctx = createNodeDetectContext({
      home,
      cwd: home,
      env: envWithPath([home, homeBin].join(path.delimiter)),
    });
    expect(await ctx.which('hometool')).toBe(homeTool);
    expect(await ctx.which('roottool')).toBeNull();
  });

  it.runIf(isWindows)('falls back to the default PATHEXT when PATHEXT is empty', async () => {
    const env = envWithPath(bin);
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATHEXT') delete env[key];
    env.PATHEXT = '';
    expect(await createNodeDetectContext({ env }).which('tool')).toBe(toolPath);
    env.PATHEXT = ' ; ;nonsense';
    expect(await createNodeDetectContext({ env }).which('tool')).toBe(toolPath);
  });

  it.runIf(isWindows)('never accepts a drive-relative explicit path', async () => {
    const ctx = createNodeDetectContext({ env: envWithPath(bin) });
    const driveless = toolPath.slice(2); // '\Users\...\tool.cmd' resolves against the cwd drive
    expect(await ctx.which(driveless)).toBeNull();
    expect((await ctx.run(driveless, ['--version'], 5000)).code).toBeNull();
  });

  it.runIf(isWindows)('honors PATHEXT on Windows', async () => {
    const env = envWithPath(bin);
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATHEXT') delete env[key];
    env.PATHEXT = '.EXE';
    const ctx = createNodeDetectContext({ env });
    expect(await ctx.which('tool')).toBeNull();
    expect(await ctx.which('tool.cmd')).toBe(toolPath);
  });
});

describe('PATH parsing helpers', () => {
  it('searchPathEntries drops empty, relative and drive-relative entries on Windows', () => {
    const raw = [
      '',
      '.',
      'bin',
      String.raw`\Tools\bin`,
      '/usr/local/bin',
      'C:relative',
      String.raw` "C:\Quoted Dir" `,
      String.raw`C:\ok`,
      'D:/fwd',
      String.raw`\\server\share\bin`,
      String.raw`\\.\pipe\x`,
    ].join(';');
    expect(searchPathEntries(raw, 'win32')).toEqual([
      String.raw`C:\Quoted Dir`,
      String.raw`C:\ok`,
      'D:/fwd',
      String.raw`\\server\share\bin`,
    ]);
  });

  it('searchPathEntries keeps only absolute entries on POSIX', () => {
    expect(searchPathEntries(':.:bin:/usr/bin::./x:/opt/b', 'linux')).toEqual([
      '/usr/bin',
      '/opt/b',
    ]);
  });

  it('isFullyQualified rejects rooted paths without a drive on Windows', () => {
    expect(isFullyQualified(String.raw`\Tools\bin`, 'win32')).toBe(false);
    expect(isFullyQualified('/Tools/bin', 'win32')).toBe(false);
    expect(isFullyQualified('C:Tools', 'win32')).toBe(false);
    expect(isFullyQualified(String.raw`C:\Tools`, 'win32')).toBe(true);
    expect(isFullyQualified('/Tools/bin', 'linux')).toBe(true);
  });

  it('pathExtensions falls back to the defaults when PATHEXT is empty or unusable', () => {
    const defaults = ['.com', '.exe', '.bat', '.cmd'];
    expect(pathExtensions(undefined)).toEqual(defaults);
    expect(pathExtensions('')).toEqual(defaults);
    expect(pathExtensions(' ; ;nonsense;.')).toEqual(defaults);
    expect(pathExtensions('.EXE;.Cmd')).toEqual(['.exe', '.cmd']);
  });
});

describe('createNodeDetectContext().run', () => {
  it('runs a PATH command and captures stdout', async () => {
    const ctx = createNodeDetectContext({ env: envWithPath(bin) });
    const result = await ctx.run('tool', ['--version'], 5000);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('tool 1.2.3');
  });

  it('reports a non-zero exit code without throwing', async () => {
    const ctx = createNodeDetectContext({ env: envWithPath(bin) });
    const result = await ctx.run('failing', ['--version'], 5000);
    expect(result.code).toBe(3);
  });

  it('returns code null for a missing command', async () => {
    const ctx = createNodeDetectContext({ env: envWithPath(bin) });
    const result = await ctx.run('definitely-not-a-real-tool-4711', ['--version'], 5000);
    expect(result).toMatchObject({ code: null, stdout: '' });
    expect(result.stderr).toContain('not found');
  });

  it.runIf(isWindows)('refuses shell metacharacters in arguments to a .cmd shim', async () => {
    const ctx = createNodeDetectContext({ env: envWithPath(bin) });
    const result = await ctx.run(toolPath, ['--version', '&', 'calc'], 5000);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('refusing');
  });
});

describe('createNodeDetectContext() file helpers', () => {
  it('exists() and listDir() read the file system', async () => {
    const ctx = createNodeDetectContext();
    expect(await ctx.exists(bin)).toBe(true);
    expect(await ctx.listDir(bin)).toContain(path.basename(toolPath));
  });

  it('exists() is false and listDir() is [] for missing paths', async () => {
    const ctx = createNodeDetectContext();
    expect(await ctx.exists(path.join(root, 'missing'))).toBe(false);
    expect(await ctx.listDir(path.join(root, 'missing'))).toEqual([]);
  });

  it('getEnvVar() is case-insensitive only on Windows', () => {
    expect(getEnvVar({ Path: 'x' }, 'PATH', 'win32')).toBe('x');
    expect(getEnvVar({ Path: 'x' }, 'PATH', 'linux')).toBeUndefined();
  });
});

describe('detection through the real context', () => {
  it('detects a fake cursor install with high confidence', async () => {
    const home = path.join(root, 'home');
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    const cursorBin = path.join(root, 'cursor-bin');
    await mkdir(cursorBin);
    const cursorPath = await writeTool(cursorBin, 'cursor', '3.15.6');
    const ctx = createNodeDetectContext({ home, env: envWithPath(cursorBin) });
    const env = await getAdapter('cursor').detect(ctx);
    expect(env).toMatchObject({ confidence: 'high', version: '3.15.6', executable: cursorPath });
    expect(env?.evidence).toContain('found ~/.cursor');
    expect(env?.evidence).toContain('cursor --version → 3.15.6');
  });

  it('smoke: detectAgents() on this machine resolves without throwing', async () => {
    const found = await detectAgents(createNodeDetectContext());
    expect(Array.isArray(found)).toBe(true);
    for (const env of found) {
      expect(AGENT_IDS).toContain(env.id);
      expect(['high', 'medium']).toContain(env.confidence);
      expect(env.evidence.length).toBeGreaterThan(0);
    }
  }, 20_000);
});
