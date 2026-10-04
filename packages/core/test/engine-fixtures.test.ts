/**
 * Install engine against the shared fixture skills with the real scanner and adapters
 * (design §9 fixture table, handoff security tests §8).
 */
import { lstatSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_PATHS,
  duplicateAgents,
  getAdapter,
  PATH_TABLE_VERSION,
  selectTargetFolders,
} from '@agenthub/adapters';
import { evaluatePolicy, scanPackage } from '@agenthub/scanner';
import { fixturePath } from '@agenthub/test-fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  type AgentEnvironment,
  AgentHubError,
  createEngine,
  type Engine,
  type LockFile,
} from '../src/index';

let base: string;
let project: string;
let engine: Engine;

const DETECTED: AgentEnvironment[] = AGENT_IDS.map((id) => ({
  id,
  displayName: id,
  confidence: 'high',
  evidence: ['test'],
  status: 'verified',
}));

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agenthub-engine-fixtures-'));
  project = join(base, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(join(base, 'home'), { recursive: true });
  engine = createEngine({
    cwd: project,
    home: join(base, 'home'),
    agenthubHome: join(base, 'state'),
    agents: {
      detect: async () => DETECTED,
      selectTargets: (scope, agents) => selectTargetFolders(scope, agents),
      duplicates: (scope, folders) => duplicateAgents(scope, folders),
      reads: (agent, scope, dir) => getAdapter(agent).reads(scope, dir),
      reloadHint: (agent) => AGENT_PATHS[agent].reloadHint,
      tableVersion: PATH_TABLE_VERSION,
    },
    security: {
      scan: (files) => scanPackage(files),
      evaluate: (findings, manifest, opts) => evaluatePolicy(findings, manifest, opts),
    },
    probe: {
      runtime: async (name) => ({ node: '24.19.0', python: '3.12.4' })[name] ?? null,
      command: async () => true,
    },
  });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
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

const planFixture = (name: string) =>
  engine.plan({ source: { kind: 'dir', path: fixturePath(name) }, scope: 'project' });

describe('fixture skills through the engine', () => {
  it.each(['hello-skill', 'web-testing', 'complex-benign'])('installs %s', async (name) => {
    const plan = await planFixture(name);
    expect(plan.blockers).toEqual([]);
    expect(plan.policy.outcome).toBe('allow');
    const result = await engine.apply(plan);
    expect(result.name).toBe(name);
    expect(plan.targets.length).toBeGreaterThan(0);
    for (const target of plan.targets) expect(exists(join(target.absDir, 'SKILL.md'))).toBe(true);
    const lock = JSON.parse(
      await readFile(join(project, '.agenthub', 'agenthub.lock'), 'utf8'),
    ) as LockFile;
    expect(lock.skills[name]?.digest).toBe(plan.skill.digest);
    expect((await engine.verify('project', name))[0]?.ok).toBe(true);
  });

  it.each(['secret-reader', 'download-exec', 'obfuscated', 'hidden-unicode', 'persistence'])(
    'blocks %s and writes nothing',
    async (name) => {
      const plan = await planFixture(name);
      expect(plan.policy.outcome).toBe('block');
      expect(plan.blockers.map((b) => b.code)).toContain('POLICY_BLOCKED');
      const error = await catchAsync(() => engine.apply(plan));
      expect(error.code).toBe('POLICY_BLOCKED');
      expect(exists(join(project, '.agents'))).toBe(false);
      expect(exists(join(project, '.claude'))).toBe(false);
      expect(exists(join(project, '.agenthub'))).toBe(false);
    },
  );

  it('asks for confirmation for prompt-injection', async () => {
    const plan = await planFixture('prompt-injection');
    expect(plan.policy.outcome).toBe('confirm');
    expect(plan.blockers).toEqual([]);
    expect(plan.needsConfirmation).toBe(true);
  });

  it('reports needs-node-99 as incompatible with the exact requirement', async () => {
    const plan = await planFixture('needs-node-99');
    const blocker = plan.blockers.find((b) => b.code === 'INCOMPATIBLE');
    expect(blocker?.message).toMatch(/requires node >=\s*99.*found 24\.19\.0/);
    const error = await catchAsync(() => engine.apply(plan));
    expect(error.code).toBe('INCOMPATIBLE');
    expect(error.exitCode).toBe(5);
  });
});
