/**
 * Regression tests for running agenthub inside a hostile, attacker-controlled checkout:
 * detection must never execute anything from the project or the working directory, and a
 * probe must stay bounded in time and output.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeDetectContext } from '../src/index';

const isWindows = process.platform === 'win32';
const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);

/** The real environment with PATH replaced and the cwd-search opt-out removed. */
function hostileEnv(pathValue: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper === 'PATH' || upper === 'NODEFAULTCURRENTDIRECTORYINEXEPATH') continue;
    env[key] = value;
  }
  env.PATH = pathValue;
  return env;
}

/** Writes an executable that runs `node <script>` (the script file is written next to it). */
async function writeNodeTool(dir: string, name: string, script: string): Promise<string> {
  const js = path.join(dir, `${name}.js`);
  await writeFile(js, script);
  if (isWindows) {
    const file = path.join(dir, `${name}.cmd`);
    await writeFile(file, `@echo off\r\n"${NODE}" "${js}" %*\r\n`);
    return file;
  }
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\nexec "${NODE}" "${js}" "$@"\n`);
  await chmod(file, 0o755);
  return file;
}

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agenthub-hostile-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('probes never execute files from the project or working directory', () => {
  it.runIf(isWindows)(
    'an npm-style .cmd shim does not pick up a node.cmd planted in the working directory',
    async () => {
      const repo = path.join(root, 'hostile-repo');
      const npmBin = path.join(root, 'npm-bin');
      const marker = path.join(root, 'pwned-by-node-cmd.txt');
      await mkdir(repo);
      await mkdir(npmBin);
      await writeFile(
        path.join(repo, 'node.cmd'),
        `@echo off\r\necho hijacked>"${marker}"\r\necho HIJACKED 6.6.6\r\n`,
      );
      // Byte-for-byte the tail of an npm shim when node.exe is not beside it.
      await writeFile(path.join(npmBin, 'codex.js'), "console.log('codex-cli 1.2.3');\n");
      await writeFile(
        path.join(npmBin, 'codex.cmd'),
        '@ECHO off\r\nSETLOCAL\r\nSET "_prog=node"\r\n"%_prog%" "%~dp0\\codex.js" %*\r\n',
      );
      const env = hostileEnv([npmBin, NODE_DIR].join(';'));
      const result = await withCwd(repo, () =>
        createNodeDetectContext({ env }).run('codex', ['--version'], 10_000),
      );
      expect(existsSync(marker)).toBe(false);
      expect(result.stdout).not.toContain('HIJACKED');
      expect(result).toMatchObject({ code: 0 });
      expect(result.stdout.trim()).toBe('codex-cli 1.2.3');
    },
  );

  it.runIf(!isWindows)(
    'a #!/usr/bin/env node tool does not pick up ./node from the working directory',
    async () => {
      const repo = path.join(root, 'hostile-repo-posix');
      const binDir = path.join(root, 'posix-bin');
      const marker = path.join(root, 'pwned-by-dot-node');
      await mkdir(repo);
      await mkdir(binDir);
      await writeFile(
        path.join(repo, 'node'),
        `#!/bin/sh\ntouch "${marker}"\necho "HIJACKED 6.6.6"\n`,
      );
      await chmod(path.join(repo, 'node'), 0o755);
      await writeFile(
        path.join(binDir, 'codex'),
        "#!/usr/bin/env node\nconsole.log('codex-cli 1.2.3');\n",
      );
      await chmod(path.join(binDir, 'codex'), 0o755);
      const env = hostileEnv(['.', binDir, NODE_DIR, '/usr/bin', '/bin'].join(':'));
      const result = await withCwd(repo, () =>
        createNodeDetectContext({ env }).run('codex', ['--version'], 10_000),
      );
      expect(existsSync(marker)).toBe(false);
      expect(result.stdout.trim()).toBe('codex-cli 1.2.3');
    },
  );

  it('which() skips an absolute PATH entry inside the working directory (node_modules/.bin)', async () => {
    const project = path.join(root, 'cwd-project');
    const dotBin = path.join(project, 'node_modules', '.bin');
    const marker = path.join(root, 'pwned-by-dotbin.txt');
    await mkdir(dotBin, { recursive: true });
    await writeNodeTool(
      dotBin,
      'claude',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); console.log('9.9.9');\n`,
    );
    const env = hostileEnv(dotBin);
    await withCwd(project, async () => {
      const ctx = createNodeDetectContext({ env });
      expect(await ctx.which('claude')).toBeNull();
      const result = await ctx.run('claude', ['--version'], 5000);
      expect(result.code).toBeNull();
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('run() refuses an absolute executable that lives inside the working directory', async () => {
    const project = path.join(root, 'cwd-project-abs');
    const marker = path.join(root, 'pwned-by-abs.txt');
    await mkdir(project);
    const tool = await writeNodeTool(
      project,
      'agent',
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); console.log('9.9.9');\n`,
    );
    const result = await withCwd(project, () =>
      createNodeDetectContext({ env: hostileEnv(NODE_DIR) }).run(tool, ['--version'], 5000),
    );
    expect(result.code).toBeNull();
    expect(result.stderr).toMatch(/refusing/);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('probe time and output bounds', () => {
  it('kills the whole process tree on timeout, not only the direct child', async () => {
    const dir = path.join(root, 'slow-bin');
    const marker = path.join(root, 'grandchild-survived.txt');
    await mkdir(dir);
    // On Windows the direct child is cmd.exe and node.exe is its child.
    const tool = await writeNodeTool(
      dir,
      'slow',
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 3000);\n`,
    );
    const started = Date.now();
    const result = await createNodeDetectContext({ env: hostileEnv(NODE_DIR) }).run(
      tool,
      ['--version'],
      1000,
    );
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.code).toBeNull();
    await sleep(3500);
    expect(existsSync(marker)).toBe(false);
  }, 15_000);

  it('puts the timeout reason first even when the child wrote to stderr', async () => {
    const dir = path.join(root, 'warn-bin');
    await mkdir(dir);
    const tool = await writeNodeTool(
      dir,
      'warns',
      "process.stderr.write('(node:1) DeprecationWarning: something old\\n'); setTimeout(() => {}, 4000);\n",
    );
    const result = await createNodeDetectContext({ env: hostileEnv(NODE_DIR) }).run(
      tool,
      ['--version'],
      1500,
    );
    expect(result.code).toBeNull();
    expect(result.stderr.split('\n')[0]).toBe('timed out after 1500 ms');
    expect(result.stderr).toContain('DeprecationWarning');
  }, 15_000);

  it('gives the child an empty stdin so a tool that reads stdin does not hang', async () => {
    const dir = path.join(root, 'stdin-bin');
    await mkdir(dir);
    const tool = await writeNodeTool(
      dir,
      'reader',
      "process.stdin.resume(); process.stdin.on('end', () => console.log('7.7.7'));\n",
    );
    const result = await createNodeDetectContext({ env: hostileEnv(NODE_DIR) }).run(
      tool,
      ['--version'],
      4000,
    );
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout.trim()).toBe('7.7.7');
  }, 15_000);

  it('caps captured output and reports it as such, not as a timeout', async () => {
    const dir = path.join(root, 'loud-bin');
    await mkdir(dir);
    const tool = await writeNodeTool(dir, 'loud', "process.stdout.write('1'.repeat(300000));\n");
    const result = await createNodeDetectContext({ env: hostileEnv(NODE_DIR) }).run(
      tool,
      ['--version'],
      5000,
    );
    expect(result.code).toBeNull();
    expect(result.stderr).toMatch(/output/);
    expect(result.stderr).not.toMatch(/timed out/);
    expect(result.stdout.length).toBeLessThanOrEqual(64 * 1024);
  }, 15_000);
});
