/**
 * Install engine integration tests (design §8, §12) against real temporary directories.
 * Agent ports come from the real adapters; the scanner and requirement probe are fakes so the
 * transaction rules are tested on their own.
 */

import { lstatSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_PATHS,
  duplicateAgents,
  getAdapter,
  PATH_TABLE_VERSION,
  selectTargetFolders,
} from '@agenthub/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/engine/fsutil';
import {
  AGENT_IDS,
  type AgentEnvironment,
  AgentHubError,
  type AgentPort,
  createEngine,
  createFileRegistry,
  type Engine,
  type EngineDeps,
  type EvaluatedFinding,
  type Finding,
  hashInstalledDir,
  type InstallPlan,
  type LockEntry,
  type LockFile,
  loadSkillFromDir,
  packSkill,
  type RegistrySource,
  retrySettings,
  type SecurityPort,
  serializeLock,
  WriteGuard,
  writeJournal,
} from '../src/index';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const decoder = new TextDecoder();

/** Fake scanner: READ_SECRETS → high/secrets (BLOCK), IGNORE_INSTRUCTIONS → medium (WARN). */
const fakeSecurity: SecurityPort = {
  scan(files) {
    const findings: Finding[] = [];
    for (const file of files) {
      decoder
        .decode(file.content)
        .split('\n')
        .forEach((line, index) => {
          if (line.includes('READ_SECRETS')) {
            findings.push({
              ruleId: 'secrets.read',
              category: 'secrets',
              severity: 'high',
              declarable: true,
              file: file.path,
              line: index + 1,
              evidence: line.slice(0, 120),
              message: 'reads credential files',
            });
          }
          if (line.includes('IGNORE_INSTRUCTIONS')) {
            findings.push({
              ruleId: 'prompt.injection',
              category: 'prompt',
              severity: 'medium',
              declarable: false,
              file: file.path,
              line: index + 1,
              evidence: line.slice(0, 120),
              message: 'suspicious prompt phrase',
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

function agentPort(detected: AgentEnvironment[] = DETECTED): AgentPort {
  return {
    detect: async () => detected,
    selectTargets: (scope, agents) => selectTargetFolders(scope, agents),
    duplicates: (scope, folders) => duplicateAgents(scope, folders),
    reads: (agent, scope, dir) => getAdapter(agent).reads(scope, dir),
    reloadHint: (agent) => AGENT_PATHS[agent].reloadHint,
    tableVersion: PATH_TABLE_VERSION,
  };
}

interface Env {
  base: string;
  home: string;
  agenthubHome: string;
  project: string;
  skills: string;
  hooks: NonNullable<EngineDeps['hooks']>;
  engine: Engine;
  make(overrides?: Partial<EngineDeps>): Engine;
}

let env: Env;

async function createEnv(): Promise<Env> {
  const base = await mkdtemp(join(tmpdir(), 'agenthub-engine-'));
  const home = join(base, 'home');
  const agenthubHome = join(base, 'state');
  const project = join(base, 'project');
  const skills = join(base, 'skills');
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(skills, { recursive: true });
  const hooks: NonNullable<EngineDeps['hooks']> = {};
  const make = (overrides: Partial<EngineDeps> = {}) =>
    createEngine({
      cwd: project,
      home,
      agenthubHome,
      agents: agentPort(),
      security: fakeSecurity,
      probe: {
        runtime: async (name) => (name === 'node' ? '24.19.0' : null),
        command: async (name) => name === 'git',
      },
      hooks,
      ...overrides,
    });
  return { base, home, agenthubHome, project, skills, hooks, engine: make(), make };
}

beforeEach(async () => {
  env = await createEnv();
});

afterEach(async () => {
  await rm(env.base, { recursive: true, force: true });
});

interface SkillSpec {
  version?: string;
  description?: string;
  body?: string;
  files?: Record<string, string>;
  manifest?: string;
}

/** Write a skill folder `<parent>/<name>` (parent defaults to the env's skills folder). */
async function makeSkill(name: string, spec: SkillSpec = {}, parent = env.skills): Promise<string> {
  const dir = join(parent, name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const description = spec.description ?? `The ${name} test skill.`;
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n${spec.body ?? '# Usage\n\nSay hello.\n'}`,
  );
  const manifest =
    spec.manifest ?? (spec.version ? `schema: 1\nversion: ${spec.version}\n` : undefined);
  if (manifest !== undefined) await writeFile(join(dir, 'agenthub.yaml'), manifest);
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    await mkdir(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...rel.split('/')), content);
  }
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Raw bytes of every file under `dir` (base64), for byte-for-byte comparisons. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (abs: string, prefix: string) => {
    for (const name of (await readdir(abs)).sort()) {
      const full = join(abs, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = lstatSync(full);
      if (st.isDirectory()) await walk(full, rel);
      else out[rel] = (await readFile(full)).toString('base64');
    }
  };
  await walk(dir, '');
  return out;
}

async function readLockFile(file: string): Promise<LockFile> {
  return JSON.parse(await readFile(file, 'utf8')) as LockFile;
}

const projectLock = () => join(env.project, '.agenthub', 'agenthub.lock');
const userLock = () => join(env.agenthubHome, 'agenthub.lock');

async function catchAsync(fn: () => Promise<unknown>): Promise<AgentHubError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AgentHubError) return error;
    throw error;
  }
  throw new Error('expected an AgentHubError');
}

async function installDir(
  name: string,
  spec: SkillSpec = {},
  req: {
    scope?: 'project' | 'user';
    force?: boolean;
    agents?: InstallPlan['agents'][number]['id'][];
  } = {},
) {
  const dir = await makeSkill(name, spec);
  const plan = await env.engine.plan({
    source: { kind: 'dir', path: dir },
    scope: req.scope ?? 'project',
    ...(req.agents ? { agents: req.agents } : {}),
    ...(req.force ? { force: true } : {}),
  });
  const result = await env.engine.apply(plan);
  return { dir, plan, result };
}

async function auditLines(): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(env.agenthubHome, 'audit.log'), 'utf8');
  return text
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

describe('install from a folder', () => {
  it('installs into every detected agent at project scope with a sorted lock', async () => {
    const { plan, result } = await installDir('hello-skill', {
      version: '1.0.0',
      files: { 'scripts/run.sh': '#!/bin/sh\necho hi\n' },
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.needsConfirmation).toBe(false);
    expect(plan.targets.map((t) => [t.lockPath, t.action])).toEqual([
      ['.agents/skills/hello-skill', 'create'],
      ['.claude/skills/hello-skill', 'create'],
    ]);
    expect(plan.duplicates).toEqual(['cursor', 'vscode']);
    expect(plan.hints.some((hint) => hint.includes('/reload-skills'))).toBe(true);
    expect(result.version).toBe('1.0.0');

    for (const dir of ['.agents/skills', '.claude/skills']) {
      const installed = join(env.project, ...dir.split('/'), 'hello-skill');
      expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toContain('name: hello-skill');
      expect(await exists(join(installed, 'scripts', 'run.sh'))).toBe(true);
    }

    const text = await readFile(projectLock(), 'utf8');
    const lock = JSON.parse(text) as LockFile;
    expect(text).toBe(serializeLock(lock));
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.startsWith('{\n  "lockfileVersion": 1,\n  "skills"')).toBe(true);
    const entry = lock.skills['hello-skill'] as LockEntry;
    expect(Object.keys(entry)).toEqual([...Object.keys(entry)].sort());
    expect(entry).toMatchObject({
      version: '1.0.0',
      digest: plan.skill.digest,
      source: 'dir',
      registry: null,
      installedTargets: ['claude-code', 'codex', 'cursor', 'vscode'],
      paths: {
        '.agents/skills/hello-skill': ['codex', 'cursor', 'vscode'],
        '.claude/skills/hello-skill': ['claude-code', 'cursor', 'vscode'],
      },
    });
    expect(Object.keys(entry.files)).toEqual(['SKILL.md', 'agenthub.yaml', 'scripts/run.sh']);

    expect(await readFile(join(env.project, '.agenthub', '.gitignore'), 'utf8')).toContain('tmp/');
    expect(await readdir(join(env.agenthubHome, 'journal'))).toEqual([]);
    expect(await exists(join(env.project, '.agenthub', 'tmp'))).toBe(false);
    const hex = plan.skill.digest.slice('sha256:'.length);
    expect(await exists(join(env.agenthubHome, 'cache', 'sha256', `${hex}.skillpkg`))).toBe(true);
    const audit = await auditLines();
    expect(audit.at(-1)).toMatchObject({ action: 'install', name: 'hello-skill', result: 'ok' });
  });

  it('reports every target unchanged on a reinstall and leaves the lock untouched', async () => {
    const { dir } = await installDir('hello-skill', { version: '1.0.0' });
    const before = await readFile(projectLock(), 'utf8');
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    expect(plan.targets.map((t) => t.action)).toEqual(['unchanged', 'unchanged']);
    expect(plan.needsConfirmation).toBe(false);
    expect(plan.previous?.version).toBe('1.0.0');
    await env.engine.apply(plan);
    expect(await readFile(projectLock(), 'utf8')).toBe(before);
  });

  it('installs at user scope with ~/ lock paths', async () => {
    const { plan } = await installDir('hello-skill', { version: '1.0.0' }, { scope: 'user' });
    expect(plan.scopeRoot).toBe(env.home);
    expect(await exists(join(env.home, '.agents', 'skills', 'hello-skill', 'SKILL.md'))).toBe(true);
    expect(await exists(join(env.home, '.claude', 'skills', 'hello-skill', 'SKILL.md'))).toBe(true);
    const lock = await readLockFile(userLock());
    expect(Object.keys(lock.skills['hello-skill']?.paths ?? {})).toEqual([
      '~/.agents/skills/hello-skill',
      '~/.claude/skills/hello-skill',
    ]);
    expect(await exists(projectLock())).toBe(false);
  });

  it('narrows targets with explicit agents', async () => {
    const { plan } = await installDir('hello-skill', {}, { agents: ['claude-code'] });
    expect(plan.targets.map((t) => t.lockPath)).toEqual(['.claude/skills/hello-skill']);
    expect(await exists(join(env.project, '.agents'))).toBe(false);
  });

  it('refuses project scope outside a project and defaults to user scope there', async () => {
    const outside = join(env.base, 'outside');
    await mkdir(outside);
    const engine = env.make({ cwd: outside });
    expect(engine.projectRoot).toBeNull();
    expect(engine.defaultScope()).toBe('user');
    const error = await catchAsync(async () => engine.scopeRoot('project'));
    expect(error.code).toBe('USAGE');
    expect(env.engine.defaultScope()).toBe('project');
  });

  it('does not mistake the machine state folder in home for a project', async () => {
    const work = join(env.home, 'notes');
    await mkdir(join(env.home, '.agenthub'), { recursive: true });
    await mkdir(work);
    const engine = env.make({ cwd: work, agenthubHome: join(env.home, '.agenthub') });
    expect(engine.projectRoot).toBeNull();
    await mkdir(join(work, '.agenthub'));
    expect(env.make({ cwd: work, agenthubHome: join(env.home, '.agenthub') }).projectRoot).toBe(
      work,
    );
  });

  it('blocks an install when no agent is detected', async () => {
    const engine = env.make({ agents: agentPort([]) });
    const dir = await makeSkill('hello-skill');
    const plan = await engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    expect(plan.blockers).toEqual([
      { code: 'INCOMPATIBLE', message: 'no supported agents detected — use --agent' },
    ]);
    expect((await catchAsync(() => engine.apply(plan))).code).toBe('INCOMPATIBLE');
  });
});

describe('policy and compatibility', () => {
  it('blocks a skill with a BLOCK finding and writes nothing', async () => {
    const dir = await makeSkill('secret-skill', {
      files: { 'scripts/x.sh': 'cat ~/.ssh/id_rsa # READ_SECRETS\n' },
    });
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    expect(plan.policy.outcome).toBe('block');
    expect(plan.blockers[0]?.code).toBe('POLICY_BLOCKED');
    expect(plan.blockers[0]?.message).toContain('secrets.read at scripts/x.sh:1');
    const error = await catchAsync(() => env.engine.apply(plan));
    expect(error.code).toBe('POLICY_BLOCKED');
    expect(error.exitCode).toBe(3);
    expect(await exists(join(env.project, '.agents'))).toBe(false);
    expect(await exists(join(env.project, '.claude'))).toBe(false);
    expect(await exists(join(env.project, '.agenthub'))).toBe(false);
  });

  it('lets --dev override a BLOCK and records it in the audit log', async () => {
    const dir = await makeSkill('secret-skill', { files: { 'scripts/x.sh': 'READ_SECRETS\n' } });
    const plan = await env.engine.plan({
      source: { kind: 'dir', path: dir },
      scope: 'project',
      dev: true,
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.needsConfirmation).toBe(true);
    await env.engine.apply(plan);
    const audit = await auditLines();
    expect(audit.map((line) => line.action)).toEqual(['override', 'install']);
    expect(audit[0]?.findings).toEqual(['secrets.read scripts/x.sh:1']);
    expect(plan.hints.some((hint) => hint.includes('secrets.read at scripts/x.sh:1'))).toBe(true);
  });

  it('asks for confirmation on WARN findings', async () => {
    const dir = await makeSkill('warn-skill', { body: 'IGNORE_INSTRUCTIONS please\n' });
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    expect(plan.policy.outcome).toBe('confirm');
    expect(plan.blockers).toEqual([]);
    expect(plan.needsConfirmation).toBe(true);
  });

  it('blocks unmet runtime and command requirements with the exact requirement', async () => {
    const dir = await makeSkill('needs-node-99', {
      manifest:
        'schema: 1\nversion: 1.0.0\nrequires:\n  runtimes: { node: ">=99" }\n  commands: [git, nosuchtool]\n  mcp: [playwright]\n',
    });
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    expect(plan.requirements).toEqual([
      { kind: 'runtime', name: 'node', constraint: '>=99', found: '24.19.0', ok: false },
      { kind: 'command', name: 'git', found: 'git', ok: true },
      { kind: 'command', name: 'nosuchtool', found: null, ok: false },
      { kind: 'mcp', name: 'playwright', ok: null },
    ]);
    expect(plan.blockers.map((b) => b.code)).toEqual(['INCOMPATIBLE', 'INCOMPATIBLE']);
    expect(plan.blockers[0]?.message).toContain('requires node >=99, found 24.19.0');
    expect(plan.blockers[1]?.message).toContain('nosuchtool');
    const error = await catchAsync(() => env.engine.apply(plan));
    expect(error.code).toBe('INCOMPATIBLE');
    expect(error.exitCode).toBe(5);
  });

  it('drops agents the skill does not target', async () => {
    const dir = await makeSkill('claude-only', {
      manifest: 'schema: 1\nversion: 1.0.0\ntargets: [claude-code]\n',
    });
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    expect(plan.targets.map((t) => t.lockPath)).toEqual(['.claude/skills/claude-only']);
    expect(plan.hints.some((hint) => hint.includes('skipping codex, cursor, vscode'))).toBe(true);
    const codexOnly = await env.engine.plan({
      source: { kind: 'dir', path: dir },
      scope: 'project',
      agents: ['codex'],
    });
    expect(codexOnly.blockers[0]?.code).toBe('INCOMPATIBLE');
  });
});

// ---------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------

describe('replace and failure handling', () => {
  it('replaces v1 with v2 and keeps a snapshot of v1', async () => {
    await installDir('hello-skill', { version: '1.0.0' });
    const v1Lock = (await readLockFile(projectLock())).skills['hello-skill'] as LockEntry;
    const dir = await makeSkill('hello-skill', { version: '2.0.0', body: '# v2\n' });
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    expect(plan.targets.map((t) => t.action)).toEqual(['replace', 'replace']);
    expect(plan.needsConfirmation).toBe(true);
    const result = await env.engine.apply(plan);
    expect(result.snapshot).toBeDefined();
    const snapshot = result.snapshot as string;
    expect(snapshot.endsWith('1.0.0')).toBe(true);
    const entry = JSON.parse(await readFile(join(snapshot, 'entry.json'), 'utf8')) as LockEntry;
    expect(entry).toEqual(v1Lock);
    expect(await readFile(join(snapshot, 'files', 'agenthub.yaml'), 'utf8')).toContain('1.0.0');
    const lock = await readLockFile(projectLock());
    expect(lock.skills['hello-skill']?.version).toBe('2.0.0');
    expect(
      await readFile(join(env.project, '.claude', 'skills', 'hello-skill', 'SKILL.md'), 'utf8'),
    ).toContain('# v2');
    expect((await auditLines()).at(-1)).toMatchObject({ action: 'update', version: '2.0.0' });
  });

  it('restores the previous version byte-for-byte when a step fails after a swap', async () => {
    await installDir('hello-skill', { version: '1.0.0', files: { 'notes.txt': 'one\r\ntwo\r\n' } });
    const agentsDir = join(env.project, '.agents', 'skills', 'hello-skill');
    const claudeDir = join(env.project, '.claude', 'skills', 'hello-skill');
    const before = { agents: await tree(agentsDir), claude: await tree(claudeDir) };
    const lockBefore = await readFile(projectLock(), 'utf8');

    const dir = await makeSkill('hello-skill', { version: '2.0.0', body: '# v2\n' });
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    let swaps = 0;
    env.hooks.afterSwap = () => {
      swaps++;
      if (swaps === 2) throw new Error('simulated failure after the second swap');
    };
    await expect(env.engine.apply(plan)).rejects.toThrow('simulated failure');
    env.hooks.afterSwap = undefined;

    expect(await tree(agentsDir)).toEqual(before.agents);
    expect(await tree(claudeDir)).toEqual(before.claude);
    expect(await readFile(projectLock(), 'utf8')).toBe(lockBefore);
    expect(await readdir(join(env.agenthubHome, 'journal'))).toEqual([]);
    expect(await exists(join(env.project, '.agenthub', 'tmp'))).toBe(false);
    expect((await auditLines()).at(-1)).toMatchObject({ action: 'update', result: 'failed' });
    expect((await env.engine.verify('project'))[0]?.ok).toBe(true);
  });

  it('leaves no trace when a first install fails', async () => {
    const dir = await makeSkill('hello-skill');
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    env.hooks.afterSwap = () => {
      throw new Error('boom');
    };
    await expect(env.engine.apply(plan)).rejects.toThrow('boom');
    env.hooks.afterSwap = undefined;
    expect(await exists(join(env.project, '.agents'))).toBe(false);
    expect(await exists(join(env.project, '.claude'))).toBe(false);
    expect(await exists(join(env.project, '.agenthub'))).toBe(false);
  });

  it('blocks on drift and overwrites with force', async () => {
    const { dir } = await installDir('hello-skill', { version: '1.0.0' });
    const installed = join(env.project, '.claude', 'skills', 'hello-skill');
    await writeFile(
      join(installed, 'SKILL.md'),
      '---\nname: hello-skill\ndescription: edited\n---\n',
    );
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    const claude = plan.targets.find((t) => t.dir === '.claude/skills');
    expect(claude?.action).toBe('replace');
    expect(claude?.drift).toEqual(['SKILL.md']);
    expect(plan.blockers.map((b) => b.code)).toEqual(['DRIFT']);
    expect((await catchAsync(() => env.engine.apply(plan))).code).toBe('DRIFT');

    const forced = await env.engine.plan({
      source: { kind: 'dir', path: dir },
      scope: 'project',
      force: true,
    });
    expect(forced.blockers).toEqual([]);
    await env.engine.apply(forced);
    expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toContain(
      'The hello-skill test skill.',
    );
    expect((await env.engine.verify('project'))[0]?.ok).toBe(true);
  });

  it('does not count OS junk files as drift', async () => {
    await installDir('hello-skill', { version: '1.0.0' });
    await writeFile(join(env.project, '.claude', 'skills', 'hello-skill', '.DS_Store'), 'junk');
    const dir = await makeSkill('hello-skill', { version: '1.0.1' });
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    expect(plan.blockers).toEqual([]);
    await env.engine.apply(plan);
    expect((await env.engine.verify('project'))[0]?.ok).toBe(true);
  });

  it('treats an existing unmanaged folder as a conflict unless forced', async () => {
    const existing = join(env.project, '.claude', 'skills', 'hello-skill');
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, 'mine.txt'), 'hand-made');
    const dir = await makeSkill('hello-skill');
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    const claude = plan.targets.find((t) => t.dir === '.claude/skills');
    expect(claude?.unmanaged).toBe(true);
    expect(plan.blockers.map((b) => b.code)).toEqual(['CONFLICT']);
    expect((await catchAsync(() => env.engine.apply(plan))).code).toBe('CONFLICT');
    expect(await exists(join(env.project, '.agents'))).toBe(false);

    const forced = await env.engine.plan({
      source: { kind: 'dir', path: dir },
      scope: 'project',
      force: true,
    });
    await env.engine.apply(forced);
    expect(await exists(join(existing, 'mine.txt'))).toBe(false);
    expect(await exists(join(existing, 'SKILL.md'))).toBe(true);
  });

  it('treats a junction at the target as unmanaged and removes only the link with force', async () => {
    const elsewhere = join(env.base, 'elsewhere', 'hello-skill');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(join(elsewhere, 'precious.txt'), 'keep me');
    await mkdir(join(env.project, '.claude', 'skills'), { recursive: true });
    const link = join(env.project, '.claude', 'skills', 'hello-skill');
    await symlink(elsewhere, link, 'junction');

    const dir = await makeSkill('hello-skill');
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    const claude = plan.targets.find((t) => t.dir === '.claude/skills');
    expect(claude?.unmanaged).toBe(true);
    expect(plan.blockers[0]?.message).toContain('symlink or junction');

    const forced = await env.engine.plan({
      source: { kind: 'dir', path: dir },
      scope: 'project',
      force: true,
    });
    await env.engine.apply(forced);
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(lstatSync(link).isDirectory()).toBe(true);
    expect(await readFile(join(elsewhere, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(await readdir(elsewhere)).toEqual(['precious.txt']);
  });

  it.runIf(process.platform === 'win32')(
    'fails with an IO error naming the path when a file stays locked, and undoes earlier swaps',
    async () => {
      await installDir('hello-skill', { version: '1.0.0' });
      const agentsDir = join(env.project, '.agents', 'skills', 'hello-skill');
      const claudeDir = join(env.project, '.claude', 'skills', 'hello-skill');
      const before = { agents: await tree(agentsDir), claude: await tree(claudeDir) };
      const lockBefore = await readFile(projectLock(), 'utf8');
      const dir = await makeSkill('hello-skill', { version: '2.0.0', body: '# v2\n' });
      const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });

      const saved = { ...retrySettings };
      retrySettings.totalMs = 200;
      const handle = await open(join(claudeDir, 'SKILL.md'), 'r');
      try {
        const error = await catchAsync(() => env.engine.apply(plan));
        expect(error.code).toBe('IO');
        expect(error.message).toContain(claudeDir);
        expect(error.message).toContain('another program may have a file open');
      } finally {
        await handle.close();
        Object.assign(retrySettings, saved);
      }
      expect(await tree(agentsDir)).toEqual(before.agents);
      expect(await tree(claudeDir)).toEqual(before.claude);
      expect(await readFile(projectLock(), 'utf8')).toBe(lockBefore);
      expect(await readdir(join(env.agenthubHome, 'journal'))).toEqual([]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'retries a locked rename until the lock is released',
    async () => {
      await installDir('hello-skill', { version: '1.0.0' });
      const claudeDir = join(env.project, '.claude', 'skills', 'hello-skill');
      const dir = await makeSkill('hello-skill', { version: '2.0.0', body: '# v2\n' });
      const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
      const handle = await open(join(claudeDir, 'SKILL.md'), 'r');
      const release = setTimeout(() => void handle.close(), 150);
      try {
        await env.engine.apply(plan);
      } finally {
        clearTimeout(release);
        await handle.close().catch(() => undefined);
      }
      expect((await readLockFile(projectLock())).skills['hello-skill']?.version).toBe('2.0.0');
    },
  );

  it('refuses a project skills folder that links outside the project, even with force', async () => {
    const outside = join(env.base, 'outside-claude');
    await mkdir(join(outside, 'skills'), { recursive: true });
    await symlink(outside, join(env.project, '.claude'), 'junction');
    const dir = await makeSkill('hello-skill');
    const plan = await env.engine.plan({
      source: { kind: 'dir', path: dir },
      scope: 'project',
      force: true,
    });
    expect(plan.blockers.map((b) => b.code)).toEqual(['CONFLICT']);
    expect(plan.blockers[0]?.message).toContain('.claude/skills/hello-skill resolves outside');
    expect((await catchAsync(() => env.engine.apply(plan))).code).toBe('CONFLICT');
    expect(await readdir(join(outside, 'skills'))).toEqual([]);
    await rm(join(env.project, '.claude'));
  });

  it('refuses to apply a plan when the disk changed after planning', async () => {
    const dir = await makeSkill('hello-skill');
    const plan = await env.engine.plan({ source: { kind: 'dir', path: dir }, scope: 'project' });
    await mkdir(join(env.project, '.claude', 'skills', 'hello-skill'), { recursive: true });
    expect((await catchAsync(() => env.engine.apply(plan))).code).toBe('CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// Remove, verify, list, restore
// ---------------------------------------------------------------------------

describe('remove, verify and restore', () => {
  it('remove keeps a modified file and reports it', async () => {
    await installDir('hello-skill', { version: '1.0.0', files: { 'docs/a.md': 'a\n' } });
    const agentsDir = join(env.project, '.agents', 'skills', 'hello-skill');
    const claudeDir = join(env.project, '.claude', 'skills', 'hello-skill');
    await writeFile(join(agentsDir, 'docs', 'a.md'), 'changed\n');

    const dry = await env.engine.remove('hello-skill', 'project', { dryRun: true });
    expect(dry.kept).toEqual(['.agents/skills/hello-skill/docs/a.md']);
    expect(await exists(join(claudeDir, 'SKILL.md'))).toBe(true);

    const result = await env.engine.remove('hello-skill', 'project');
    expect(result.kept).toEqual(['.agents/skills/hello-skill/docs/a.md']);
    expect(result.removed).toEqual(['.claude/skills/hello-skill']);
    expect(await readFile(join(agentsDir, 'docs', 'a.md'), 'utf8')).toBe('changed\n');
    expect(await exists(join(agentsDir, 'SKILL.md'))).toBe(false);
    expect(await exists(claudeDir)).toBe(false);
    expect((await readLockFile(projectLock())).skills).toEqual({});
    expect((await auditLines()).at(-1)).toMatchObject({ action: 'remove', name: 'hello-skill' });
    expect((await catchAsync(() => env.engine.remove('hello-skill', 'project'))).code).toBe(
      'NOT_FOUND',
    );
  });

  it('remove --force deletes the managed folders entirely', async () => {
    await installDir('hello-skill');
    const agentsDir = join(env.project, '.agents', 'skills', 'hello-skill');
    await writeFile(join(agentsDir, 'extra.txt'), 'extra');
    const result = await env.engine.remove('hello-skill', 'project', { force: true });
    expect(result.removed.sort()).toEqual([
      '.agents/skills/hello-skill',
      '.claude/skills/hello-skill',
    ]);
    expect(await exists(agentsDir)).toBe(false);
  });

  it('verify reports modified, missing and extra files', async () => {
    await installDir('hello-skill', {
      version: '1.0.0',
      files: { 'a.txt': 'a\n', 'b.txt': 'b\n' },
    });
    const claudeDir = join(env.project, '.claude', 'skills', 'hello-skill');
    await writeFile(join(claudeDir, 'a.txt'), 'changed\n');
    await rm(join(claudeDir, 'b.txt'));
    await writeFile(join(claudeDir, 'c.txt'), 'new\n');
    const [report] = await env.engine.verify('project');
    expect(report?.ok).toBe(false);
    const claude = report?.targets.find((t) => t.lockPath === '.claude/skills/hello-skill');
    expect(claude?.files).toEqual([
      { path: 'SKILL.md', status: 'ok' },
      { path: 'a.txt', status: 'modified' },
      { path: 'agenthub.yaml', status: 'ok' },
      { path: 'b.txt', status: 'missing' },
      { path: 'c.txt', status: 'extra' },
    ]);
    expect(report?.targets.find((t) => t.lockPath === '.agents/skills/hello-skill')?.ok).toBe(true);
    const listed = await env.engine.list('project');
    expect(listed[0]).toMatchObject({ name: 'hello-skill', status: 'drift', version: '1.0.0' });
  });

  it('a CRLF-converted installed file still verifies', async () => {
    await installDir('hello-skill', { version: '1.0.0' });
    const file = join(env.project, '.claude', 'skills', 'hello-skill', 'SKILL.md');
    const lf = await readFile(file, 'utf8');
    await writeFile(file, lf.replace(/\n/g, '\r\n'));
    expect((await env.engine.verify('project', 'hello-skill'))[0]?.ok).toBe(true);
    const listed = await env.engine.list();
    expect(listed.map((s) => [s.name, s.scope, s.status])).toEqual([
      ['hello-skill', 'project', 'ok'],
    ]);
  });

  it('restore with no changes leaves everything unchanged', async () => {
    await installDir('hello-skill', { version: '1.0.0' });
    const lockBefore = await readFile(projectLock(), 'utf8');
    const treeBefore = await tree(join(env.project, '.claude'));
    const auditBefore = (await auditLines()).length;
    const results = await env.engine.restore('project');
    expect(results.map((r) => [r.name, r.version])).toEqual([['hello-skill', '1.0.0']]);
    expect(await readFile(projectLock(), 'utf8')).toBe(lockBefore);
    expect(await tree(join(env.project, '.claude'))).toEqual(treeBefore);
    expect((await auditLines()).length).toBe(auditBefore);
  });

  it('restore recreates a deleted folder from an intact copy', async () => {
    await installDir('hello-skill', { version: '1.0.0' });
    const lockBefore = await readFile(projectLock(), 'utf8');
    await rm(join(env.project, '.claude'), { recursive: true });
    await env.engine.restore('project');
    expect(await exists(join(env.project, '.claude', 'skills', 'hello-skill', 'SKILL.md'))).toBe(
      true,
    );
    expect(await readFile(projectLock(), 'utf8')).toBe(lockBefore);
    expect((await env.engine.verify('project'))[0]?.ok).toBe(true);
  });

  it('restore falls back to the package cache', async () => {
    await installDir('hello-skill', { version: '1.0.0' });
    await rm(join(env.project, '.claude'), { recursive: true });
    await rm(join(env.project, '.agents'), { recursive: true });
    await env.engine.restore('project');
    expect((await env.engine.verify('project'))[0]?.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Registry, updates, rollback
// ---------------------------------------------------------------------------

async function publish(
  registryDir: string,
  name: string,
  version: string,
  body = `# ${version}\n`,
) {
  const dir = await makeSkill(name, { version, body }, join(env.base, 'build', version));
  const bytes = packSkill(await loadSkillFromDir(dir));
  await mkdir(registryDir, { recursive: true });
  const file = join(registryDir, `${name}-${version}.skillpkg`);
  await writeFile(file, bytes);
  return file;
}

describe('file registry', () => {
  let registryDir: string;
  let registry: RegistrySource;
  let engine: Engine;

  beforeEach(async () => {
    registryDir = join(env.base, 'registry');
    await publish(registryDir, 'web-testing', '1.0.0');
    await publish(registryDir, 'web-testing', '1.1.0');
    await publish(registryDir, 'web-testing', '2.0.0-beta.1');
    await writeFile(
      join(registryDir, 'revocations.json'),
      JSON.stringify([{ name: 'web-testing', version: '1.0.0', reason: 'leaks tokens' }]),
    );
    registry = createFileRegistry(registryDir);
    engine = env.make({ registry });
  });

  it('lists, searches and describes skills', async () => {
    expect(registry.id).toBe(`file:${registryDir}`);
    const versions = await registry.listVersions('web-testing');
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      ['2.0.0-beta.1', 'active'],
      ['1.1.0', 'active'],
      ['1.0.0', 'revoked'],
    ]);
    expect(versions[2]?.revokedReason).toBe('leaks tokens');
    const found = await registry.search?.('WEB');
    expect(found?.map((s) => [s.name, s.latestVersion])).toEqual([['web-testing', '1.1.0']]);
    expect((await registry.info?.('web-testing'))?.latest?.version).toBe('1.1.0');
    expect((await catchAsync(() => registry.listVersions('nope'))).code).toBe('NOT_FOUND');
  });

  it('chooses the highest stable version, and betas only on the beta channel', async () => {
    const stable = await engine.plan({
      source: { kind: 'registry', name: 'web-testing' },
      scope: 'project',
    });
    expect(stable.skill.version).toBe('1.1.0');
    expect(stable.source).toMatchObject({ kind: 'registry', registry: `file:${registryDir}` });
    const beta = await engine.plan({
      source: { kind: 'registry', name: 'web-testing' },
      scope: 'project',
      channel: 'beta',
    });
    expect(beta.skill.version).toBe('2.0.0-beta.1');
    const ranged = await engine.plan({
      source: { kind: 'registry', name: 'web-testing', range: '^1.0.0' },
      scope: 'project',
    });
    expect(ranged.skill.version).toBe('1.1.0');
    await engine.apply(stable);
    const entry = (await readLockFile(projectLock())).skills['web-testing'];
    expect(entry).toMatchObject({
      version: '1.1.0',
      source: 'registry',
      registry: `file:${registryDir}`,
    });
  });

  it('blocks an exact pin to a revoked version', async () => {
    const plan = await engine.plan({
      source: { kind: 'registry', name: 'web-testing', range: '1.0.0' },
      scope: 'project',
    });
    expect(plan.blockers).toEqual([
      { code: 'REVOKED', message: 'version 1.0.0 of web-testing is revoked: leaks tokens' },
    ]);
    const error = await catchAsync(() => engine.apply(plan));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('is revoked');
    expect(await exists(join(env.project, '.agenthub'))).toBe(false);
  });

  it('rejects a tampered archive with INTEGRITY', async () => {
    await registry.listVersions('web-testing');
    const file = join(registryDir, 'web-testing-1.1.0.skillpkg');
    const bytes = await readFile(file);
    const other = await readFile(join(registryDir, 'web-testing-2.0.0-beta.1.skillpkg'));
    expect(bytes.equals(other)).toBe(false);
    await writeFile(file, other);
    const error = await catchAsync(() =>
      engine.plan({ source: { kind: 'registry', name: 'web-testing' }, scope: 'project' }),
    );
    expect(error.code).toBe('INTEGRITY');
    expect(error.exitCode).toBe(4);
  });

  it('rejects a registry that serves bytes different from the advertised digest', async () => {
    const lying: RegistrySource = {
      id: 'file:lying',
      listVersions: (name) => registry.listVersions(name),
      download: async (name) => {
        const real = await registry.download(name, '2.0.0-beta.1');
        return { bytes: real.bytes, archiveDigest: real.archiveDigest };
      },
    };
    const error = await catchAsync(() =>
      env
        .make({ registry: lying })
        .plan({ source: { kind: 'registry', name: 'web-testing' }, scope: 'project' }),
    );
    expect(error.code).toBe('INTEGRITY');
  });

  it('checks for updates, plans and applies an update, then rolls back', async () => {
    await publish(registryDir, 'web-testing', '0.9.0');
    registry = createFileRegistry(registryDir);
    engine = env.make({ registry });
    const first = await engine.plan({
      source: { kind: 'registry', name: 'web-testing', range: '0.9.0' },
      scope: 'project',
    });
    await engine.apply(first);
    const v09 = (await readLockFile(projectLock())).skills['web-testing'] as LockEntry;

    const checks = await engine.checkUpdates('project');
    expect(checks).toEqual([
      {
        name: 'web-testing',
        scope: 'project',
        current: '0.9.0',
        latest: '1.1.0',
        latestCompatible: '1.1.0',
        status: 'available',
      },
    ]);
    const update = await engine.planUpdate('web-testing', 'project');
    expect(update?.skill.version).toBe('1.1.0');
    expect(update?.targets.map((t) => t.action)).toEqual(['replace', 'replace']);
    const result = await engine.apply(update as InstallPlan);
    expect(result.snapshot).toBeDefined();
    expect((await readLockFile(projectLock())).skills['web-testing']?.version).toBe('1.1.0');
    expect(await engine.planUpdate('web-testing', 'project')).toBeNull();
    expect((await engine.checkUpdates('project'))[0]?.status).toBe('up-to-date');

    const rolled = await engine.rollback('web-testing', 'project');
    expect(rolled.version).toBe('0.9.0');
    const after = (await readLockFile(projectLock())).skills['web-testing'] as LockEntry;
    const { installedAt: _a, ...restAfter } = after;
    const { installedAt: _b, ...restBefore } = v09;
    expect(restAfter).toEqual(restBefore);
    expect((await engine.verify('project'))[0]?.ok).toBe(true);
    expect((await auditLines()).at(-1)).toMatchObject({ action: 'rollback', version: '0.9.0' });
    // The replaced 1.1.0 is now the snapshot, so a second rollback goes forward again.
    const snapshots = await readdir(join(env.agenthubHome, 'snapshots'));
    expect(snapshots).toHaveLength(1);
    const versions = await readdir(
      join(env.agenthubHome, 'snapshots', snapshots[0] as string, 'web-testing'),
    );
    expect(versions).toEqual(['1.1.0']);
  });

  it('reports a revoked current version', async () => {
    const pinned = join(env.base, 'pinned');
    await mkdir(pinned);
    await publish(pinned, 'web-testing', '1.0.0');
    const pinnedEngine = env.make({ registry: createFileRegistry(pinned) });
    await pinnedEngine.apply(
      await pinnedEngine.plan({
        source: { kind: 'registry', name: 'web-testing' },
        scope: 'project',
      }),
    );
    const checks = await engine.checkUpdates('project', ['web-testing']);
    expect(checks[0]).toMatchObject({ status: 'current-revoked', latestCompatible: '1.1.0' });
    expect(checks[0]?.reason).toContain('leaks tokens');
  });

  it('rollback without a snapshot is NOT_FOUND', async () => {
    expect((await catchAsync(() => engine.rollback('web-testing', 'project'))).code).toBe(
      'NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// Recovery, guard, doctor
// ---------------------------------------------------------------------------

describe('crash recovery', () => {
  it('recover() undoes an uncommitted transaction from its journal', async () => {
    await installDir('hello-skill', { version: '1.0.0' });
    const absDir = join(env.project, '.claude', 'skills', 'hello-skill');
    const before = await tree(absDir);
    const lockBefore = await readFile(projectLock(), 'utf8');

    // Simulate a crash right after the swap: v1 parked in old/, v2 in place, lock not written.
    const txid = 'crash-0001';
    const stagingRoot = join(env.project, '.agenthub', 'tmp', txid);
    const backup = join(stagingRoot, 'old', '0');
    await mkdir(join(stagingRoot, 'old'), { recursive: true });
    await rename(absDir, backup);
    const v2 = await makeSkill('hello-skill', { version: '2.0.0', body: '# v2\n' });
    await mkdir(join(env.base, 'moved'), { recursive: true });
    await rename(v2, absDir);
    const guard = new WriteGuard([env.agenthubHome]);
    await writeJournal(guard, env.agenthubHome, {
      txid,
      scope: 'project',
      scopeRoot: env.project,
      name: 'hello-skill',
      stagingRoot,
      stagingDirs: [stagingRoot],
      createdDirs: [],
      steps: [{ absDir, backup, staged: join(stagingRoot, 'new', '0'), swapped: true }],
      committed: false,
      lockFile: projectLock(),
      previousLockText: lockBefore,
      newEntry: null,
      startedAt: new Date().toISOString(),
    });

    const doctor = await env.engine.doctor();
    expect(doctor.pendingJournals).toHaveLength(1);
    expect(doctor.problems.some((p) => p.code === 'journal.pending')).toBe(true);

    const messages = await env.engine.recover();
    expect(messages).toEqual([
      'rolled back an interrupted install of hello-skill (1 folder(s) restored)',
    ]);
    expect(await tree(absDir)).toEqual(before);
    expect(await readFile(projectLock(), 'utf8')).toBe(lockBefore);
    expect(await exists(stagingRoot)).toBe(false);
    expect(await readdir(join(env.agenthubHome, 'journal'))).toEqual([]);
    expect(await env.engine.recover()).toEqual([]);
  });

  it('recover() restores a crash between parking the old folder and moving the new one in', async () => {
    await installDir('hello-skill', { version: '1.0.0' });
    const absDir = join(env.project, '.agents', 'skills', 'hello-skill');
    const before = await tree(absDir);
    const txid = 'crash-0002';
    const stagingRoot = join(env.project, '.agenthub', 'tmp', txid);
    const staged = join(stagingRoot, 'new', '0');
    const backup = join(stagingRoot, 'old', '0');
    await mkdir(join(stagingRoot, 'old'), { recursive: true });
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, 'SKILL.md'), 'staged');
    await rename(absDir, backup);
    await writeJournal(new WriteGuard([env.agenthubHome]), env.agenthubHome, {
      txid,
      scope: 'project',
      scopeRoot: env.project,
      name: 'hello-skill',
      stagingRoot,
      stagingDirs: [stagingRoot],
      createdDirs: [],
      steps: [{ absDir, backup, staged, swapped: false }],
      committed: false,
      lockFile: projectLock(),
      previousLockText: await readFile(projectLock(), 'utf8'),
      newEntry: null,
      startedAt: new Date().toISOString(),
    });
    await env.engine.recover();
    expect(await tree(absDir)).toEqual(before);
    expect(await exists(stagingRoot)).toBe(false);
  });

  it('recover() finishes the cleanup of a committed transaction', async () => {
    await installDir('hello-skill', { version: '1.0.0' });
    const txid = 'crash-0003';
    const stagingRoot = join(env.project, '.agenthub', 'tmp', txid);
    await mkdir(join(stagingRoot, 'old', '0'), { recursive: true });
    const entry = (await readLockFile(projectLock())).skills['hello-skill'] as LockEntry;
    await writeJournal(new WriteGuard([env.agenthubHome]), env.agenthubHome, {
      txid,
      scope: 'project',
      scopeRoot: env.project,
      name: 'hello-skill',
      stagingRoot,
      stagingDirs: [stagingRoot],
      createdDirs: [],
      steps: [{ absDir: join(env.project, '.agents', 'skills', 'hello-skill'), swapped: true }],
      committed: true,
      lockFile: projectLock(),
      previousLockText: null,
      newEntry: entry,
      startedAt: new Date().toISOString(),
    });
    expect(await env.engine.recover()).toEqual(['finished an interrupted install of hello-skill']);
    expect(await exists(stagingRoot)).toBe(false);
    expect((await env.engine.verify('project'))[0]?.ok).toBe(true);
  });

  it('recover() refuses a journal that points outside the scope', async () => {
    await writeJournal(new WriteGuard([env.agenthubHome]), env.agenthubHome, {
      txid: 'evil-0001',
      scope: 'project',
      scopeRoot: env.project,
      name: 'hello-skill',
      stagingRoot: join(env.project, '.agenthub', 'tmp', 'evil-0001'),
      stagingDirs: [join(env.project, '.agenthub', 'tmp', 'evil-0001')],
      createdDirs: [],
      steps: [{ absDir: join(env.base, 'victim'), swapped: true }],
      committed: false,
      lockFile: projectLock(),
      previousLockText: null,
      newEntry: null,
      startedAt: new Date().toISOString(),
    });
    await mkdir(join(env.base, 'victim'));
    const messages = await env.engine.recover();
    expect(messages[0]).toContain('skipped journal');
    expect(await exists(join(env.base, 'victim'))).toBe(true);
  });
});

describe('write guard', () => {
  it('rejects writes outside the allowed roots', async () => {
    const guard = new WriteGuard([join(env.project, '.agenthub')]);
    const outside = join(env.project, 'src', 'file.txt');
    expect(() => guard.assertAllowed(outside)).toThrow('refusing to write outside allowed targets');
    const error = await catchAsync(() => writeFileAtomic(guard, outside, 'x'));
    expect(error.code).toBe('INTERNAL');
    expect(await exists(outside)).toBe(false);
    expect(() => guard.assertAllowed(join(env.project, '.agenthub', '..', 'x'))).toThrow();
    expect(() => guard.assertAllowed(join(env.project, '.agenthub-evil', 'x'))).toThrow();
    expect(() => guard.assertAllowed(join(env.project, '.agenthub', 'tmp', 'x'))).not.toThrow();
  });

  it('refuses lock paths that leave the skills folders', async () => {
    await installDir('hello-skill');
    const lock = await readLockFile(projectLock());
    const entry = lock.skills['hello-skill'] as LockEntry;
    entry.paths = { '../outside/hello-skill': ['claude-code'] };
    await writeFile(projectLock(), serializeLock(lock));
    const error = await catchAsync(() =>
      env.engine.remove('hello-skill', 'project', { force: true }),
    );
    expect(error.code).toBe('VALIDATION');
    entry.paths = { 'src/hello-skill': ['claude-code'] };
    await writeFile(projectLock(), serializeLock(lock));
    expect((await catchAsync(() => env.engine.verify('project'))).code).toBe('VALIDATION');
  });

  it('rejects an invalid lock file with VALIDATION naming the file', async () => {
    await mkdir(join(env.project, '.agenthub'), { recursive: true });
    await writeFile(projectLock(), '{ "lockfileVersion": 2, "skills": {} }');
    const error = await catchAsync(() => env.engine.list('project'));
    expect(error.code).toBe('VALIDATION');
    expect(error.message).toContain('agenthub.lock');
  });
});

describe('hashing and doctor', () => {
  it('hashInstalledDir normalizes CRLF and reports links', async () => {
    const dir = join(env.base, 'hashme');
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'x\r\ny\r\n');
    await writeFile(join(dir, 'b.txt'), 'x\ny\n');
    await symlink(join(env.base, 'skills'), join(dir, 'sub', 'link'), 'junction');
    const hashes = await hashInstalledDir(dir);
    expect(hashes['a.txt']).toBe(hashes['b.txt']);
    expect(hashes['sub/link']).toBe('unsafe:symlink');
  });

  it('doctor reports duplicates, drift, scope conflicts and leftovers', async () => {
    await installDir('hello-skill', { version: '1.0.0' });
    await installDir('hello-skill', { version: '1.0.1' }, { scope: 'user' });
    await writeFile(join(env.project, '.claude', 'skills', 'hello-skill', 'extra.md'), 'x');
    await mkdir(join(env.project, '.agenthub', 'tmp', 'stale'), { recursive: true });
    const report = await env.engine.doctor();
    expect(report.pathTableVersion).toBe(PATH_TABLE_VERSION);
    expect(report.scopes.map((s) => [s.scope, s.lockExists, s.skills])).toEqual([
      ['project', true, 1],
      ['user', true, 1],
    ]);
    const codes = report.problems.map((p) => p.code);
    expect(codes).toContain('skill.drift');
    expect(codes).toContain('skill.duplicate');
    expect(codes).toContain('skill.scope-conflict');
    expect(codes).toContain('tmp.leftover');
    expect(report.cacheBytes).toBeGreaterThan(0);
    expect((await stat(join(env.agenthubHome, 'cache'))).isDirectory()).toBe(true);
  });

  it('doctor reports unmet requirements of installed skills', async () => {
    await installDir('needs-git', {
      manifest: 'schema: 1\nversion: 1.0.0\nrequires:\n  commands: [git]\n',
    });
    const engine = env.make({ probe: { runtime: async () => null, command: async () => false } });
    const report = await engine.doctor();
    expect(report.problems.find((p) => p.code === 'requirement.unmet')?.message).toContain('"git"');
  });
});
