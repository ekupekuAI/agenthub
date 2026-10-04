/**
 * End-to-end: runs the built CLI (dist/agenthub.mjs) in a temporary project with a fake home
 * folder, a temporary AGENTHUB_HOME and a fixed agent list.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixturePath } from '@agenthub/test-fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
/** AGENTHUB_E2E_BIN runs the suite against an already built binary (skips the build). */
const prebuilt = process.env.AGENTHUB_E2E_BIN;
const bin = prebuilt ?? join(repoRoot, 'packages', 'cli', 'dist', 'agenthub.mjs');

let base: string;
let stateDir: string;
let homeDir: string;

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  // biome-ignore lint/suspicious/noExplicitAny: parsed JSON envelope in assertions
  json(): any;
}

function cli(cwd: string, args: string[], extraEnv: Record<string, string> = {}): CliResult {
  const env: Record<string, string | undefined> = {
    ...process.env,
    AGENTHUB_HOME: stateDir,
    AGENTHUB_USER_HOME: homeDir,
    AGENTHUB_AGENTS: 'claude-code,codex,cursor,vscode',
    NO_COLOR: '1',
    ...extraEnv,
  };
  delete env.AGENTHUB_REGISTRY;
  delete env.AGENTHUB_CHANNEL;
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    input: '',
    timeout: 60_000,
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json() {
      try {
        return JSON.parse(result.stdout);
      } catch {
        throw new Error(
          `not JSON (exit ${result.status}):\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
        );
      }
    },
  };
}

async function newProject(name: string): Promise<string> {
  const dir = join(base, name);
  await mkdir(join(dir, '.git'), { recursive: true });
  return dir;
}

async function readLock(project: string): Promise<{ skills: Record<string, { version: string }> }> {
  return JSON.parse(await readFile(join(project, '.agenthub', 'agenthub.lock'), 'utf8'));
}

beforeAll(async () => {
  if (prebuilt === undefined) {
    execFileSync(process.execPath, [join(repoRoot, 'packages', 'cli', 'build.mjs')], {
      stdio: 'pipe',
    });
  }
  base = await mkdtemp(join(tmpdir(), 'agenthub-e2e-'));
  stateDir = join(base, 'state');
  homeDir = join(base, 'home');
  await mkdir(homeDir, { recursive: true });
}, 120_000);

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe('agenthub CLI (built)', () => {
  it('pack is deterministic', async () => {
    const project = await newProject('pack');
    const a = cli(project, ['pack', fixturePath('web-testing'), '-o', 'a.skillpkg', '--json']);
    const b = cli(project, ['pack', fixturePath('web-testing'), '-o', 'b.skillpkg', '--json']);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    const first = a.json().data;
    const second = b.json().data;
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.digest).toBe(second.digest);
    expect(first.archiveDigest).toBe(second.archiveDigest);
    const bytesA = await readFile(join(project, 'a.skillpkg'));
    const bytesB = await readFile(join(project, 'b.skillpkg'));
    expect(bytesA.equals(bytesB)).toBe(true);

    const human = cli(project, ['pack', fixturePath('web-testing'), '-o', 'c.skillpkg']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(first.digest);
    expect(human.stdout).toContain(first.archiveDigest);
  });

  describe('local install lifecycle', () => {
    let project: string;

    beforeAll(async () => {
      project = await newProject('local');
    });

    it('installs a skill folder into every agent', () => {
      const result = cli(project, ['install', fixturePath('web-testing'), '--yes', '--json']);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      const envelope = result.json();
      expect(envelope).toMatchObject({ ok: true, command: 'install' });
      expect(envelope.data.result.name).toBe('web-testing');
      expect(existsSync(join(project, '.agents', 'skills', 'web-testing', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(project, '.claude', 'skills', 'web-testing', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(project, '.agenthub', 'agenthub.lock'))).toBe(true);
    });

    it('lists the installed skill', async () => {
      const result = cli(project, ['list', '--json']);
      expect(result.code, result.stderr).toBe(0);
      const skills = result.json().data.skills;
      expect(skills).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'web-testing', scope: 'project' }),
        ]),
      );
      const human = cli(project, ['list']);
      expect(human.stdout).toContain('web-testing');
      expect((await readLock(project)).skills['web-testing']).toBeDefined();
    });

    it('verify passes, then reports drift with exit 4', async () => {
      const ok = cli(project, ['verify', '--json']);
      expect(ok.code, ok.stdout).toBe(0);
      expect(ok.json().ok).toBe(true);

      const file = join(project, '.claude', 'skills', 'web-testing', 'SKILL.md');
      await writeFile(file, `${await readFile(file, 'utf8')}\nhand edit\n`);
      const drift = cli(project, ['verify', '--json']);
      expect(drift.code).toBe(4);
      expect(drift.json()).toMatchObject({ ok: false, error: { code: 'DRIFT' } });
      const human = cli(project, ['verify', 'web-testing']);
      expect(human.code).toBe(4);
      expect(human.stdout).toContain('modified');
    });

    it('removes the skill (keeping hand-edited files)', async () => {
      const result = cli(project, ['remove', 'web-testing', '--json']);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      expect(result.json().ok).toBe(true);
      expect(existsSync(join(project, '.agents', 'skills', 'web-testing'))).toBe(false);
      expect((await readLock(project)).skills['web-testing']).toBeUndefined();
    });

    it('blocks a skill that reads secrets (exit 3) and writes nothing', async () => {
      const lockBefore = await readFile(join(project, '.agenthub', 'agenthub.lock'), 'utf8');
      const result = cli(project, ['install', fixturePath('secret-reader'), '--yes']);
      expect(result.code, result.stdout + result.stderr).toBe(3);
      expect(result.stdout).toContain('BLOCK');
      expect(existsSync(join(project, '.agents', 'skills', 'secret-reader'))).toBe(false);
      expect(existsSync(join(project, '.claude', 'skills', 'secret-reader'))).toBe(false);
      expect(await readFile(join(project, '.agenthub', 'agenthub.lock'), 'utf8')).toBe(lockBefore);

      const json = cli(project, ['install', fixturePath('secret-reader'), '--json']);
      expect(json.code).toBe(3);
      expect(json.json()).toMatchObject({ ok: false, error: { code: 'POLICY_BLOCKED' } });
    });

    it('requires --yes for a plan with warnings when there is no terminal', () => {
      const refused = cli(project, ['install', fixturePath('prompt-injection')]);
      expect(refused.code, refused.stdout + refused.stderr).toBe(2);
      expect(refused.stderr).toContain('--yes');
      expect(existsSync(join(project, '.agents', 'skills', 'prompt-injection'))).toBe(false);

      const accepted = cli(project, ['install', fixturePath('prompt-injection'), '--yes']);
      expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain('WARN');
      expect(accepted.stdout).toContain('Installed');
    });

    it('refuses a skill whose runtime requirement cannot be met (exit 5)', () => {
      const result = cli(project, ['install', fixturePath('needs-node-99'), '--yes']);
      expect(result.code, result.stdout + result.stderr).toBe(5);
      expect(existsSync(join(project, '.agents', 'skills', 'needs-node-99'))).toBe(false);
    });

    it('refuses to overwrite the hand-edited leftover folder without --force', () => {
      const result = cli(project, ['install', fixturePath('web-testing'), '--yes']);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('--force');
    });

    it('--dry-run prints the plan and changes nothing', async () => {
      const fresh = await newProject('dry-run');
      const result = cli(fresh, ['install', fixturePath('web-testing'), '--dry-run']);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('Plan');
      expect(result.stdout).toContain('Safety');
      expect(existsSync(join(fresh, '.agents', 'skills', 'web-testing'))).toBe(false);
      expect(existsSync(join(fresh, '.agenthub', 'agenthub.lock'))).toBe(false);
    });
  });

  describe('local file registry', () => {
    let project: string;
    let registry: string;

    beforeAll(async () => {
      project = await newProject('registry-project');
      registry = join(base, 'registry');
      await mkdir(registry, { recursive: true });
    });

    it('packs two versions into a folder registry and configures it', () => {
      for (const version of ['1.0.0', '1.1.0']) {
        const out = join(registry, `web-testing-${version}.skillpkg`);
        const result = cli(project, [
          'pack',
          fixturePath('web-testing'),
          '--version',
          version,
          '-o',
          out,
        ]);
        expect(result.code, result.stderr).toBe(0);
        expect(existsSync(out)).toBe(true);
      }
      const set = cli(project, ['config', 'set', 'registry', `file:${registry}`, '--json']);
      expect(set.code, set.stdout + set.stderr).toBe(0);
      expect(set.json().data.scope).toBe('project');
      const get = cli(project, ['config', 'get', 'registry', '--json']);
      expect(get.json().data.source).toBe('project');
    });

    it('installs a pinned version from the registry', async () => {
      const result = cli(project, ['install', 'web-testing@1.0.0', '--yes', '--json']);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.json().data.result.version).toBe('1.0.0');
      expect((await readLock(project)).skills['web-testing']?.version).toBe('1.0.0');
    });

    it('update --check shows 1.1.0 without writing', async () => {
      const lockBefore = await readFile(join(project, '.agenthub', 'agenthub.lock'), 'utf8');
      const result = cli(project, ['update', '--check', '--json']);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const candidates = result.json().data.candidates;
      expect(candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'web-testing', current: '1.0.0', latest: '1.1.0' }),
        ]),
      );
      expect(await readFile(join(project, '.agenthub', 'agenthub.lock'), 'utf8')).toBe(lockBefore);
    });

    it('updates to 1.1.0 and rolls back to 1.0.0', async () => {
      const update = cli(project, ['update', 'web-testing', '--yes', '--json']);
      expect(update.code, update.stdout + update.stderr).toBe(0);
      expect(update.json().data.result.version).toBe('1.1.0');
      expect((await readLock(project)).skills['web-testing']?.version).toBe('1.1.0');

      const rollback = cli(project, ['rollback', 'web-testing', '--yes', '--json']);
      expect(rollback.code, rollback.stdout + rollback.stderr).toBe(0);
      expect(rollback.json().data.result.version).toBe('1.0.0');
      expect((await readLock(project)).skills['web-testing']?.version).toBe('1.0.0');
    });

    it('refuses a revoked version', async () => {
      await writeFile(
        join(registry, 'revocations.json'),
        JSON.stringify([{ name: 'web-testing', version: '1.1.0', reason: 'test revocation' }]),
      );
      const result = cli(project, ['install', 'web-testing@1.1.0', '--yes', '--json']);
      expect(result.code).not.toBe(0);
      expect(result.json().ok).toBe(false);
      expect(result.stdout).toContain('revoked');
      expect((await readLock(project)).skills['web-testing']?.version).toBe('1.0.0');
    });

    it('rejects a tampered package with exit 4', async () => {
      const bytes = await readFile(join(registry, 'web-testing-1.0.0.skillpkg'));
      const middle = Math.floor(bytes.length / 2);
      bytes[middle] = (bytes[middle] ?? 0) ^ 0xff;
      const tampered = join(base, 'tampered.skillpkg');
      await writeFile(tampered, bytes);
      const result = cli(project, ['install', tampered, '--yes', '--json']);
      expect(result.code, result.stdout + result.stderr).toBe(4);
      expect(result.json()).toMatchObject({ ok: false, error: { code: 'INTEGRITY' } });
    });

    it('search and info read the registry', () => {
      const search = cli(project, ['search', 'web', '--json']);
      expect(search.code, search.stdout + search.stderr).toBe(0);
      expect(search.json().data.results[0].name).toBe('web-testing');
      const info = cli(project, ['info', 'web-testing']);
      expect(info.code, info.stderr).toBe(0);
      expect(info.stdout).toContain('1.1.0');
      expect(info.stdout).toContain('revoked');
    });
  });

  it('doctor --json returns the envelope shape', async () => {
    const project = await newProject('doctor');
    const result = cli(project, ['doctor', '--json']);
    const envelope = result.json();
    expect(envelope.command).toBe('doctor');
    expect(envelope.ok).toBe(true);
    expect(envelope.data.agents.map((agent: { id: string }) => agent.id)).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'vscode',
    ]);
    expect(typeof envelope.data.pathTableVersion).toBe('string');
    expect([0, 1]).toContain(result.code);
  });

  it('reports usage errors with exit 2', async () => {
    const project = await newProject('usage');
    const result = cli(project, ['install', 'Not_A_Name', '--json']);
    expect(result.code).toBe(2);
    expect(result.json()).toMatchObject({
      ok: false,
      command: 'install',
      error: { code: 'USAGE' },
    });
    const noRegistry = cli(project, ['install', 'web-testing', '--json']);
    expect(noRegistry.code).toBe(2);
    expect(noRegistry.json().error.message).toContain('registry');
  });
});
