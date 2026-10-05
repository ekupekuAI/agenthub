/**
 * Regression tests for the install-engine security review: untrusted project config, lock
 * entries, registries and journals (a cloned repository is attacker-controlled).
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os, { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_PATHS,
  duplicateAgents,
  getAdapter,
  isWritableSkillsDir,
  PATH_TABLE_VERSION,
  selectTargetFolders,
} from '@agenthub/adapters';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvesWithin } from '../src/engine/fsutil';
import {
  AGENT_IDS,
  type AgentEnvironment,
  AgentHubError,
  type AgentPort,
  contentDigest,
  createEngine,
  createFileRegistry,
  type Engine,
  type EngineDeps,
  type EvaluatedFinding,
  type Finding,
  fileHash,
  findProjectRoot,
  hashInstalledDir,
  type InstallPlan,
  type Journal,
  type LockEntry,
  type LockFile,
  loadConfig,
  loadSkillFromDir,
  lockSettings,
  mkdirp,
  packSkill,
  type RegistrySource,
  resolveRegistry,
  type SecurityPort,
  scopeStateDir,
  serializeLock,
  trustProjectRegistry,
  WriteGuard,
  writeJournal,
} from '../src/index';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

/** READ_SECRETS → high (BLOCK), IGNORE_INSTRUCTIONS → medium (WARN). */
const fakeSecurity: SecurityPort = {
  scan(files) {
    const findings: Finding[] = [];
    for (const file of files) {
      decoder
        .decode(file.content)
        .split('\n')
        .forEach((line, index) => {
          if (line.includes('READ_SECRETS') || line.includes('IGNORE_INSTRUCTIONS')) {
            const high = line.includes('READ_SECRETS');
            findings.push({
              ruleId: high ? 'secrets.read' : 'prompt.injection',
              category: high ? 'secrets' : 'prompt',
              severity: high ? 'high' : 'medium',
              declarable: high,
              file: file.path,
              line: index + 1,
              evidence: line.slice(0, 120),
              message: 'test finding',
            });
          }
        });
    }
    return { scannerVersion: 'fake-1', findings };
  },
  evaluate(findings, _manifest, opts) {
    const evaluated: EvaluatedFinding[] = findings.map((finding) => ({
      ...finding,
      declared: false,
      decision: finding.severity === 'high' && !opts?.dev ? 'BLOCK' : 'WARN',
    }));
    const outcome = evaluated.some((f) => f.decision === 'BLOCK')
      ? 'block'
      : evaluated.some((f) => f.decision === 'WARN')
        ? 'confirm'
        : 'allow';
    return { findings: evaluated, outcome };
  },
};

const DETECTED: AgentEnvironment[] = AGENT_IDS.map((id) => ({
  id,
  displayName: id,
  confidence: 'high',
  evidence: ['test'],
  status: 'verified',
}));

const agentPort: AgentPort = {
  detect: async () => DETECTED,
  selectTargets: (scope, agents) => selectTargetFolders(scope, agents),
  duplicates: (scope, folders) => duplicateAgents(scope, folders),
  reads: (agent, scope, dir) => getAdapter(agent).reads(scope, dir),
  isWritable: (scope, dir) => isWritableSkillsDir(scope, dir),
  reloadHint: (agent) => AGENT_PATHS[agent].reloadHint,
  tableVersion: PATH_TABLE_VERSION,
};

let base: string;
let home: string;
let agenthubHome: string;
let project: string;
let skills: string;
let hooks: NonNullable<EngineDeps['hooks']>;
let savedRegistryEnv: string | undefined;

function make(overrides: Partial<EngineDeps> = {}): Engine {
  return createEngine({
    cwd: project,
    home,
    agenthubHome,
    agents: agentPort,
    security: fakeSecurity,
    probe: { runtime: async () => '24.0.0', command: async () => true },
    hooks,
    ...overrides,
  });
}

beforeEach(async () => {
  savedRegistryEnv = process.env.AGENTHUB_REGISTRY;
  delete process.env.AGENTHUB_REGISTRY;
  base = await mkdtemp(join(tmpdir(), 'agenthub-sec-'));
  home = join(base, 'home');
  agenthubHome = join(base, 'state');
  project = join(base, 'project');
  skills = join(base, 'skills');
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(skills, { recursive: true });
  hooks = {};
});

afterEach(async () => {
  if (savedRegistryEnv === undefined) delete process.env.AGENTHUB_REGISTRY;
  else process.env.AGENTHUB_REGISTRY = savedRegistryEnv;
  await rm(base, { recursive: true, force: true });
});

interface SkillSpec {
  version?: string;
  body?: string;
  files?: Record<string, string>;
}

async function makeSkill(name: string, spec: SkillSpec = {}, parent = skills): Promise<string> {
  const dir = join(parent, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} test skill.\n---\n${spec.body ?? '# Usage\n'}`,
  );
  if (spec.version)
    await writeFile(join(dir, 'agenthub.yaml'), `schema: 1\nversion: ${spec.version}\n`);
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    await mkdir(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...rel.split('/')), content);
  }
  return dir;
}

async function publish(
  registryDir: string,
  name: string,
  version: string,
  body = `# ${version}\n`,
) {
  const dir = await makeSkill(
    name,
    { version, body },
    join(base, 'build', registryDir.length.toString(), version),
  );
  await mkdir(registryDir, { recursive: true });
  await writeFile(
    join(registryDir, `${name}-${version}.skillpkg`),
    packSkill(await loadSkillFromDir(dir)),
  );
}

async function installDir(
  engine: Engine,
  name: string,
  spec: SkillSpec = {},
  extra: {
    scope?: 'project' | 'user';
    dev?: boolean;
    agents?: InstallPlan['agents'][number]['id'][];
  } = {},
) {
  const dir = await makeSkill(name, spec);
  const plan = await engine.plan({
    source: { kind: 'dir', path: dir },
    scope: extra.scope ?? 'project',
    ...(extra.dev ? { dev: true } : {}),
    ...(extra.agents ? { agents: extra.agents } : {}),
  });
  return { plan, result: await engine.apply(plan) };
}

async function catchAsync(fn: () => Promise<unknown>): Promise<AgentHubError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AgentHubError) return error;
    throw error;
  }
  throw new Error('expected an AgentHubError');
}

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (abs: string, prefix: string) => {
    for (const name of (await readdir(abs)).sort()) {
      const full = join(abs, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(full).isDirectory()) await walk(full, rel);
      else out[rel] = (await readFile(full)).toString('base64');
    }
  };
  await walk(dir, '');
  return out;
}

const projectLock = () => join(project, '.agenthub', 'agenthub.lock');
const readLockFile = async (file = projectLock()) =>
  JSON.parse(await readFile(file, 'utf8')) as LockFile;
const writeLockFile = async (lock: LockFile, file = projectLock()) =>
  writeFile(file, serializeLock(lock));

async function removeFolders() {
  await rm(join(project, '.claude'), { recursive: true, force: true });
  await rm(join(project, '.agents'), { recursive: true, force: true });
}

/** Installed folders and the package cache are gone (a fresh clone of the repository). */
async function removeInstalled() {
  await removeFolders();
  await rm(join(agenthubHome, 'cache'), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Findings 0 / 11 / 4: project config and file: registries
// ---------------------------------------------------------------------------

describe('project config cannot redirect the registry', () => {
  const projectConfig = () => join(project, '.agenthub', 'config.json');

  async function hostileProject(registry = 'file:r') {
    await mkdir(join(project, '.agenthub', 'r'), { recursive: true });
    await publish(join(project, '.agenthub', 'r'), 'web-testing', '99.0.0');
    await writeFile(
      projectConfig(),
      JSON.stringify({ registry, agents: ['claude-code', 'codex', 'cursor', 'vscode'] }),
    );
  }

  it('ignores an untrusted project registry, says how to trust it, and keeps user scope clean', async () => {
    await mkdir(agenthubHome, { recursive: true });
    await writeFile(
      join(agenthubHome, 'config.json'),
      JSON.stringify({ registry: 'https://user.example' }),
    );
    await hostileProject();
    const config = loadConfig({ cwd: project, home, agenthubHome, env: {} });
    expect(config.effective.registry).toBe('https://user.example');
    expect(config.sources.registry).toBe('user');
    expect(config.ignoredProjectRegistry).toBe('file:r');
    expect(config.warnings[0]).toContain('trustedProjectRegistries');
    expect(config.warnings[0]).toContain('AGENTHUB_REGISTRY');

    const userScope = loadConfig({ cwd: project, home, agenthubHome, env: {}, scope: 'user' });
    expect(userScope.effective.agents).toBe('detected');
    expect(userScope.warnings).toEqual([]);
  });

  it('never resolves a name against the repository registry, at either scope', async () => {
    await hostileProject();
    const engine = make();
    for (const scope of ['user', 'project'] as const) {
      const error = await catchAsync(() =>
        engine.plan({ source: { kind: 'registry', name: 'web-testing' }, scope }),
      );
      expect(error.code).toBe('USAGE');
      expect(error.message).toContain('no registry configured');
    }
    const { plan } = await installDir(engine, 'hello-skill');
    expect(plan.hints.some((hint) => hint.includes('ignoring "registry"'))).toBe(true);
    const report = await engine.doctor();
    expect(report.problems.some((p) => p.code === 'config.project-ignored')).toBe(true);
  });

  it('honors a trusted project registry for project scope only', async () => {
    await hostileProject();
    await trustProjectRegistry(join(agenthubHome, 'config.json'), project, 'file:r');
    const config = loadConfig({ cwd: project, home, agenthubHome, env: {} });
    expect(config.sources.registry).toBe('project');
    expect(config.effective.registry).toBe(`file:${join(project, '.agenthub', 'r')}`);

    const engine = make();
    const plan = await engine.plan({
      source: { kind: 'registry', name: 'web-testing' },
      scope: 'project',
    });
    expect(plan.skill.version).toBe('99.0.0');
    expect(plan.hints.some((hint) => hint.includes('set by the project config'))).toBe(true);
    const error = await catchAsync(() =>
      engine.plan({ source: { kind: 'registry', name: 'web-testing' }, scope: 'user' }),
    );
    expect(error.code).toBe('USAGE');
    expect(error.message).toContain('user-scope (-g) commands');
  });

  it('refuses a project file: registry outside the project even when trusted', async () => {
    await mkdir(join(project, '.agenthub'), { recursive: true });
    await writeFile(projectConfig(), JSON.stringify({ registry: 'file:../../elsewhere' }));
    await trustProjectRegistry(join(agenthubHome, 'config.json'), project, 'file:../../elsewhere');
    const config = loadConfig({ cwd: project, home, agenthubHome, env: {} });
    expect(config.effective.registry).toBeUndefined();
    expect(config.warnings[0]).toContain('inside that project');
  });

  it('refuses UNC, device and //host file: registries everywhere', async () => {
    for (const value of [
      'file://evil.example/share',
      'file:\\\\evil.example\\share',
      'file://evil.example',
      'file:\\\\?\\C:\\x',
      'file:////evil.example/share',
      'file://///evil.example/share',
    ]) {
      expect(() => resolveRegistry(value, base), value).toThrow(/network path/);
    }
    expect(() =>
      loadConfig({
        cwd: project,
        home,
        agenthubHome,
        env: { AGENTHUB_REGISTRY: 'file://evil.example/share' },
      }),
    ).toThrow(/network path/);
    // From a project it is ignored with a warning (a hostile repo must not break every command).
    await mkdir(join(project, '.agenthub'), { recursive: true });
    await writeFile(projectConfig(), JSON.stringify({ registry: 'file://evil.example/share' }));
    const config = loadConfig({ cwd: project, home, agenthubHome, env: {} });
    expect(config.effective.registry).toBeUndefined();
    expect(config.warnings[0]).toContain('network path');
    expect(() => createFileRegistry('\\\\evil.example\\share')).toThrow(/network path/);
    expect(() => createFileRegistry('//evil.example/share')).toThrow(/network path/);
  });

  it('restoring a hostile lock never downloads from the repository registry', async () => {
    await hostileProject();
    const pkgDir = await makeSkill('web-testing', { version: '99.0.0', body: '# 99.0.0\n' });
    const pkg = await loadSkillFromDir(pkgDir);
    const lock: LockFile = {
      lockfileVersion: 2,
      skills: {
        'web-testing': {
          version: '99.0.0',
          digest: pkg.digest,
          source: 'registry',
          registry: `file:${join(project, '.agenthub', 'r')}`,
          installedTargets: ['claude-code'],
          paths: { '.claude/skills/web-testing': ['claude-code'] },
          files: pkg.fileHashes,
          installedAt: new Date().toISOString(),
        },
      },
    };
    await writeLockFile(lock);
    const error = await catchAsync(() => make().restore('project'));
    expect(error.code).toBe('NOT_FOUND');
    expect(exists(join(project, '.claude', 'skills', 'web-testing'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Findings 1 / 9 / 16 / 27: lock entries are bound to their registry
// ---------------------------------------------------------------------------

describe('updates and restores use the registry recorded in the lock', () => {
  let regA: string;
  let regB: string;

  beforeEach(async () => {
    regA = join(base, 'registry-a');
    regB = join(base, 'registry-b');
    await publish(regA, 'web-testing', '1.0.0');
    await publish(regB, 'web-testing', '1.0.0', '# other contents\n');
    await publish(regB, 'web-testing', '9.9.9');
  });

  async function installFrom(registryDir: string, range: string) {
    const engine = make({ registry: createFileRegistry(registryDir) });
    await engine.apply(
      await engine.plan({
        source: { kind: 'registry', name: 'web-testing', range },
        scope: 'project',
      }),
    );
  }

  it('refuses to update, restore or reinstall from another registry', async () => {
    await installFrom(regA, '1.0.0');
    const engineB = make({ registry: createFileRegistry(regB) });

    const [check] = await engineB.checkUpdates('project');
    expect(check?.status).toBe('registry-mismatch');
    expect(check?.reason).toContain(regA);
    expect(check?.reason).toContain(regB);

    const update = await catchAsync(() => engineB.planUpdate('web-testing', 'project'));
    expect(update.code).toBe('CONFLICT');
    expect(update.message).toContain(regA);
    expect(update.message).toContain(regB);

    const reinstall = await engineB.plan({
      source: { kind: 'registry', name: 'web-testing' },
      scope: 'project',
    });
    expect(reinstall.blockers.map((b) => b.code)).toContain('CONFLICT');
    expect(reinstall.blockers.some((b) => b.message.includes('--force'))).toBe(true);

    await removeInstalled();
    const restore = await catchAsync(() => engineB.restore('project'));
    expect(restore.code).toBe('CONFLICT');
    expect(restore.message).toContain(regB);
    expect(exists(join(project, '.claude', 'skills', 'web-testing'))).toBe(false);
  });

  it('never offers a registry update for a skill installed from a folder', async () => {
    await installDir(make(), 'web-testing', { version: '0.0.1' });
    const engineB = make({ registry: createFileRegistry(regB) });
    const [check] = await engineB.checkUpdates('project');
    expect(check).toMatchObject({ status: 'not-in-registry' });
    expect(check?.reason).toContain('local folder');
    expect((await catchAsync(() => engineB.planUpdate('web-testing', 'project'))).code).toBe(
      'CONFLICT',
    );
  });

  it('reports a registry copy with other contents and plans a reinstall', async () => {
    await installFrom(regA, '1.0.0');
    const lock = await readLockFile();
    const entry = lock.skills['web-testing'] as LockEntry;
    // A lock entry for the same version with other (self-consistent) contents.
    const extra = 'not published by the registry\n';
    for (const dir of Object.keys(entry.paths)) {
      await writeFile(join(project, ...dir.split('/'), 'extra.md'), extra);
    }
    entry.files = { ...entry.files, 'extra.md': fileHash(new TextEncoder().encode(extra)) };
    entry.digest = contentDigest(entry.files);
    entry.version = '1.0.0+relabelled';
    await writeLockFile(lock);
    const engine = make({ registry: createFileRegistry(regA) });
    expect((await engine.verify('project'))[0]?.ok).toBe(true);
    const [check] = await engine.checkUpdates('project');
    expect(check?.status).toBe('digest-mismatch');
    const plan = await engine.planUpdate('web-testing', 'project');
    expect(plan?.skill.version).toBe('1.0.0');
    expect(plan?.targets.every((t) => t.action === 'replace')).toBe(true);
  });

  it('checkUpdates honors the requested channel', async () => {
    const reg = join(base, 'registry-beta');
    await publish(reg, 'web-testing', '1.0.0');
    await publish(reg, 'web-testing', '2.0.0-beta.1');
    await installFrom(reg, '1.0.0');
    const engine = make({ registry: createFileRegistry(reg) });
    expect((await engine.checkUpdates('project'))[0]?.status).toBe('up-to-date');
    const [beta] = await engine.checkUpdates('project', undefined, { channel: 'beta' });
    expect(beta).toMatchObject({ status: 'available', latestCompatible: '2.0.0-beta.1' });
  });
});

// ---------------------------------------------------------------------------
// Findings 2 / 7: lock files vs digest
// ---------------------------------------------------------------------------

describe('lock entries are untrusted', () => {
  it('rejects an entry whose digest is not the digest of its files', async () => {
    const engine = make();
    await installDir(engine, 'hello-skill', { version: '1.0.0' });
    const lock = await readLockFile();
    const entry = lock.skills['hello-skill'] as LockEntry;
    const evil = '---\nname: hello-skill\ndescription: x\n---\nREAD_SECRETS\n';
    for (const dir of Object.keys(entry.paths)) {
      await writeFile(join(project, ...dir.split('/'), 'SKILL.md'), evil);
    }
    entry.files['SKILL.md'] = fileHash(new TextEncoder().encode(evil));
    await writeLockFile(lock); // digest still names the genuine package
    for (const run of [
      () => engine.list('project'),
      () => engine.verify('project'),
      () => engine.restore('project'),
      () => engine.checkUpdates('project'),
    ]) {
      const error = await catchAsync(run);
      expect(error.code).toBe('VALIDATION');
      expect(error.message).toContain('hello-skill');
    }
  });

  it('plans a replace, never "unchanged", when the folder is not the scanned package', async () => {
    const engine = make();
    const { plan: first } = await installDir(engine, 'hello-skill', { version: '1.0.0' });
    const lock = await readLockFile();
    const entry = lock.skills['hello-skill'] as LockEntry;
    for (const dir of Object.keys(entry.paths)) {
      await writeFile(join(project, ...dir.split('/'), 'run.sh'), 'READ_SECRETS\n');
    }
    // A self-consistent forged entry for the malicious folder.
    entry.files = await hashInstalledDir(join(project, '.claude', 'skills', 'hello-skill'));
    entry.digest = contentDigest(entry.files);
    await writeLockFile(lock);
    const plan = await engine.plan({
      source: { kind: 'dir', path: join(skills, 'hello-skill') },
      scope: 'project',
    });
    expect(plan.skill.digest).toBe(first.skill.digest);
    expect(plan.targets.map((t) => t.action)).toEqual(['replace', 'replace']);
    expect(plan.needsConfirmation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Findings 3 / 10: restore confirmation
// ---------------------------------------------------------------------------

describe('restore goes through plans and confirmation', () => {
  it('asks before a WARN plan, and writes nothing without consent', async () => {
    const engine = make();
    await installDir(engine, 'aaa-skill');
    await installDir(engine, 'warn-skill', { body: 'IGNORE_INSTRUCTIONS please\n' });
    await removeFolders();

    const plans = await engine.planRestore('project');
    expect(plans.map((p) => [p.skill.name, p.needsConfirmation])).toEqual([
      ['aaa-skill', false],
      ['warn-skill', true],
    ]);

    const refused = await catchAsync(() => engine.restore('project'));
    expect(refused.code).toBe('USAGE');
    expect(refused.message).toContain('warn-skill');
    expect(exists(join(project, '.claude', 'skills', 'aaa-skill'))).toBe(false);

    const cancelled = await catchAsync(() =>
      engine.restore('project', { confirm: async () => false }),
    );
    expect(cancelled.code).toBe('CANCELLED');
    expect(exists(join(project, '.claude', 'skills', 'aaa-skill'))).toBe(false);

    const asked: string[] = [];
    const results = await engine.restore('project', {
      confirm: async (plan) => {
        asked.push(plan.skill.name);
        return true;
      },
    });
    expect(asked).toEqual(['warn-skill']);
    expect(results.map((r) => r.name)).toEqual(['aaa-skill', 'warn-skill']);
    expect((await engine.verify('project')).every((r) => r.ok)).toBe(true);
  });

  it('never applies --dev overrides in bulk without confirmation', async () => {
    const engine = make();
    await installDir(
      engine,
      'secret-skill',
      { files: { 'x.sh': 'READ_SECRETS\n' } },
      { dev: true },
    );
    await rm(join(project, '.claude'), { recursive: true });
    await rm(join(project, '.agents'), { recursive: true });
    expect((await catchAsync(() => engine.restore('project'))).code).toBe('POLICY_BLOCKED');
    expect((await catchAsync(() => engine.restore('project', { dev: true }))).code).toBe('USAGE');
    expect(exists(join(project, '.claude', 'skills', 'secret-skill'))).toBe(false);
    await engine.restore('project', { dev: true, confirm: async () => true });
    expect(exists(join(project, '.claude', 'skills', 'secret-skill', 'x.sh'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Findings 15 / 22: revoked and quarantined versions
// ---------------------------------------------------------------------------

describe('revoked and quarantined versions are never reinstalled', () => {
  let reg: string;

  beforeEach(async () => {
    reg = join(base, 'registry');
    await publish(reg, 'web', '1.0.0');
    await publish(reg, 'web', '1.1.0');
    const engine = make({ registry: createFileRegistry(reg) });
    await engine.apply(
      await engine.plan({
        source: { kind: 'registry', name: 'web', range: '1.0.0' },
        scope: 'project',
      }),
    );
    await engine.apply((await engine.planUpdate('web', 'project')) as InstallPlan);
  });

  const revoke = (versions: string[]) =>
    writeFile(
      join(reg, 'revocations.json'),
      JSON.stringify(versions.map((version) => ({ name: 'web', version, reason: 'leaks tokens' }))),
    );

  it('rollback refuses a revoked snapshot', async () => {
    await revoke(['1.0.0']);
    const engine = make({ registry: createFileRegistry(reg) });
    const error = await catchAsync(() => engine.rollback('web', 'project'));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('revoked: leaks tokens');
    expect((await readLockFile()).skills.web?.version).toBe('1.1.0');
  });

  it('restore refuses a revoked version even when it is cached', async () => {
    await revoke(['1.1.0']);
    await rm(join(project, '.claude'), { recursive: true });
    await rm(join(project, '.agents'), { recursive: true });
    const engine = make({ registry: createFileRegistry(reg) });
    const plans = await engine.planRestore('project');
    expect(plans[0]?.blockers.map((b) => b.code)).toEqual(['REVOKED']);
    const error = await catchAsync(() => engine.restore('project'));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('revoked');
    expect(exists(join(project, '.claude', 'skills', 'web'))).toBe(false);
  });

  it('restore and checkUpdates treat a quarantined version as unavailable', async () => {
    const real = createFileRegistry(reg);
    const quarantining: RegistrySource = {
      id: real.id,
      listVersions: async (name) =>
        (await real.listVersions(name)).map((v) =>
          v.version === '1.1.0' ? { ...v, status: 'quarantined' as const } : v,
        ),
      download: (name, version) => real.download(name, version),
    };
    await removeInstalled();
    const engine = make({ registry: quarantining });
    const error = await catchAsync(() => engine.restore('project'));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('quarantined');
    expect((await engine.checkUpdates('project'))[0]?.status).toBe('current-quarantined');
  });
});

// ---------------------------------------------------------------------------
// Findings 5 / 19: inter-process exclusion
// ---------------------------------------------------------------------------

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid as number;
}

function liveChild(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

describe('inter-process lock', () => {
  it('serializes concurrent installs so no lock entry is lost', async () => {
    const a = await makeSkill('aaa-skill');
    const b = await makeSkill('bbb-skill');
    const e1 = make();
    const e2 = make();
    const [pa, pb] = await Promise.all([
      e1.plan({ source: { kind: 'dir', path: a }, scope: 'project' }),
      e2.plan({ source: { kind: 'dir', path: b }, scope: 'project' }),
    ]);
    await Promise.all([e1.apply(pa), e2.apply(pb)]);
    expect(Object.keys((await readLockFile()).skills)).toEqual(['aaa-skill', 'bbb-skill']);
    expect(exists(join(agenthubHome, 'agenthub.pid'))).toBe(false);
  });

  it('waits for a live holder, then takes over once its process is gone', async () => {
    const child = liveChild();
    const saved = { ...lockSettings };
    try {
      await mkdir(agenthubHome, { recursive: true });
      await writeFile(
        join(agenthubHome, 'agenthub.pid'),
        JSON.stringify({
          pid: child.pid,
          host: hostname(),
          startedAt: new Date().toISOString(),
          token: 'x',
        }),
      );
      lockSettings.timeoutMs = 300;
      const dir = await makeSkill('hello-skill');
      const engine = make();
      const plan = await engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
      const error = await catchAsync(() => engine.apply(plan));
      expect(error.code).toBe('CONFLICT');
      expect(error.message).toContain('another agenthub process');
      expect(exists(join(project, '.claude', 'skills', 'hello-skill'))).toBe(false);

      await stop(child);
      await engine.apply(plan);
      expect(exists(join(project, '.claude', 'skills', 'hello-skill'))).toBe(true);
    } finally {
      Object.assign(lockSettings, saved);
      await stop(child);
    }
  });

  it('takes over a lock left by a dead process', async () => {
    await mkdir(agenthubHome, { recursive: true });
    await writeFile(
      join(agenthubHome, 'agenthub.pid'),
      JSON.stringify({
        pid: deadPid(),
        host: hostname(),
        startedAt: new Date().toISOString(),
        token: 'y',
      }),
    );
    await installDir(make(), 'hello-skill');
    expect((await readLockFile()).skills['hello-skill']).toBeDefined();
  });

  it('recover() leaves the journal of a running process alone', async () => {
    const engine = make();
    await installDir(engine, 'hello-skill', { version: '1.0.0' }, { agents: ['claude-code'] });
    const absDir = join(project, '.claude', 'skills', 'hello-skill');
    const before = await tree(absDir);
    const child = liveChild();
    try {
      const journal = crashJournal('live-0001', absDir, { pid: child.pid as number });
      await writeJournal(new WriteGuard([agenthubHome]), agenthubHome, journal);
      const messages = await engine.recover();
      expect(messages[0]).toContain('still running');
      expect(await tree(absDir)).toEqual(before);
      expect(exists(join(agenthubHome, 'journal', 'live-0001.json'))).toBe(true);
    } finally {
      await stop(child);
    }
  });
});

// ---------------------------------------------------------------------------
// Findings 6 / 21 / 8 / 12 / 13 / 18: journals and recovery
// ---------------------------------------------------------------------------

/** A journal for a v1 -> v2 swap of `absDir` in the project scope (as the engine writes it). */
function crashJournal(
  txid: string,
  absDir: string,
  extra: Partial<Journal> & { newFiles?: Record<string, string>; newDigest?: string } = {},
): Journal {
  const stagingRoot = join(project, '.agenthub', 'tmp', txid);
  const { newFiles, newDigest, ...rest } = extra;
  const files = newFiles ?? { 'SKILL.md': `sha256:${'0'.repeat(64)}` };
  return {
    txid,
    scope: 'project',
    scopeRoot: project,
    name: 'hello-skill',
    stagingRoot,
    stagingDirs: [stagingRoot],
    createdDirs: [],
    steps: [
      {
        absDir,
        backup: join(stagingRoot, 'old', '0'),
        staged: join(stagingRoot, 'new', '0'),
        swapped: true,
      },
    ],
    committed: false,
    lockFile: projectLock(),
    previousLockText: null,
    newEntry: {
      version: '2.0.0',
      digest: newDigest ?? contentDigest(files),
      source: 'dir',
      registry: null,
      installedTargets: ['claude-code'],
      paths: { '.claude/skills/hello-skill': ['claude-code'] },
      files,
      installedAt: new Date().toISOString(),
    },
    startedAt: new Date().toISOString(),
    ...rest,
  };
}

describe('crash recovery', () => {
  it('mkdirp reports only the folders it created', async () => {
    const guard = new WriteGuard([base]);
    const target = join(base, 'a', 'b', 'c');
    expect(await mkdirp(guard, target)).toEqual([target, join(base, 'a', 'b'), join(base, 'a')]);
    expect(await mkdirp(guard, target)).toEqual([]);
  });

  it('recover() accepts a journal the engine wrote itself and undoes the crash', async () => {
    const engine = make();
    await installDir(engine, 'hello-skill', { version: '1.0.0' });
    const dirs = ['.agents', '.claude'].map((d) => join(project, d, 'skills', 'hello-skill'));
    const before = await Promise.all(dirs.map((d) => tree(d)));
    const lockBefore = await readFile(projectLock(), 'utf8');

    const v2 = await makeSkill('hello-skill', { version: '2.0.0', body: '# v2\n' });
    const plan = await engine.plan({ source: { kind: 'dir', path: v2 }, scope: 'project' });
    hooks.simulateCrash = true;
    let swaps = 0;
    hooks.afterSwap = () => {
      swaps++;
      if (swaps === 2) throw new Error('simulated crash');
    };
    await expect(engine.apply(plan)).rejects.toThrow('simulated crash');
    hooks.simulateCrash = false;
    hooks.afterSwap = undefined;

    const files = await readdir(join(agenthubHome, 'journal'));
    expect(files).toHaveLength(1);
    const journal = JSON.parse(
      await readFile(join(agenthubHome, 'journal', files[0] as string), 'utf8'),
    ) as Journal;
    expect(journal.pid).toBe(process.pid);
    for (const dir of journal.createdDirs) {
      expect(dir.startsWith(project) && dir !== project, dir).toBe(true);
    }

    const messages = await make().recover();
    expect(messages).toEqual([
      'rolled back an interrupted install of hello-skill (2 folder(s) restored)',
    ]);
    expect(await Promise.all(dirs.map((d) => tree(d)))).toEqual(before);
    expect(await readFile(projectLock(), 'utf8')).toBe(lockBefore);
    expect(await readdir(join(agenthubHome, 'journal'))).toEqual([]);
    expect(exists(join(project, '.agenthub', 'tmp'))).toBe(false);
  });

  it('a failed first install keeps empty folders it did not create', async () => {
    const marked = join(base, 'marked');
    await mkdir(join(marked, '.agenthub'), { recursive: true });
    await mkdir(join(marked, '.claude', 'skills'), { recursive: true });
    const engine = make({ cwd: marked });
    expect(engine.projectRoot).toBe(marked);
    const dir = await makeSkill('hello-skill');
    const plan = await engine.plan({
      source: { kind: 'dir', path: dir },
      scope: 'project',
      agents: ['claude-code'],
    });
    hooks.afterSwap = () => {
      throw new Error('boom');
    };
    await expect(engine.apply(plan)).rejects.toThrow('boom');
    hooks.afterSwap = undefined;
    expect(exists(join(marked, '.agenthub'))).toBe(true);
    expect(exists(join(marked, '.claude', 'skills'))).toBe(true);
    expect(exists(join(marked, '.claude', 'skills', 'hello-skill'))).toBe(false);
    expect(make({ cwd: marked }).projectRoot).toBe(marked);
  });

  it('replaying a journal after its undo already ran keeps the restored copy', async () => {
    const engine = make();
    await installDir(engine, 'hello-skill', { version: '1.0.0' }, { agents: ['claude-code'] });
    const absDir = join(project, '.claude', 'skills', 'hello-skill');
    const before = await tree(absDir);
    const lockBefore = await readFile(projectLock(), 'utf8');

    // Crash after the swap: v1 parked, v2 in place.
    const v2 = await makeSkill('hello-skill', { version: '2.0.0', body: '# v2\n' });
    const v2pkg = await loadSkillFromDir(v2);
    const journal = crashJournal('replay-0001', absDir, {
      newFiles: v2pkg.fileHashes,
      previousLockText: lockBefore,
    });
    await mkdir(join(journal.stagingRoot, 'old'), { recursive: true });
    await cp(absDir, join(journal.stagingRoot, 'old', '0'), { recursive: true });
    await rm(absDir, { recursive: true });
    await cp(v2, absDir, { recursive: true });
    await writeJournal(new WriteGuard([agenthubHome]), agenthubHome, journal);
    expect(await engine.recover()).toEqual([
      'rolled back an interrupted install of hello-skill (1 folder(s) restored)',
    ]);
    expect(await tree(absDir)).toEqual(before);

    // The same journal shows up again (kept after a partial undo, restored from a backup, …).
    await writeJournal(new WriteGuard([agenthubHome]), agenthubHome, journal);
    await engine.recover();
    expect(await tree(absDir)).toEqual(before);
    expect((await engine.verify('project'))[0]?.ok).toBe(true);
  });

  it('never deletes the original when the step was journaled before the park', async () => {
    const engine = make();
    await installDir(engine, 'hello-skill', { version: '1.0.0' }, { agents: ['claude-code'] });
    const absDir = join(project, '.claude', 'skills', 'hello-skill');
    const before = await tree(absDir);
    const journal = crashJournal('prepark-0001', absDir, {
      previousLockText: await readFile(projectLock(), 'utf8'),
    });
    (journal.steps[0] as Journal['steps'][number]).swapped = false;
    // The staging folder is gone (git clean, or deleted by hand).
    await writeJournal(new WriteGuard([agenthubHome]), agenthubHome, journal);
    await engine.recover();
    expect(await tree(absDir)).toEqual(before);
  });

  it('a stale committed journal never rewrites a newer lock entry, and keeps a snapshot', async () => {
    const engine = make();
    await installDir(engine, 'hello-skill', { version: '1.0.0' }, { agents: ['claude-code'] });
    const absDir = join(project, '.claude', 'skills', 'hello-skill');
    const lockV1 = await readFile(projectLock(), 'utf8');
    const v1 = (await readLockFile()).skills['hello-skill'] as LockEntry;
    const parked = join(project, '.agenthub', 'tmp', 'done-0001', 'old', '0');
    await cp(absDir, parked, { recursive: true });
    await installDir(engine, 'hello-skill', { version: '2.0.0' }, { agents: ['claude-code'] });
    await installDir(engine, 'hello-skill', { version: '3.0.0' }, { agents: ['claude-code'] });
    await rm(join(agenthubHome, 'snapshots'), { recursive: true });
    const v2files = { ...v1.files, 'agenthub.yaml': `sha256:${'1'.repeat(64)}` };
    const journal = crashJournal('done-0001', absDir, {
      committed: true,
      previousLockText: lockV1,
      newFiles: v2files,
    });
    await writeJournal(new WriteGuard([agenthubHome]), agenthubHome, journal);
    const messages = await engine.recover();
    expect(messages.some((m) => m.includes('left as it is'))).toBe(true);
    expect((await readLockFile()).skills['hello-skill']?.version).toBe('3.0.0');
    const snapshots = await readdir(join(agenthubHome, 'snapshots'));
    const versions = await readdir(
      join(agenthubHome, 'snapshots', snapshots[0] as string, 'hello-skill'),
    );
    expect(versions).toEqual(['1.0.0']);
    expect(exists(join(project, '.agenthub', 'tmp', 'done-0001'))).toBe(false);
  });

  it('ignores the scope root a planted journal claims', async () => {
    const victim = join(base, 'victim-documents');
    await mkdir(victim);
    await writeFile(join(victim, 'thesis.txt'), 'precious');
    const guard = new WriteGuard([agenthubHome]);
    const planted = (
      txid: string,
      scope: 'project' | 'user',
      root: string,
      absDir: string,
    ): Journal => ({
      txid,
      scope,
      scopeRoot: root,
      name: 'victim-documents',
      stagingRoot: join(root, '.agenthub', 'tmp', txid),
      stagingDirs: [],
      createdDirs: [],
      steps: [{ absDir, swapped: true }],
      committed: false,
      lockFile: join(root, '.agenthub', 'agenthub.lock'),
      previousLockText: null,
      newEntry: null,
      startedAt: new Date().toISOString(),
    });
    await writeJournal(guard, agenthubHome, planted('evil-0001', 'project', base, victim));
    await writeJournal(guard, agenthubHome, planted('evil-0002', 'user', base, victim));
    await writeJournal(
      guard,
      agenthubHome,
      planted('evil-0003', 'user', home, join(home, 'Documents')),
    );
    await writeFile(
      join(agenthubHome, 'journal', 'renamed.json'),
      JSON.stringify(planted('evil-0004', 'project', project, victim)),
    );
    const messages = await make().recover();
    expect(messages).toHaveLength(4);
    for (const message of messages) expect(message).toContain('skipped journal');
    expect(await readFile(join(victim, 'thesis.txt'), 'utf8')).toBe('precious');
  });
});

// ---------------------------------------------------------------------------
// Findings 17 / 20: home as a git work tree
// ---------------------------------------------------------------------------

describe('home directory', () => {
  it('a home directory that is a git work tree is not a project', async () => {
    await mkdir(join(home, '.git'), { recursive: true });
    const notes = join(home, 'notes');
    await mkdir(notes);
    const userState = join(home, '.agenthub');
    expect(findProjectRoot(notes, { home, agenthubHome: userState })).toBeNull();
    const engine = make({ cwd: notes, agenthubHome: userState });
    expect(engine.projectRoot).toBeNull();
    expect(engine.defaultScope()).toBe('user');
    const repo = join(home, 'code', 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    expect(findProjectRoot(repo, { home, agenthubHome: userState })).toBe(repo);
    expect(() =>
      scopeStateDir('project', { projectRoot: home, home, agenthubHome: userState }),
    ).toThrow(/machine state folder/);
  });

  it('never resolves the real OS home as a project, even when home and state are overridden', async () => {
    // A folder under the real home (e.g. %TEMP%) without .git, while the real home holds
    // ~/.agenthub from earlier use and AGENTHUB_USER_HOME / AGENTHUB_HOME point elsewhere.
    const realHome = join(base, 'real-home');
    const work = join(realHome, 'AppData', 'Local', 'Temp', 'job');
    await mkdir(join(realHome, '.agenthub'), { recursive: true });
    await mkdir(work, { recursive: true });
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(realHome);
    try {
      expect(findProjectRoot(work, { home, agenthubHome: join(home, '.agenthub') })).toBeNull();
      await mkdir(join(realHome, '.git'));
      expect(findProjectRoot(work, { home, agenthubHome: join(home, '.agenthub') })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Findings 14 / 26 / 24 / 25
// ---------------------------------------------------------------------------

describe('project state and lock paths', () => {
  it('refuses a project state folder that is a link', async () => {
    const outside = join(base, 'elsewhere-state');
    await mkdir(outside);
    await symlink(outside, join(project, '.agenthub'), 'junction');
    const engine = make();
    const dir = await makeSkill('hello-skill');
    const error = await catchAsync(() =>
      engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' }),
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('symlink');
    expect((await catchAsync(() => engine.list('project'))).code).toBe('CONFLICT');
    expect(await readdir(outside)).toEqual([]);
    await rm(join(project, '.agenthub'));

    await mkdir(join(project, '.agenthub'));
    await symlink(outside, join(project, '.agenthub', 'tmp'), 'junction');
    expect(
      (
        await catchAsync(() =>
          engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' }),
        )
      ).code,
    ).toBe('CONFLICT');
    expect(await readdir(outside)).toEqual([]);
    await rm(join(project, '.agenthub', 'tmp'));
  });

  it('treats a dangling link as outside the root', async () => {
    const target = join(base, 'gone');
    await mkdir(target);
    const link = join(project, 'dangling');
    await symlink(target, link, 'junction');
    await rm(target, { recursive: true });
    expect(await resolvesWithin(project, join(link, 'x'))).toBe(false);
    await rm(link);
  });

  it('refuses lock paths in folders agenthub never writes', async () => {
    const engine = make();
    await installDir(engine, 'hello-skill');
    for (const lockPath of ['.codex/skills/hello-skill', ' .claude/skills/hello-skill']) {
      const lock = await readLockFile();
      (lock.skills['hello-skill'] as LockEntry).paths = { [lockPath]: ['cursor'] };
      await writeLockFile(lock);
      const error = await catchAsync(() => engine.restore('project'));
      expect(error.code, lockPath).toBe('VALIDATION');
    }
    expect(exists(join(project, '.codex'))).toBe(false);
    expect(exists(join(project, ' .claude'))).toBe(false);
  });

  it('OS junk files are not drift anywhere and do not block remove', async () => {
    const engine = make();
    await installDir(engine, 'hello-skill', { version: '1.0.0' });
    const claude = join(project, '.claude', 'skills', 'hello-skill');
    await writeFile(join(claude, '.DS_Store'), 'junk');
    expect((await engine.verify('project'))[0]?.ok).toBe(true);
    expect((await engine.list('project'))[0]?.status).toBe('ok');
    expect((await engine.doctor()).problems.some((p) => p.code === 'skill.drift')).toBe(false);
    const removed = await engine.remove('hello-skill', 'project');
    expect(removed.kept).toEqual([]);
    expect(exists(claude)).toBe(false);
    const plan = await engine.plan({
      source: { kind: 'dir', path: join(skills, 'hello-skill') },
      scope: 'project',
    });
    expect(plan.blockers).toEqual([]);
  });
});
