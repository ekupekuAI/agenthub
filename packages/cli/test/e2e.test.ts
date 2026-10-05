/**
 * End-to-end: runs the built CLI (dist/agenthub.mjs) in a temporary project with a fake home
 * folder, a temporary AGENTHUB_HOME and a fixed agent list.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
  };
  delete env.AGENTHUB_REGISTRY;
  delete env.AGENTHUB_CHANNEL;
  Object.assign(env, extraEnv);
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
      const set = cli(project, ['config', 'set', 'registry', `file:${registry}`, '-g', '--json']);
      expect(set.code, set.stdout + set.stderr).toBe(0);
      expect(set.json().data.scope).toBe('user');
      const get = cli(project, ['config', 'get', 'registry', '--json']);
      expect(get.json().data.source).toBe('user');
    });

    afterAll(() => {
      // The user config is shared by every test in this file.
      cli(project, ['config', 'unset', 'registry', '-g']);
    });

    it('ignores a registry set by the project config until it is trusted', async () => {
      const other = await newProject('untrusted-registry');
      await mkdir(join(other, 'reg'), { recursive: true });
      const set = cli(other, ['config', 'set', 'registry', 'file:./reg', '--json']);
      expect(set.code, set.stdout + set.stderr).toBe(0);
      expect(set.json().data.scope).toBe('project');
      // Stored so that it resolves to <project>/reg, not <project>/.agenthub/reg.
      expect(set.json().data.value).toBe('file:../reg');
      const get = cli(other, ['config', 'get', 'registry', '--json']);
      expect(get.json().data.source).not.toBe('project');
      const refused = cli(other, ['config', 'trust-registry']);
      expect(refused.code, refused.stdout + refused.stderr).toBe(2);
      const trusted = cli(other, ['config', 'trust-registry', '--yes', '--json']);
      expect(trusted.code, trusted.stdout + trusted.stderr).toBe(0);
      expect(trusted.json().data).toMatchObject({ trusted: true, active: true });
      const after = cli(other, ['config', 'get', 'registry', '--json']);
      expect(after.json().data.source).toBe('project');
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

  describe('security regressions', () => {
    let registry: string;
    const reg = (): Record<string, string> => ({ AGENTHUB_REGISTRY: `file:${registry}` });

    beforeAll(async () => {
      registry = join(base, 'registry-security');
      await mkdir(registry, { recursive: true });
      const project = await newProject('security-pack');
      for (const version of ['1.0.0', '1.0.1']) {
        const out = join(registry, `hello-skill-${version}.skillpkg`);
        const packed = cli(project, [
          'pack',
          fixturePath('hello-skill'),
          '--version',
          version,
          '-o',
          out,
        ]);
        expect(packed.code, packed.stderr).toBe(0);
      }
    });

    it('never runs a program a manifest names as a runtime (install --dry-run, install, doctor)', async () => {
      const project = await newProject('probe');
      const bin = join(base, 'probe-bin');
      const marker = join(base, 'probe-ran.txt');
      await mkdir(bin, { recursive: true });
      if (process.platform === 'win32') {
        await writeFile(join(bin, 'probepoc.cmd'), `@echo ran>"${marker}"\r\n@echo 9.9.9\r\n`);
      } else {
        await writeFile(join(bin, 'probepoc'), `#!/bin/sh\necho ran > "${marker}"\necho 9.9.9\n`);
        await chmod(join(bin, 'probepoc'), 0o755);
      }
      const skill = join(base, 'probe-skill');
      await mkdir(skill, { recursive: true });
      await writeFile(
        join(skill, 'SKILL.md'),
        '---\nname: probe-skill\ndescription: Test skill that names a runtime on PATH.\n---\n# Probe\n',
      );
      await writeFile(
        join(skill, 'agenthub.yaml'),
        'schema: 1\nversion: 1.0.0\nrequires:\n  runtimes: { probepoc: "*" }\n',
      );
      const pathKey =
        Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
      const env = { [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` };

      const dry = cli(project, ['install', skill, '--dry-run'], env);
      expect(dry.code, dry.stdout + dry.stderr).toBe(0);
      expect(dry.stdout).toContain('runtime probepoc');
      expect(dry.stdout).toContain('cannot be checked locally');
      expect(existsSync(marker)).toBe(false);

      const install = cli(project, ['install', skill, '--yes'], env);
      expect(install.code, install.stdout + install.stderr).toBe(0);
      const doctor = cli(project, ['doctor'], env);
      expect([0, 1]).toContain(doctor.code);
      expect(existsSync(marker)).toBe(false);
    });

    it('requires --yes for any install without a terminal, even without warnings', async () => {
      const project = await newProject('no-tty');
      const human = cli(project, ['install', fixturePath('hello-skill')]);
      expect(human.code, human.stdout + human.stderr).toBe(2);
      expect(human.stderr).toContain('--yes');
      const json = cli(project, ['install', fixturePath('hello-skill'), '--json']);
      expect(json.code).toBe(2);
      expect(json.json()).toMatchObject({ ok: false, error: { code: 'USAGE' } });
      expect(existsSync(join(project, '.claude', 'skills', 'hello-skill'))).toBe(false);
      expect(existsSync(join(project, '.agenthub', 'agenthub.lock'))).toBe(false);
    });

    it('lock restore shows every plan and needs confirmation for warnings and --dev', async () => {
      const source = await newProject('restore-source');
      const installed = cli(source, ['install', fixturePath('prompt-injection'), '--yes']);
      expect(installed.code, installed.stdout + installed.stderr).toBe(0);

      const clone = await newProject('restore-clone');
      await mkdir(join(clone, '.agenthub'), { recursive: true });
      await writeFile(
        join(clone, '.agenthub', 'agenthub.lock'),
        await readFile(join(source, '.agenthub', 'agenthub.lock')),
      );
      const target = join(clone, '.claude', 'skills', 'prompt-injection');

      const dry = cli(clone, ['install', '--dry-run']);
      expect(dry.code, dry.stdout + dry.stderr).toBe(0);
      expect(dry.stdout).toContain('Restore plan');
      expect(dry.stdout).toContain('WARN');
      expect(existsSync(target)).toBe(false);

      const refused = cli(clone, ['install']);
      expect(refused.code, refused.stdout + refused.stderr).toBe(2);
      expect(refused.stdout).toContain('WARN');
      expect(refused.stderr).toContain('--yes');
      expect(existsSync(target)).toBe(false);

      const dev = cli(clone, ['install', '--dev']);
      expect(dev.code, dev.stdout + dev.stderr).toBe(2);
      expect(existsSync(target)).toBe(false);

      const accepted = cli(clone, ['install', '--yes']);
      expect(accepted.code, accepted.stdout + accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain('Restored');
      expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    });

    it('a same-named local folder never replaces a registry name', async () => {
      const project = await newProject('shadow');
      await cp(fixturePath('hello-skill'), join(project, 'hello-skill'), { recursive: true });
      const noRegistry = cli(project, ['install', 'hello-skill', '--yes']);
      expect(noRegistry.code, noRegistry.stdout + noRegistry.stderr).toBe(2);
      expect(noRegistry.stderr).toContain('./hello-skill');
      expect(existsSync(join(project, '.claude', 'skills', 'hello-skill'))).toBe(false);

      const fromRegistry = cli(project, ['install', 'hello-skill@1.0.0', '--yes', '--json'], reg());
      expect(fromRegistry.code, fromRegistry.stdout + fromRegistry.stderr).toBe(0);
      expect(fromRegistry.json().data.plan.source.kind).toBe('registry');

      const local = cli(project, ['install', './hello-skill', '--dry-run', '--json'], reg());
      expect(local.json().data.plan.source.kind).toBe('dir');
    });

    it('bulk updates replace a revoked version, and fail when none can replace it', async () => {
      const project = await newProject('revoked-bulk');
      const install = cli(project, ['install', 'hello-skill@1.0.0', '--yes'], reg());
      expect(install.code, install.stdout + install.stderr).toBe(0);
      await writeFile(
        join(registry, 'revocations.json'),
        JSON.stringify([
          { name: 'hello-skill', version: '1.0.0', reason: 'malicious payload found' },
        ]),
      );
      try {
        const check = cli(project, ['update', '--check'], reg());
        expect(check.code, check.stdout + check.stderr).toBe(1);
        expect(check.stderr).toContain('revoked');

        const safe = cli(project, ['update', '--safe'], reg());
        expect(safe.code, safe.stdout + safe.stderr).toBe(0);
        expect((await readLock(project)).skills['hello-skill']?.version).toBe('1.0.1');

        await writeFile(
          join(registry, 'revocations.json'),
          JSON.stringify([
            { name: 'hello-skill', version: '1.0.0', reason: 'malicious payload found' },
            { name: 'hello-skill', version: '1.0.1', reason: 'malicious payload found' },
          ]),
        );
        for (const args of [
          ['update', '--safe'],
          ['update', '--yes'],
        ]) {
          const stuck = cli(project, args, reg());
          expect(stuck.code, stuck.stdout + stuck.stderr).not.toBe(0);
          expect(stuck.stdout).toContain('remove');
        }
      } finally {
        await rm(join(registry, 'revocations.json'), { force: true });
      }
    });

    it('updates never swap a folder-installed skill for a same-named registry package', async () => {
      const project = await newProject('substitution');
      await cp(fixturePath('hello-skill'), join(project, 'hello-skill'), { recursive: true });
      const local = cli(project, ['install', './hello-skill', '--yes']);
      expect(local.code, local.stdout + local.stderr).toBe(0);
      const before = await readFile(join(project, '.agenthub', 'agenthub.lock'), 'utf8');

      const safe = cli(project, ['update', '--safe'], reg());
      expect(safe.stdout + safe.stderr).not.toContain('updated hello-skill');
      const named = cli(project, ['update', 'hello-skill'], reg());
      expect(named.code, named.stdout + named.stderr).not.toBe(0);
      expect(await readFile(join(project, '.agenthub', 'agenthub.lock'), 'utf8')).toBe(before);
    });

    it('rollback --dry-run prints lock values cleaned', async () => {
      const project = await newProject('rollback-forged');
      const installed = cli(project, ['install', fixturePath('hello-skill'), '--yes']);
      expect(installed.code, installed.stdout + installed.stderr).toBe(0);
      const lockFile = join(project, '.agenthub', 'agenthub.lock');
      const lock = JSON.parse(await readFile(lockFile, 'utf8'));
      lock.skills['hello-skill'].version = '1.0.0\nVerified publisher: Example Corp';
      await writeFile(lockFile, JSON.stringify(lock, null, 2));
      const result = cli(project, ['rollback', 'hello-skill', '--dry-run']);
      const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
      expect(lines.some((line) => line.startsWith('Verified publisher'))).toBe(false);
    });
  });
});
