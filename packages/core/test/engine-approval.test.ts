/**
 * The capability gate in the engine (trust features §4): approvals are recorded, carried,
 * required and restored by Engine.apply itself, not only by the CLI.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_PATHS,
  duplicateAgents,
  getAdapter,
  isWritableSkillsDir,
  PATH_TABLE_VERSION,
  selectTargetFolders,
} from '@agenthub/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_IDS,
  type AgentPort,
  createEngine,
  type Engine,
  type EvaluatedFinding,
  type Finding,
  type LockEntry,
  type LockFile,
  type SecurityPort,
  serializeLock,
} from '../src/index';
import { catchErrorAsync } from './helpers';

const decoder = new TextDecoder();

/**
 * Fake scanner driven by markers: `NET:<host>` (network), `EXEC:<name>` (exec),
 * `BLOCKME` (download-exec, never declarable). The ruleset digest is switchable.
 */
function fakeSecurity(state: { ruleset: string; extraExec?: string }): SecurityPort {
  return {
    get rulesetDigest() {
      return state.ruleset;
    },
    scan(files) {
      const findings: Finding[] = [];
      for (const file of files) {
        decoder
          .decode(file.content)
          .split('\n')
          .forEach((line, index) => {
            const base = {
              file: file.path,
              line: index + 1,
              evidence: line.slice(0, 120),
              message: 'm',
            };
            for (const match of line.matchAll(/NET:([a-z.]+)/g)) {
              findings.push({
                ...base,
                ruleId: 'net.access',
                category: 'network',
                severity: 'medium',
                declarable: true,
                subject: match[1] as string,
              });
            }
            for (const match of line.matchAll(/EXEC:([a-z]+)/g)) {
              findings.push({
                ...base,
                ruleId: 'exec.shell',
                category: 'exec',
                severity: 'medium',
                declarable: true,
                subject: match[1] as string,
              });
            }
            if (state.extraExec && line.includes('EXEC:')) {
              findings.push({
                ...base,
                ruleId: 'exec.shell',
                category: 'exec',
                severity: 'medium',
                declarable: true,
                subject: state.extraExec,
              });
            }
            if (line.includes('BLOCKME')) {
              findings.push({
                ...base,
                ruleId: 'net.download-exec',
                category: 'download-exec',
                severity: 'high',
                declarable: false,
                subject: 'dl.invalid',
              });
            }
          });
      }
      return { scannerVersion: 'fake', rulesetDigest: state.ruleset, findings };
    },
    evaluate(findings, _manifest, opts) {
      const evaluated: EvaluatedFinding[] = findings.map((f) => ({
        ...f,
        declared: false,
        decision: !f.declarable ? (opts?.dev ? 'WARN' : 'BLOCK') : 'WARN',
      }));
      const outcome = evaluated.some((f) => f.decision === 'BLOCK')
        ? 'block'
        : evaluated.length > 0
          ? 'confirm'
          : 'allow';
      return { findings: evaluated, outcome };
    },
  };
}

const agents: AgentPort = {
  detect: async () =>
    AGENT_IDS.map((id) => ({
      id,
      displayName: id,
      confidence: 'high',
      evidence: [],
      status: 'verified',
    })),
  selectTargets: (scope, ids) => selectTargetFolders(scope, ids),
  duplicates: (scope, folders) => duplicateAgents(scope, folders),
  reads: (agent, scope, dir) => getAdapter(agent).reads(scope, dir),
  isWritable: (scope, dir) => isWritableSkillsDir(scope, dir),
  reloadHint: (agent) => AGENT_PATHS[agent].reloadHint,
  tableVersion: PATH_TABLE_VERSION,
};

const RULESET_A = `sha256:${'1'.repeat(64)}`;
const RULESET_B = `sha256:${'2'.repeat(64)}`;

let base: string;
let project: string;
let security: { ruleset: string; extraExec?: string };
let engine: Engine;
let clock = 0;

function makeEngine(): Engine {
  return createEngine({
    cwd: project,
    home: join(base, 'home'),
    agenthubHome: join(base, 'state'),
    agents,
    security: fakeSecurity(security),
    probe: { runtime: async () => null, command: async () => true },
    now: () => new Date(Date.UTC(2026, 9, 5, 9, 0, clock++)),
  });
}

async function skill(version: string, body: string): Promise<string> {
  const dir = join(base, 'src', version, 'web-testing');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: web-testing\ndescription: Test web apps.\n---\n# Web testing\n\n${body}\n`,
  );
  await writeFile(join(dir, 'agenthub.yaml'), `schema: 1\nversion: ${version}\n`);
  return dir;
}

const lockFile = () => join(project, '.agenthub', 'agenthub.lock');
const readLockJson = async (): Promise<LockFile> => JSON.parse(await readFile(lockFile(), 'utf8'));
const entryOf = async (): Promise<LockEntry> =>
  (await readLockJson()).skills['web-testing'] as LockEntry;

async function install(dir: string, approve?: boolean) {
  const plan = await engine.plan({
    source: { kind: 'dir', path: dir },
    scope: 'project',
    agents: ['claude-code'],
  });
  return {
    plan,
    result: await engine.apply(plan, approve ? { approve: { mode: 'flag', note: 'ok' } } : {}),
  };
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agenthub-approval-'));
  project = join(base, 'project');
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(join(base, 'home'), { recursive: true });
  security = { ruleset: RULESET_A };
  engine = makeEngine();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('capability gate in Engine.apply', () => {
  it('a fresh install records the capability block and an approval', async () => {
    await install(await skill('1.0.0', 'Uses NET:api.invalid and EXEC:node.'));
    const entry = await entryOf();
    expect(entry.capabilities?.network).toEqual(['api.invalid']);
    expect(entry.approval).toMatchObject({
      digest: entry.digest,
      capabilityDigest: entry.capabilityDigest,
      rulesetDigest: RULESET_A,
    });
    expect((await readLockJson()).lockfileVersion).toBe(2);
  });

  it('an expanding update throws APPROVAL_REQUIRED and writes nothing; an explicit approval applies it', async () => {
    await install(await skill('1.0.0', 'Uses NET:api.invalid.'));
    const before = await readFile(lockFile(), 'utf8');
    const v2 = await skill(
      '1.1.0',
      'Uses NET:api.invalid and NET:telemetry.invalid with EXEC:curl.',
    );
    const plan = await engine.plan({
      source: { kind: 'dir', path: v2 },
      scope: 'project',
      agents: ['claude-code'],
    });
    expect(plan.capabilities?.approvalRequired).toBe(true);
    expect(plan.needsConfirmation).toBe(true);
    expect(plan.capabilities?.unapproved.reasons).toEqual([
      '+exec:curl',
      '+network:telemetry.invalid',
    ]);
    const error = await catchErrorAsync(() => engine.apply(plan));
    expect(error.code).toBe('APPROVAL_REQUIRED');
    expect(error.exitCode).toBe(3);
    expect(await readFile(lockFile(), 'utf8')).toBe(before);
    expect(
      await readFile(join(project, '.claude', 'skills', 'web-testing', 'agenthub.yaml'), 'utf8'),
    ).toContain('1.0.0');

    await engine.apply(plan, { approve: { mode: 'flag', note: 'reviewed' } });
    const entry = await entryOf();
    expect(entry.version).toBe('1.1.0');
    expect(entry.approval).toMatchObject({ digest: entry.digest, note: 'reviewed' });
    const audit = await readFile(join(base, 'state', 'audit.log'), 'utf8');
    expect(audit).toContain('"approval":"flag"');
  });

  it('a non-expanding update carries the approval forward without input', async () => {
    const v1 = await install(await skill('1.0.0', 'Uses NET:api.invalid and EXEC:node.'));
    await install(await skill('1.0.1', 'Uses NET:api.invalid only (typo fixed).'));
    const entry = await entryOf();
    expect(entry.version).toBe('1.0.1');
    expect(entry.approval?.note).toBe(`carried forward from ${v1.plan.skill.digest.slice(7, 15)}`);
    expect(entry.approval?.digest).toBe(entry.digest);
  });

  it('a removed approval means an empty baseline: even a narrowing update needs approval', async () => {
    await install(await skill('1.0.0', 'Uses NET:api.invalid.'));
    const lock = await readLockJson();
    delete (lock.skills['web-testing'] as LockEntry).approval;
    await writeFile(lockFile(), serializeLock(lock));
    const plan = await engine.plan({
      source: { kind: 'dir', path: await skill('1.0.1', 'NET:api.invalid') },
      scope: 'project',
      agents: ['claude-code'],
    });
    expect(plan.capabilities?.state).toBe('unapproved');
    expect((await catchErrorAsync(() => engine.apply(plan))).code).toBe('APPROVAL_REQUIRED');
  });

  it('rollback restores the snapshot entry with its own approval and is never gated', async () => {
    await install(await skill('1.0.0', 'Uses NET:api.invalid.'));
    const first = await entryOf();
    await install(await skill('1.1.0', 'Plain text now.'));
    expect((await entryOf()).capabilities?.network).toEqual([]);
    await engine.rollback('web-testing', 'project');
    const rolled = await entryOf();
    expect(rolled.version).toBe('1.0.0');
    expect(rolled.approval).toEqual(first.approval);
    expect(rolled.capabilityDigest).toBe(first.capabilityDigest);
  });

  it('restoring the same digest never rewrites the lock, even after a ruleset change', async () => {
    await install(await skill('1.0.0', 'Uses NET:api.invalid.'));
    const before = await readFile(lockFile(), 'utf8');
    security.ruleset = RULESET_B;
    engine = makeEngine();
    await engine.restore('project', { confirm: async () => true });
    expect(await readFile(lockFile(), 'utf8')).toBe(before);
  });

  it('a ruleset change: carried when nothing new, stale (and fixed by approve) when something is', async () => {
    await install(await skill('1.0.0', 'Uses NET:api.invalid and EXEC:node.'));
    security.ruleset = RULESET_B;
    engine = makeEngine();
    let [report] = await engine.verify('project', 'web-testing');
    expect(report?.capabilities?.state).toBe('approved-carried');

    security.extraExec = 'nc';
    engine = makeEngine();
    [report] = await engine.verify('project', 'web-testing');
    expect(report?.capabilities?.state).toBe('stale');
    expect(report?.capabilities?.stale).toEqual(['exec:nc']);
    const doctor = await engine.doctor();
    expect(doctor.problems.map((p) => p.code)).toContain('approval.stale');

    const preview = await engine.approve('web-testing', 'project', {}, { dryRun: true });
    expect(preview.newlyApproved).toEqual(['exec:nc']);
    const result = await engine.approve('web-testing', 'project', { note: 'nc is fine' });
    expect(result.approval.rulesetDigest).toBe(RULESET_B);
    [report] = await engine.verify('project', 'web-testing');
    expect(report?.capabilities?.state).toBe('approved');
  });

  it('a forged capability record (digest fixed up) is a lock mismatch', async () => {
    await install(await skill('1.0.0', 'Uses NET:api.invalid.'));
    const lock = await readLockJson();
    const entry = lock.skills['web-testing'] as LockEntry;
    const { capabilityDigest, normalizeCapabilitySet } = await import('../src/index');
    entry.capabilities = {
      ...(entry.capabilities as NonNullable<LockEntry['capabilities']>),
      network: ['*'],
    };
    const digest = capabilityDigest(
      normalizeCapabilitySet({ ...entry.capabilities, externals: entry.externals ?? [] }),
    );
    entry.capabilityDigest = digest;
    (entry.approval as NonNullable<LockEntry['approval']>).capabilityDigest = digest;
    await writeFile(lockFile(), serializeLock(lock));
    const [report] = await engine.verify('project', 'web-testing');
    expect(report?.capabilities?.lockMatches).toBe(false);
    expect(report?.capabilities?.state).toBe('unapproved');
    expect((await engine.doctor()).problems.map((p) => p.code)).toContain(
      'lock.capabilities-mismatch',
    );
  });

  it('a quarantined entry blocks install, update and approve; a signer blocks digest changes', async () => {
    await install(await skill('1.0.0', 'Text.'));
    const lock = await readLockJson();
    (lock.skills['web-testing'] as LockEntry).quarantine = { reason: 'under review' };
    await writeFile(lockFile(), serializeLock(lock));
    const plan = await engine.plan({
      source: { kind: 'dir', path: await skill('1.0.1', 'Text 2.') },
      scope: 'project',
      agents: ['claude-code'],
    });
    expect(plan.blockers.map((b) => b.code)).toContain('CONFLICT');
    expect((await catchErrorAsync(() => engine.approve('web-testing', 'project'))).code).toBe(
      'POLICY_BLOCKED',
    );

    delete (lock.skills['web-testing'] as LockEntry).quarantine;
    (lock.skills['web-testing'] as LockEntry).signer = { keyId: 'k' };
    await writeFile(lockFile(), serializeLock(lock));
    const signed = await engine.plan({
      source: { kind: 'dir', path: await skill('1.0.2', 'Text 3.') },
      scope: 'project',
      agents: ['claude-code'],
    });
    expect(signed.blockers.some((b) => b.message.includes('signer'))).toBe(true);
  });

  it('--dev installs a blocked skill without an approval, and approve refuses it', async () => {
    const dir = await skill('1.0.0', 'BLOCKME');
    const plan = await engine.plan({
      source: { kind: 'dir', path: dir },
      scope: 'project',
      agents: ['claude-code'],
      dev: true,
    });
    expect(plan.capabilities?.approvable).toBe(false);
    await engine.apply(plan);
    const entry = await entryOf();
    expect(entry.capabilities?.markers).toEqual(['download-exec']);
    expect(entry.approval).toBeUndefined();
    expect((await catchErrorAsync(() => engine.approve('web-testing', 'project'))).code).toBe(
      'POLICY_BLOCKED',
    );
  });

  it('a v1 lock stays v1 on reads; approve upgrades it and leaves other entries block-less', async () => {
    await install(await skill('1.0.0', 'Uses NET:api.invalid.'));
    const v2 = await readLockJson();
    const entry = v2.skills['web-testing'] as LockEntry;
    const v1Entry = { ...entry };
    for (const key of [
      'capabilities',
      'capabilityDigest',
      'rulesetDigest',
      'externals',
      'approval',
    ] as const) {
      delete v1Entry[key];
    }
    const other = { ...v1Entry, paths: { '.claude/skills/other-skill': ['claude-code'] } };
    const v1Text = `${JSON.stringify({ lockfileVersion: 1, skills: { 'other-skill': other, 'web-testing': v1Entry } }, null, 2)}\n`;
    await writeFile(lockFile(), v1Text);
    await engine.list('project');
    await engine.verify('project');
    await engine.doctor();
    expect(await readFile(lockFile(), 'utf8')).toBe(v1Text);
    expect((await engine.doctor()).problems.map((p) => p.code)).toContain('lock.v1');

    await engine.approve('web-testing', 'project');
    const after = await readLockJson();
    expect(after.lockfileVersion).toBe(2);
    expect(after.skills['web-testing']?.approval).toBeDefined();
    expect(after.skills['other-skill']?.capabilities).toBeUndefined();
    expect(after.skills['other-skill']?.approval).toBeUndefined();
  });
});
