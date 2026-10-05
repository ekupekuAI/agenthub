/**
 * The install engine (design §8): plan → apply as one transaction over every target folder,
 * plus restore, remove, verify, list, update checks, rollback, crash recovery and doctor.
 */
import fs from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import semver from 'semver';
import { packSkill, readSkillArchive } from '../archive';
import {
  CAPABILITY_SCHEMA,
  deriveCapabilities,
  diffCapabilities,
  expansionTokens,
  summarizeFileChanges,
  tokensOf,
} from '../capabilities';
import { AgentHubError, isAgentHubError } from '../errors';
import { archiveDigest, sha256Hex } from '../hash';
import { MANIFEST_FILE, parseManifest } from '../manifest';
import { buildSkillPackage, loadSkillFromDir, type RawFile, SKILL_FILE } from '../package';
import { parseSkillMd } from '../skillmd';
import {
  AGENT_IDS,
  type AgentEnvironment,
  type AgentId,
  type CapabilityReport,
  type LockApproval,
  type LockEntry,
  type LockFile,
  type PolicyResult,
  type Scope,
  type SkillManifest,
  type SkillPackage,
  type TargetFolder,
} from '../types';
import type {
  ApprovalInput,
  ApproveResult,
  DoctorProblem,
  DoctorReport,
  Engine,
  EngineDeps,
  InstallPlan,
  InstallRequest,
  InstallResult,
  ListedSkill,
  PlanCapabilities,
  PlannedTarget,
  RegistrySource,
  RegistryVersion,
  RemoveResult,
  RequirementCheck,
  RestoreOptions,
  SkillDiff,
  UpdateCandidate,
  VerifyReport,
} from './api';
import {
  type ApprovalStatus,
  approvalState,
  approvedBaseline,
  recordedApproval,
  recordedSet,
} from './approval';
import { type LoadedConfig, loadConfig, sameRegistry } from './config';
import { createFileRegistry } from './file-registry';
import * as fsu from './fsutil';
import { WriteGuard } from './fsutil';
import {
  deleteJournal,
  type Journal,
  type JournalStep,
  journalFile,
  newTxid,
  readJournals,
  writeJournal,
} from './journal';
import {
  emptyLock,
  parseLock,
  parseLockEntry,
  peekLockVersion,
  readLock,
  serializeLock,
  sortKeysDeep,
  writeLock,
} from './lock';
import { acquireProcessLock, ownerAlive } from './proclock';
import { latestVersion, resolveVersion } from './resolve';
import {
  assertProjectStateSafe,
  ensureStateGitignore,
  findProjectRoot,
  LOCK_FILE,
  lockFilePath,
  STATE_DIR,
  type StateLocations,
  scopeId,
  scopeStateDir,
  scopeTmpDir,
} from './state';

const DISPLAY_NAMES: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code + GitHub Copilot',
};

type AuditAction = 'install' | 'update' | 'rollback' | 'remove' | 'override' | 'approve' | 'adopt';

interface PlanInternals {
  pkg: SkillPackage;
  action: 'install' | 'update' | 'rollback';
  lockSource: LockEntry['source'];
  registry: string | null;
  /** Rollback: the snapshot's own entry, written back with its approval. */
  carry?: LockEntry;
}

/** The capability fields of an entry (block, approval, provenance and reserved fields). */
const CARRIED_FIELDS = [
  'capabilities',
  'capabilityDigest',
  'rulesetDigest',
  'externals',
  'approval',
  'signer',
  'quarantine',
] as const satisfies readonly (keyof LockEntry)[];

function carriedFields(entry: LockEntry): Partial<LockEntry> {
  const out: Partial<LockEntry> = {};
  for (const key of CARRIED_FIELDS) {
    if (entry[key] !== undefined) (out as Record<string, unknown>)[key] = entry[key];
  }
  return out;
}

/** The lock's capability block for a report. */
function capabilityBlock(report: CapabilityReport): Partial<LockEntry> {
  return {
    capabilities: tokensOf(report.set),
    capabilityDigest: report.digest,
    rulesetDigest: report.rulesetDigest,
    externals: report.set.externals,
  };
}

function quarantineText(entry: LockEntry): string {
  const reason = entry.quarantine?.reason;
  return reason === undefined ? '' : ` (${reason})`;
}

/** Package text of SKILL.md, for the line-count summary. */
function skillMdText(pkg: SkillPackage): string {
  const file = pkg.files.find((f) => f.path === SKILL_FILE);
  return file === undefined ? '' : new TextDecoder().decode(file.content);
}

/** Packages behind plans made by this module, so apply() never re-reads the source. */
const INTERNALS = new WeakMap<InstallPlan, PlanInternals>();

interface BuildPlanInput {
  pkg: SkillPackage;
  source: InstallPlan['source'];
  lockSource: LockEntry['source'];
  registry: string | null;
  scope: Scope;
  /** Selected agents (ignored when fixedTargets is given). */
  agents: AgentEnvironment[];
  detected: AgentEnvironment[];
  /** Fixed folders (restore / rollback) instead of choosing folders from agents. */
  fixedTargets?: TargetFolder[];
  dev: boolean;
  force: boolean;
  action?: 'rollback';
  archiveDigest?: string;
  hints?: string[];
  /** Blockers found before planning (registry checks of restore / rollback). */
  blockers?: Blocker[];
  /** Rollback: the snapshot's entry, carried verbatim (with its own approval). */
  carry?: LockEntry;
}

/** A rescan of what is installed for one lock entry. */
/** Everything known about one installed entry after a rescan (verify, doctor, approve). */
interface InstalledInspection {
  name: string;
  scope: Scope;
  entry: LockEntry;
  verify: VerifyReport;
  current: CapabilityReport | null;
  policy: PolicyResult | null;
  approval: ApprovalStatus;
}

interface InstalledScan {
  pkg: SkillPackage;
  report: CapabilityReport;
  strict: PolicyResult;
}

interface TargetState {
  action: PlannedTarget['action'];
  drift?: string[];
  unmanaged?: boolean;
  link?: boolean;
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function sortAgents(ids: Iterable<AgentId>): AgentId[] {
  const set = new Set(ids);
  return AGENT_IDS.filter((id) => set.has(id));
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function entryKey(entry: LockEntry | undefined): string {
  if (entry === undefined) return '';
  const { installedAt: _ignored, ...rest } = entry;
  return JSON.stringify(sortKeysDeep(rest));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withVersion(pkg: SkillPackage, version: string): SkillPackage {
  return pkg.version === version ? pkg : { ...pkg, version };
}

function describeRequirement(skill: string, check: RequirementCheck): string {
  if (check.kind === 'runtime') {
    const found = check.found ? `found ${check.found}` : `${check.name} was not found`;
    return `${skill} requires ${check.name} ${check.constraint ?? ''}, ${found}`.replace(/ ,/, ',');
  }
  if (check.kind === 'command') return `${skill} requires the command "${check.name}" on PATH`;
  return `${skill} uses the MCP server "${check.name}"`;
}

function describeBlock(policy: PolicyResult): string {
  const blocked = policy.findings.filter((f) => f.decision === 'BLOCK');
  const list = blocked.map((f) => `${f.ruleId} at ${f.file}:${f.line}`).join(', ');
  return `blocked by policy: ${list}`;
}

/** Why a plan needs confirmation, for messages. */
function describeConfirmation(plan: InstallPlan): string {
  const reasons: string[] = [];
  const warns = plan.policy.findings.filter((f) => f.decision === 'WARN').map((f) => f.ruleId);
  if (warns.length > 0) reasons.push(`findings to review: ${[...new Set(warns)].join(', ')}`);
  else if (plan.policy.outcome !== 'allow') reasons.push(`policy outcome ${plan.policy.outcome}`);
  if (plan.dev && plan.hints.some((hint) => hint.startsWith('--dev:'))) {
    reasons.push('--dev overrides BLOCK findings');
  }
  const replaced = plan.targets.filter((t) => t.action === 'replace').map((t) => t.lockPath);
  if (replaced.length > 0) reasons.push(`replaces ${replaced.join(', ')}`);
  return reasons.join('; ') || 'confirmation required';
}

const BLOCKER_CODES = {
  POLICY_BLOCKED: 'POLICY_BLOCKED',
  INCOMPATIBLE: 'INCOMPATIBLE',
  DRIFT: 'DRIFT',
  CONFLICT: 'CONFLICT',
  REVOKED: 'CONFLICT',
} as const;

function blockerError(plan: InstallPlan): AgentHubError | null {
  const first = plan.blockers[0];
  if (first === undefined) return null;
  return new AgentHubError(BLOCKER_CODES[first.code], first.message, {
    blockers: plan.blockers,
    findings: plan.policy.findings.filter((f) => f.decision === 'BLOCK'),
  });
}

type Blocker = InstallPlan['blockers'][number];

/**
 * Same version by semver precedence for valid versions (so a lock label such as `1.3.0+x` or
 * `v1.3.0` still matches the registry's 1.3.0 and its status), else exact text.
 */
function sameVersion(a: string, b: string): boolean {
  if (semver.valid(a) !== null && semver.valid(b) !== null) return semver.eq(a, b);
  return a === b;
}

/** Hashes of an installed folder with OS junk files (.DS_Store, …) left out. */
async function hashSkillDir(absDir: string, keep: Record<string, string> = {}) {
  return fsu.withoutJunk(await fsu.hashInstalledDir(absDir), keep);
}

function isSafeVersionName(version: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) && !version.endsWith('.');
}

class InstallEngine implements Engine {
  readonly projectRoot: string | null;
  private readonly deps: EngineDeps;
  private readonly now: () => Date;
  private fileRegistry: { id: string; source: RegistrySource } | null = null;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.projectRoot = findProjectRoot(deps.cwd, {
      home: deps.home,
      agenthubHome: deps.agenthubHome,
    });
  }

  // -------------------------------------------------------------------------
  // Scopes and locations
  // -------------------------------------------------------------------------

  private get loc(): StateLocations {
    return {
      projectRoot: this.projectRoot,
      home: this.deps.home,
      agenthubHome: this.deps.agenthubHome,
    };
  }

  defaultScope(): Scope {
    return this.projectRoot === null ? 'user' : 'project';
  }

  scopeRoot(scope: Scope): string {
    if (scope === 'user') return this.deps.home;
    if (this.projectRoot === null) {
      throw new AgentHubError('USAGE', 'not inside a project — use -g for a user-wide install');
    }
    return this.projectRoot;
  }

  /** Scope state folder; for project scope it is checked for links first (it is committed). */
  private stateDir(scope: Scope): string {
    const root = this.scopeRoot(scope);
    const dir = scopeStateDir(scope, this.loc);
    if (scope === 'project') assertProjectStateSafe(root);
    return dir;
  }

  private lockFile(scope: Scope): string {
    this.stateDir(scope);
    return lockFilePath(scope, this.loc);
  }

  /** Run `fn` holding the machine-wide process lock (one changing agenthub at a time). */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquireProcessLock(this.deps.agenthubHome, { now: this.now });
    try {
      return await fn();
    } finally {
      await release?.().catch(() => undefined);
    }
  }

  private scopes(): Scope[] {
    return this.projectRoot === null ? ['user'] : ['project', 'user'];
  }

  private lockPathFor(scope: Scope, dir: string, name: string): string {
    return scope === 'user' ? `~/${dir}/${name}` : `${dir}/${name}`;
  }

  /**
   * Turn a lock `paths` key into a skills folder and absolute path, refusing anything that is
   * not `<skills folder an agent reads>/<name>` inside the scope root (a lock is committed to
   * git, so it is untrusted input).
   */
  private resolveLockPath(
    scope: Scope,
    lockPath: string,
    name: string,
  ): { dir: string; absDir: string } {
    return this.checkLockPath(scope, this.scopeRoot(scope), lockPath, name);
  }

  /** Whether agenthub may write skills into `dir` at `scope` (AgentPort.isWritable). */
  private isWritable(scope: Scope, dir: string): boolean {
    const port = this.deps.agents;
    return port.isWritable === undefined || port.isWritable(scope, dir);
  }

  /** resolveLockPath against an explicit scope root (journals of other projects). */
  private checkLockPath(
    scope: Scope,
    root: string,
    lockPath: string,
    name: string,
  ): { dir: string; absDir: string } {
    const fail = (why: string): never => {
      throw new AgentHubError('VALIDATION', `invalid lock path "${lockPath}" for ${name}: ${why}`, {
        lockPath,
      });
    };
    let rel = lockPath;
    if (scope === 'user') {
      if (!rel.startsWith('~/')) fail('user-scope paths must start with ~/');
      rel = rel.slice(2);
    } else if (rel.startsWith('~/')) {
      fail('project-scope paths must be relative to the project root');
    }
    const segments = rel.split('/');
    if (segments.length < 2) fail('expected <skills folder>/<name>');
    for (const segment of segments) {
      if (
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment !== segment.trim() ||
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
        /[\\:\0-\x1f\x7f]/.test(segment)
      ) {
        fail(`unsafe segment "${segment}"`);
      }
    }
    if (segments[segments.length - 1] !== name) fail(`the folder must be named ${name}`);
    const dir = segments.slice(0, -1).join('/');
    if (!AGENT_IDS.some((agent) => this.deps.agents.reads(agent, scope, dir))) {
      fail(`${dir} is not a skills folder any supported agent reads`);
    }
    if (!this.isWritable(scope, dir)) fail(`${dir} is not a folder agenthub installs into`);
    const absDir = path.join(root, ...segments);
    if (!fsu.isWithin(root, absDir)) fail('outside the scope root');
    return { dir, absDir };
  }

  /** Configuration as seen by an operation at `scope`: user scope never reads project config. */
  private config(scope?: Scope): LoadedConfig {
    return loadConfig({
      cwd: this.deps.cwd,
      home: this.deps.home,
      agenthubHome: this.deps.agenthubHome,
      env: process.env,
      ...(scope === undefined ? {} : { scope }),
    });
  }

  /**
   * The registry for an operation at `scope`. A registry chosen by the project config (only
   * possible when the user trusted it for this project) is never used for user-scope operations.
   */
  private registryOrNull(scope: Scope): RegistrySource | null {
    const full = this.config();
    if (scope === 'user' && full.sources.registry === 'project') {
      throw new AgentHubError(
        'USAGE',
        `the registry ${full.effective.registry} comes from the project config ${full.projectConfigPath}; user-scope (-g) commands only use the registry from your user config or AGENTHUB_REGISTRY — run the command outside the project`,
      );
    }
    if (this.deps.registry) return this.deps.registry;
    const configured = full.effective.registry;
    if (!configured) return null;
    if (configured.startsWith('file:')) {
      if (this.fileRegistry?.id !== configured) {
        this.fileRegistry = {
          id: configured,
          source: createFileRegistry(configured.slice('file:'.length)),
        };
      }
      return this.fileRegistry.source;
    }
    throw new AgentHubError(
      'REGISTRY',
      `the registry ${configured} needs a registry client, and none was provided`,
    );
  }

  /** Hints about where the registry setting came from, for plans. */
  private configHints(scope: Scope): string[] {
    if (scope === 'user') return [];
    const config = this.config();
    const hints = [...config.warnings];
    if (config.sources.registry === 'project') {
      hints.push(
        `the registry ${config.effective.registry} is set by the project config ${config.projectConfigPath} (trusted in your user config)`,
      );
    }
    return hints;
  }

  private registry(scope: Scope): RegistrySource {
    const registry = this.registryOrNull(scope);
    if (registry === null) {
      throw new AgentHubError(
        'USAGE',
        'no registry configured — set one with `agenthub config set registry file:<dir>`',
      );
    }
    return registry;
  }

  private agentEnv(id: AgentId, detected: AgentEnvironment[], evidence: string): AgentEnvironment {
    return (
      detected.find((env) => env.id === id) ?? {
        id,
        displayName: DISPLAY_NAMES[id],
        confidence: 'low',
        evidence: [evidence],
        status: 'verified',
      }
    );
  }

  private guard(scope: Scope, extra: Iterable<string> = []): WriteGuard {
    return new WriteGuard([this.deps.agenthubHome, this.stateDir(scope), ...extra]);
  }

  /**
   * Project-scope skills folders must stay inside the project after resolving links, so a
   * committed symlink (e.g. `.claude/skills` -> elsewhere) cannot redirect writes. User-scope
   * folders may be links (dotfile setups) — the user controls their own home.
   */
  private async contained(scope: Scope, absDir: string): Promise<boolean> {
    if (scope === 'user') return true;
    return fsu.resolvesWithin(this.scopeRoot(scope), path.dirname(absDir));
  }

  // -------------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------------

  async plan(req: InstallRequest): Promise<InstallPlan> {
    const scopeRoot = this.scopeRoot(req.scope);
    const config = this.config(req.scope);
    const channel = req.channel ?? config.effective.channel ?? 'stable';
    const detected = await this.deps.agents.detect();

    let agents: AgentEnvironment[];
    if (req.agents && req.agents.length > 0) {
      for (const id of req.agents) {
        if (!(AGENT_IDS as readonly string[]).includes(id)) {
          throw new AgentHubError(
            'USAGE',
            `unknown agent "${id}" (known: ${AGENT_IDS.join(', ')})`,
          );
        }
      }
      agents = sortAgents(req.agents).map((id) =>
        this.agentEnv(id, detected, 'selected with --agent'),
      );
    } else if (Array.isArray(config.effective.agents)) {
      agents = sortAgents(config.effective.agents).map((id) =>
        this.agentEnv(id, detected, 'selected in config'),
      );
    } else {
      agents = detected.filter(
        (env) =>
          (env.confidence === 'high' || env.confidence === 'medium') && env.status === 'verified',
      );
      agents = sortAgents(agents.map((env) => env.id)).map((id) => this.agentEnv(id, detected, ''));
    }

    const dev = req.dev ?? false;
    const force = req.force ?? false;
    const source = req.source;
    const hints = this.configHints(req.scope);

    if (source.kind === 'dir') {
      const abs = path.resolve(this.deps.cwd, source.path);
      const pkg = await loadSkillFromDir(abs);
      return this.buildPlan({
        pkg,
        source: { kind: 'dir', path: abs },
        lockSource: 'dir',
        registry: null,
        scope: req.scope,
        agents,
        detected,
        dev,
        force,
        hints,
      });
    }

    if (source.kind === 'file') {
      const abs = path.resolve(this.deps.cwd, source.path);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await fs.readFile(abs));
      } catch (error) {
        const code = fsu.errnoCode(error);
        if (code === 'ENOENT') throw new AgentHubError('NOT_FOUND', `package not found: ${abs}`);
        throw new AgentHubError('IO', `cannot read ${abs}: ${code ?? errorText(error)}`);
      }
      const pkg = readSkillArchive(bytes);
      return this.buildPlan({
        pkg,
        source: { kind: 'file', path: abs },
        lockSource: 'file',
        registry: null,
        scope: req.scope,
        agents,
        detected,
        dev,
        force,
        archiveDigest: archiveDigest(bytes),
        hints,
      });
    }

    const registry = this.registry(req.scope);
    const versions = await registry.listVersions(source.name);
    const outcome = resolveVersion(versions, {
      ...(source.range === undefined ? {} : { range: source.range }),
      channel,
      agents: agents.map((env) => env.id),
    });
    const planSource: InstallPlan['source'] = {
      kind: 'registry',
      name: source.name,
      ...(source.range === undefined ? {} : { range: source.range }),
      registry: registry.id,
    };
    if (outcome.kind === 'none') {
      throw new AgentHubError('NOT_FOUND', `${source.name}: ${outcome.reason}`);
    }
    if (outcome.kind === 'revoked') {
      return this.revokedPlan(source.name, outcome.version, planSource, req, scopeRoot, agents);
    }
    const { pkg, archive } = await this.downloadVerified(registry, source.name, outcome.version);
    return this.buildPlan({
      pkg,
      source: planSource,
      lockSource: 'registry',
      registry: registry.id,
      scope: req.scope,
      agents,
      detected,
      dev,
      force,
      archiveDigest: archive,
      hints,
    });
  }

  private async revokedPlan(
    name: string,
    version: RegistryVersion,
    source: InstallPlan['source'],
    req: InstallRequest,
    scopeRoot: string,
    agents: AgentEnvironment[],
  ): Promise<InstallPlan> {
    const reason = version.revokedReason ? `: ${version.revokedReason}` : '';
    return this.stubPlan({
      name,
      skill: version,
      source,
      scope: req.scope,
      scopeRoot,
      agents,
      blockers: [
        { code: 'REVOKED', message: `version ${version.version} of ${name} is revoked${reason}` },
      ],
      hints: [],
      dev: req.dev ?? false,
      force: req.force ?? false,
    });
  }

  /** A plan that can never be applied (it has blockers and no package behind it). */
  private async stubPlan(args: {
    name: string;
    skill: Pick<RegistryVersion, 'version' | 'digest' | 'archiveDigest'>;
    source: InstallPlan['source'];
    scope: Scope;
    scopeRoot: string;
    agents: AgentEnvironment[];
    blockers: Blocker[];
    hints: string[];
    dev: boolean;
    force: boolean;
  }): Promise<InstallPlan> {
    const lock = await readLock(this.lockFile(args.scope));
    const previous = own(lock.skills, args.name);
    return {
      id: newTxid(this.now()),
      skill: {
        name: args.name,
        version: args.skill.version,
        digest: args.skill.digest,
        ...(args.skill.archiveDigest ? { archiveDigest: args.skill.archiveDigest } : {}),
      },
      source: args.source,
      scope: args.scope,
      scopeRoot: args.scopeRoot,
      agents: args.agents,
      targets: [],
      duplicates: [],
      policy: { findings: [], outcome: 'allow' },
      requirements: [],
      issues: [],
      blockers: args.blockers,
      needsConfirmation: false,
      hints: args.hints,
      ...(previous ? { previous } : {}),
      dev: args.dev,
      force: args.force,
    };
  }

  /** Download one version and verify the archive digest and the content digest. */
  private async downloadVerified(
    registry: RegistrySource,
    name: string,
    version: Pick<RegistryVersion, 'version' | 'digest' | 'archiveDigest'>,
  ): Promise<{ pkg: SkillPackage; archive: string }> {
    const download = await registry.download(name, version.version);
    const actual = archiveDigest(download.bytes);
    if (download.archiveDigest !== actual) {
      throw new AgentHubError(
        'INTEGRITY',
        `archive digest mismatch for ${name}@${version.version}: the registry promised ${download.archiveDigest}, got ${actual}`,
      );
    }
    if (version.archiveDigest !== undefined && version.archiveDigest !== actual) {
      throw new AgentHubError(
        'INTEGRITY',
        `archive digest mismatch for ${name}@${version.version}: expected ${version.archiveDigest}, got ${actual}`,
        { expected: version.archiveDigest, actual },
      );
    }
    const pkg = readSkillArchive(download.bytes, {
      expectedDigest: version.digest,
      folderName: name,
    });
    if (pkg.manifest?.version !== undefined && pkg.manifest.version !== version.version) {
      throw new AgentHubError(
        'INTEGRITY',
        `${name}@${version.version} contains version ${pkg.manifest.version} in agenthub.yaml`,
      );
    }
    return { pkg: withVersion(pkg, version.version), archive: actual };
  }

  private async checkRequirements(manifest: SkillManifest | null): Promise<RequirementCheck[]> {
    const out: RequirementCheck[] = [];
    const requires = manifest?.requires;
    if (!requires) return out;
    for (const [name, constraint] of Object.entries(requires.runtimes ?? {})) {
      const found = await this.deps.probe.runtime(name);
      const coerced = found === null ? null : semver.coerce(found);
      const ok = coerced !== null && semver.satisfies(coerced, constraint);
      out.push({ kind: 'runtime', name, constraint, found, ok });
    }
    for (const name of requires.commands ?? []) {
      const ok = await this.deps.probe.command(name);
      out.push({ kind: 'command', name, found: ok ? name : null, ok });
    }
    for (const name of requires.mcp ?? []) out.push({ kind: 'mcp', name, ok: null });
    return out;
  }

  private evaluatePolicy(
    pkg: SkillPackage,
    dev: boolean,
  ): { policy: PolicyResult; override: boolean; strict: PolicyResult; report: CapabilityReport } {
    const scan = this.deps.security.scan(
      pkg.files.map((file) => ({ path: file.path, content: file.content, kind: file.kind })),
    );
    const strict = this.deps.security.evaluate(scan.findings, pkg.manifest, { dev: false });
    // Derived from the strict evaluation, so --dev can never alter the capability set.
    const report = deriveCapabilities(
      strict.findings,
      pkg.manifest,
      scan.externals ?? [],
      scan.rulesetDigest ?? this.fallbackRulesetDigest(scan.scannerVersion),
    );
    if (strict.outcome !== 'block' || !dev) {
      return { policy: strict, override: false, strict, report };
    }
    return {
      policy: this.deps.security.evaluate(scan.findings, pkg.manifest, { dev: true }),
      override: true,
      strict,
      report,
    };
  }

  private fallbackRulesetDigest(scannerVersion: string): string {
    const text = JSON.stringify({ capabilitySchema: CAPABILITY_SCHEMA, scanner: scannerVersion });
    return `sha256:${sha256Hex(new TextEncoder().encode(text))}`;
  }

  private rulesetCache: string | undefined;

  /** The current scanner ruleset ('sha256:<hex>'). */
  private rulesetDigest(): string {
    if (this.rulesetCache === undefined) {
      const port = this.deps.security;
      if (port.rulesetDigest !== undefined) this.rulesetCache = port.rulesetDigest;
      else {
        const empty = port.scan([]);
        this.rulesetCache = empty.rulesetDigest ?? this.fallbackRulesetDigest(empty.scannerVersion);
      }
    }
    return this.rulesetCache;
  }

  /**
   * The exact package of an installed entry from local bytes only: an intact installed copy,
   * else the cache. Never the registry (a baseline must not come from the party being checked).
   */
  private async installedPackage(
    scope: Scope,
    name: string,
    entry: LockEntry,
  ): Promise<SkillPackage | null> {
    for (const lockPath of Object.keys(entry.paths)) {
      let absDir: string;
      try {
        absDir = this.resolveLockPath(scope, lockPath, name).absDir;
      } catch {
        continue;
      }
      if ((await fsu.pathKind(absDir)) !== 'dir') continue;
      const hashes = await fsu.hashInstalledDir(absDir);
      if (!Object.entries(entry.files).every(([file, hash]) => hashes[file] === hash)) continue;
      try {
        const pkg = buildSkillPackage(await this.readFilesFrom(absDir, Object.keys(entry.files)), {
          folderName: name,
        });
        if (pkg.digest === entry.digest) return withVersion(pkg, entry.version);
      } catch {
        // A copy that no longer builds is not a baseline; try the next one.
      }
    }
    const cached = await this.readCached(entry.digest, name);
    return cached === null ? null : withVersion(cached, entry.version);
  }

  /** Rescan of an installed entry (intact copy or cache); null when neither exists. */
  private async scanInstalled(
    scope: Scope,
    name: string,
    entry: LockEntry,
  ): Promise<InstalledScan | null> {
    const pkg = await this.installedPackage(scope, name, entry);
    if (pkg === null) return null;
    const { strict, report } = this.evaluatePolicy(pkg, false);
    return { pkg, report, strict };
  }

  /** Approval state and approved baseline of an installed entry. */
  private async baselineOf(
    scope: Scope,
    name: string,
    entry: LockEntry,
  ): Promise<{
    scan: InstalledScan | null;
    status: ApprovalStatus;
    baseline: CapabilityReport['set'];
  }> {
    const scan = await this.scanInstalled(scope, name, entry);
    const status = approvalState(entry, scan?.report ?? null, scan?.strict.outcome ?? null);
    return { scan, status, baseline: approvedBaseline(entry, scan?.report ?? null, status) };
  }

  /** The capability view of a plan (design §4.2–§4.3). */
  private async planCapabilities(
    scope: Scope,
    pkg: SkillPackage,
    previous: LockEntry | undefined,
    report: CapabilityReport,
    strict: PolicyResult,
    carry: LockEntry | undefined,
  ): Promise<PlanCapabilities> {
    const approvable = strict.outcome !== 'block';
    const base = { rulesetDigest: report.rulesetDigest, candidate: report, approvable };
    if (previous === undefined && carry === undefined) {
      return {
        ...base,
        state: 'fresh',
        stale: [],
        delta: null,
        unapproved: diffCapabilities(null, report.set),
        approvalRequired: false,
        previousOutcome: null,
        files: null,
      };
    }
    if (carry === undefined && previous !== undefined && previous.digest === pkg.digest) {
      // Same bytes as installed: the rescan of the candidate is the rescan of the entry.
      const status = approvalState(previous, report, strict.outcome);
      return {
        ...base,
        state: status.state,
        stale: status.stale,
        delta: diffCapabilities(report.set, report.set),
        unapproved: diffCapabilities(report.set, report.set),
        approvalRequired: false,
        previousOutcome: strict.outcome,
        files: null,
      };
    }
    const scanned =
      previous === undefined ? null : await this.baselineOf(scope, pkg.name, previous);
    const installedSet =
      scanned?.scan?.report.set ?? (previous ? recordedSet(previous) : null) ?? null;
    let state: PlanCapabilities['state'];
    let stale: string[] = [];
    let unapproved = diffCapabilities(scanned?.baseline ?? null, report.set);
    if (carry !== undefined) {
      // Rollback restores the snapshot entry with its own approval; never gated.
      const status = approvalState(carry, report, strict.outcome);
      state = status.state;
      stale = status.stale;
      unapproved = diffCapabilities(report.set, report.set);
    } else if (scanned === null || scanned.scan === null) {
      state = 'unavailable';
    } else {
      state = scanned.status.state;
      stale = scanned.status.stale;
    }
    const previousPkg = scanned?.scan?.pkg ?? null;
    return {
      ...base,
      state,
      stale,
      delta: diffCapabilities(installedSet, report.set),
      unapproved,
      approvalRequired: carry === undefined && unapproved.expansion,
      previousOutcome: scanned?.scan?.strict.outcome ?? null,
      files: summarizeFileChanges(
        previous === undefined
          ? null
          : { files: previous.files, skillMd: previousPkg ? skillMdText(previousPkg) : null },
        { files: pkg.fileHashes, skillMd: skillMdText(pkg) },
      ),
    };
  }

  /**
   * What applying `pkg` does to one target folder. 'unchanged' only when the folder on disk holds
   * exactly the package's files (the package that was scanned); drift is reported against the
   * lock (hand edits since the last install).
   */
  private async inspectTarget(
    absDir: string,
    lockPath: string,
    previous: LockEntry | undefined,
    pkg: Pick<SkillPackage, 'digest' | 'fileHashes'>,
  ): Promise<TargetState> {
    const kind = await fsu.pathKind(absDir);
    if (kind === 'missing') return { action: 'create' };
    if (kind !== 'dir') return { action: 'replace', unmanaged: true, link: kind === 'link' };
    if (previous === undefined || !Object.hasOwn(previous.paths, lockPath)) {
      return { action: 'replace', unmanaged: true };
    }
    const actual = await hashSkillDir(absDir, previous.files);
    const drift = fsu
      .diffFiles(previous.files, actual)
      .filter((status) => status.status !== 'ok')
      .map((status) => status.path);
    if (
      drift.length === 0 &&
      previous.digest === pkg.digest &&
      sameRecord(fsu.withoutJunk(actual, pkg.fileHashes), pkg.fileHashes)
    ) {
      return { action: 'unchanged' };
    }
    return drift.length > 0 ? { action: 'replace', drift } : { action: 'replace' };
  }

  private async buildPlan(input: BuildPlanInput): Promise<InstallPlan> {
    const { pkg, scope } = input;
    const scopeRoot = this.scopeRoot(scope);
    const lock = await readLock(this.lockFile(scope));
    const previous = own(lock.skills, pkg.name);
    const hints = [...(input.hints ?? [])];
    const blockers: InstallPlan['blockers'] = [...(input.blockers ?? [])];

    // A registry install never silently switches a skill to another registry.
    if (
      previous?.source === 'registry' &&
      input.lockSource === 'registry' &&
      !sameRegistry(previous.registry, input.registry) &&
      !input.force
    ) {
      blockers.push({
        code: 'CONFLICT',
        message: `${pkg.name} was installed from ${previous.registry ?? 'an unknown registry'}, not ${input.registry} — use --force to switch registries`,
      });
    }

    // Agents and folders.
    let selected = input.agents;
    let noTargetsReason = 'no supported agents detected — use --agent';
    const declared = pkg.manifest?.targets;
    if (!input.fixedTargets && declared && declared.length > 0 && selected.length > 0) {
      const dropped = selected.filter((env) => !declared.includes(env.id));
      if (dropped.length > 0) {
        hints.push(
          `${pkg.name} declares support for ${declared.join(', ')} only; skipping ${dropped.map((env) => env.id).join(', ')}`,
        );
        noTargetsReason = `${pkg.name} supports ${declared.join(', ')}, but only ${dropped.map((env) => env.id).join(', ')} ${dropped.length === 1 ? 'is' : 'are'} selected`;
      }
      selected = selected.filter((env) => declared.includes(env.id));
    }

    const folders = new Map<string, AgentId[]>();
    const addFolder = (dir: string, agents: AgentId[]) => {
      folders.set(dir, sortAgents([...(folders.get(dir) ?? []), ...agents]));
    };
    if (input.fixedTargets) {
      for (const folder of input.fixedTargets) addFolder(folder.dir, folder.agents);
    } else if (selected.length > 0) {
      try {
        for (const folder of this.deps.agents.selectTargets(
          scope,
          selected.map((env) => env.id),
        )) {
          addFolder(folder.dir, folder.agents);
        }
      } catch (error) {
        if (!isAgentHubError(error) || error.code !== 'INCOMPATIBLE') throw error;
        noTargetsReason = error.message;
      }
    }
    // A skill is always updated everywhere it is already installed in this scope.
    if (previous) {
      for (const [lockPath, agents] of Object.entries(previous.paths)) {
        addFolder(this.resolveLockPath(scope, lockPath, pkg.name).dir, agents);
      }
    }

    // Requirements.
    const requirements = await this.checkRequirements(pkg.manifest);
    for (const check of requirements) {
      if (check.ok === false) {
        blockers.push({ code: 'INCOMPATIBLE', message: describeRequirement(pkg.name, check) });
      } else if (check.ok === null) {
        hints.push(
          `${describeRequirement(pkg.name, check)}; agenthub cannot check it — make sure it is configured`,
        );
      }
    }

    // Policy.
    const { policy, override, strict, report } = this.evaluatePolicy(pkg, input.dev);
    if (policy.outcome === 'block' && !override) {
      blockers.push({ code: 'POLICY_BLOCKED', message: describeBlock(policy) });
    }
    if (override) {
      hints.push(
        `--dev: installing despite BLOCK findings (${describeBlock(strict).slice('blocked by policy: '.length)}); the override is written to the audit log`,
      );
    }

    // Reserved lock fields fail closed (trust features §3.2).
    for (const entry of [previous, input.carry]) {
      if (entry?.quarantine !== undefined) {
        blockers.push({
          code: 'CONFLICT',
          message: `${pkg.name} is quarantined in the lock${quarantineText(entry)} — it cannot be installed, updated or restored; remove the entry with "agenthub remove ${pkg.name}" after reviewing why`,
        });
        break;
      }
    }
    if (previous?.signer !== undefined && previous.digest !== pkg.digest) {
      blockers.push({
        code: 'CONFLICT',
        message: `${pkg.name} has a signer in the lock: changing it needs an agenthub that verifies signatures`,
      });
    }

    // Capabilities and the approval gate.
    const capabilities = await this.planCapabilities(
      scope,
      pkg,
      previous,
      report,
      strict,
      input.carry,
    );
    if (input.carry === undefined && previous !== undefined && previous.digest === pkg.digest) {
      if (capabilities.state === 'stale') {
        hints.push(
          `the approval of ${pkg.name} predates the current scanner rules, which also see: ${capabilities.stale.join(', ')} — review and run "agenthub approve ${pkg.name}"`,
        );
      } else if (
        capabilities.state === 'unapproved' &&
        capabilities.approvable &&
        previous.approval === undefined
      ) {
        hints.push(
          `${pkg.name} has no recorded capability approval — review it with "agenthub approve ${pkg.name}"`,
        );
      }
    }

    // Targets.
    const targets: PlannedTarget[] = [];
    const newFolderAgents = new Set<AgentId>();
    for (const [dir, agents] of folders) {
      const lockPath = this.lockPathFor(scope, dir, pkg.name);
      const { absDir } = this.resolveLockPath(scope, lockPath, pkg.name);
      const state = await this.inspectTarget(absDir, lockPath, previous, pkg);
      const target: PlannedTarget = { dir, absDir, lockPath, agents, action: state.action };
      if (state.drift) target.drift = state.drift;
      if (state.unmanaged) target.unmanaged = true;
      targets.push(target);
      if (!(await this.contained(scope, absDir))) {
        blockers.push({
          code: 'CONFLICT',
          message: `${lockPath} resolves outside the project through a symlinked folder; agenthub will not write there`,
        });
      }
      if (state.unmanaged && !input.force) {
        blockers.push({
          code: 'CONFLICT',
          message: `${lockPath} already exists and is not managed by agenthub${state.link ? ' (it is a symlink or junction)' : ''} — use --force to replace it`,
        });
      }
      if (state.drift && !input.force) {
        blockers.push({
          code: 'DRIFT',
          message: `${lockPath} has local changes (${state.drift.join(', ')}) — use --force to overwrite them`,
        });
      }
      if (!(await fsu.exists(path.join(scopeRoot, ...dir.split('/'))))) {
        for (const agent of agents) newFolderAgents.add(agent);
      }
    }
    if (targets.length === 0) blockers.push({ code: 'INCOMPATIBLE', message: noTargetsReason });

    const duplicates =
      targets.length > 0
        ? this.deps.agents.duplicates(
            scope,
            targets.map((t) => ({ dir: t.dir, agents: t.agents })),
          )
        : [];
    if (duplicates.length > 0) {
      hints.push(
        `${duplicates.join(', ')} will see ${pkg.name} in more than one folder (${targets.map((t) => t.dir).join(', ')})`,
      );
    }
    for (const agent of sortAgents(newFolderAgents)) {
      const hint = this.deps.agents.reloadHint(agent);
      if (hint && !hints.includes(hint)) hints.push(hint);
    }

    const targetAgents = sortAgents(targets.flatMap((t) => t.agents));
    const agentEnvs = sortAgents([...selected.map((env) => env.id), ...targetAgents]).map((id) =>
      this.agentEnv(
        id,
        [...selected, ...input.detected],
        input.fixedTargets ? 'recorded in the lock' : 'installed previously',
      ),
    );

    const plan: InstallPlan = {
      id: newTxid(this.now()),
      skill: {
        name: pkg.name,
        version: pkg.version,
        digest: pkg.digest,
        ...(input.archiveDigest ? { archiveDigest: input.archiveDigest } : {}),
      },
      source: input.source,
      scope,
      scopeRoot,
      agents: agentEnvs,
      targets,
      duplicates,
      policy,
      requirements,
      issues: [...pkg.issues],
      blockers,
      needsConfirmation:
        policy.outcome !== 'allow' ||
        override ||
        targets.some((t) => t.action === 'replace') ||
        capabilities.approvalRequired,
      capabilities,
      hints,
      ...(previous ? { previous } : {}),
      dev: input.dev,
      force: input.force,
    };
    INTERNALS.set(plan, {
      pkg,
      action:
        input.action === 'rollback'
          ? 'rollback'
          : previous && previous.version !== pkg.version
            ? 'update'
            : 'install',
      lockSource: input.lockSource,
      registry: input.registry,
      ...(input.carry === undefined ? {} : { carry: input.carry }),
    });
    return plan;
  }

  /** Re-create the internals of a plan this engine did not produce (e.g. deserialized). */
  private async rehydrate(plan: InstallPlan): Promise<PlanInternals> {
    const source = plan.source;
    let pkg: SkillPackage;
    let lockSource: LockEntry['source'];
    let registry: string | null = null;
    if (source.kind === 'dir') {
      pkg = await loadSkillFromDir(source.path);
      lockSource = 'dir';
    } else if (source.kind === 'file') {
      pkg = readSkillArchive(new Uint8Array(await fs.readFile(source.path)));
      lockSource = 'file';
    } else {
      const reg = this.registry(plan.scope);
      if (source.registry !== undefined && !sameRegistry(source.registry, reg.id)) {
        throw new AgentHubError(
          'CONFLICT',
          `the plan for ${plan.skill.name} was made against ${source.registry}, but the configured registry is ${reg.id}`,
        );
      }
      pkg = (
        await this.downloadVerified(reg, plan.skill.name, {
          version: plan.skill.version,
          digest: plan.skill.digest,
          ...(plan.skill.archiveDigest ? { archiveDigest: plan.skill.archiveDigest } : {}),
        })
      ).pkg;
      lockSource = 'registry';
      registry = reg.id;
    }
    if (pkg.digest !== plan.skill.digest) {
      throw new AgentHubError(
        'INTEGRITY',
        `${plan.skill.name} changed since the plan was made: expected ${plan.skill.digest}, got ${pkg.digest}`,
      );
    }
    return {
      pkg: withVersion(pkg, plan.skill.version),
      action: plan.previous && plan.previous.version !== plan.skill.version ? 'update' : 'install',
      lockSource,
      registry,
    };
  }

  // -------------------------------------------------------------------------
  // Apply (design §8.4)
  // -------------------------------------------------------------------------

  async apply(plan: InstallPlan, opts: { approve?: ApprovalInput } = {}): Promise<InstallResult> {
    const blocked = blockerError(plan);
    if (blocked) throw blocked;
    return this.exclusive(() => this.applyLocked(plan, opts));
  }

  /** apply() for callers that already hold the process lock. */
  private async applyLocked(
    plan: InstallPlan,
    opts: { approve?: ApprovalInput } = {},
  ): Promise<InstallResult> {
    const blocked = blockerError(plan);
    if (blocked) throw blocked;
    const internals = INTERNALS.get(plan) ?? (await this.rehydrate(plan));
    const { pkg } = internals;
    const scope = plan.scope;
    const name = pkg.name;
    if (pkg.digest !== plan.skill.digest || name !== plan.skill.name) {
      throw new AgentHubError(
        'INTEGRITY',
        `the plan does not match the package for ${plan.skill.name}`,
      );
    }
    const scopeRoot = this.scopeRoot(scope);
    if (!fsu.isWithin(scopeRoot, plan.scopeRoot) || !fsu.isWithin(plan.scopeRoot, scopeRoot)) {
      throw new AgentHubError(
        'CONFLICT',
        `the plan was made for ${plan.scopeRoot}, not ${scopeRoot}`,
      );
    }

    // Policy is re-checked here so a plan edited after planning cannot skip it.
    const { policy, override, strict, report } = this.evaluatePolicy(pkg, plan.dev);
    if (policy.outcome === 'block' && !override) {
      throw new AgentHubError('POLICY_BLOCKED', describeBlock(policy), {
        findings: policy.findings.filter((f) => f.decision === 'BLOCK'),
      });
    }

    const lockFile = this.lockFile(scope);
    const previousLockText = await fsu.readTextOrNull(lockFile);
    const lock: LockFile =
      previousLockText === null ? emptyLock() : parseLock(previousLockText, lockFile);
    const previous = own(lock.skills, name);
    const carry = internals.carry;

    // Reserved fields are re-checked against the lock as read now.
    const quarantined = [previous, carry].find((entry) => entry?.quarantine !== undefined);
    if (quarantined !== undefined) {
      throw new AgentHubError(
        'CONFLICT',
        `${name} is quarantined in the lock${quarantineText(quarantined)}`,
      );
    }
    if (previous?.signer !== undefined && previous.digest !== pkg.digest) {
      throw new AgentHubError(
        'CONFLICT',
        `${name} has a signer in the lock: changing it needs an agenthub that verifies signatures`,
      );
    }

    // The capability gate (design §4.2), recomputed from the lock and the bytes as they are now,
    // so a plan made earlier, edited, or deserialized cannot skip it. Rollback is never gated.
    const replacing = previous !== undefined && previous.digest !== pkg.digest;
    let expansion: string[] = [];
    if (replacing && carry === undefined) {
      const { baseline } = await this.baselineOf(scope, name, previous);
      const unapproved = diffCapabilities(baseline, report.set);
      if (unapproved.expansion) {
        expansion = expansionTokens(unapproved);
        if (opts.approve === undefined) {
          throw new AgentHubError(
            'APPROVAL_REQUIRED',
            `${name} ${plan.skill.version} can do more than the version you approved (${expansion.join(', ')}) — review it with "agenthub diff ${name}" and approve it explicitly (--approve-capabilities)`,
            { skill: name, version: plan.skill.version, unapproved: expansion },
          );
        }
      }
    }

    // The disk must still look the way the plan saw it.
    for (const target of plan.targets) {
      const resolved = this.resolveLockPath(scope, target.lockPath, name);
      if (
        resolved.dir !== target.dir ||
        !fsu.isWithin(resolved.absDir, target.absDir) ||
        !fsu.isWithin(target.absDir, resolved.absDir)
      ) {
        throw new AgentHubError(
          'INTERNAL',
          `plan target ${target.lockPath} does not match ${target.absDir}`,
        );
      }
      if (!(await this.contained(scope, target.absDir))) {
        throw new AgentHubError(
          'CONFLICT',
          `${target.lockPath} resolves outside the project through a symlinked folder`,
        );
      }
      const state = await this.inspectTarget(target.absDir, target.lockPath, previous, pkg);
      const changed =
        state.action !== target.action ||
        (state.unmanaged ?? false) !== (target.unmanaged ?? false) ||
        (state.drift ?? []).join('\n') !== (target.drift ?? []).join('\n');
      if (changed) {
        throw new AgentHubError(
          'CONFLICT',
          `${target.lockPath} changed since the plan was made — run the command again`,
        );
      }
      if (state.unmanaged && !plan.force) {
        throw new AgentHubError(
          'CONFLICT',
          `${target.lockPath} is not managed by agenthub — use --force`,
        );
      }
      if (state.drift && !plan.force) {
        throw new AgentHubError('DRIFT', `${target.lockPath} has local changes — use --force`);
      }
    }

    const now = this.now();
    const paths: Record<string, AgentId[]> = {};
    for (const target of [...plan.targets].sort((a, b) => (a.lockPath < b.lockPath ? -1 : 1))) {
      paths[target.lockPath] = sortAgents(target.agents);
    }
    const baseEntry: LockEntry = {
      version: plan.skill.version,
      digest: pkg.digest,
      source: internals.lockSource,
      registry: internals.registry,
      installedTargets: sortAgents(plan.targets.flatMap((t) => t.agents)),
      paths,
      files: { ...pkg.fileHashes },
      installedAt:
        previous && previous.digest === pkg.digest ? previous.installedAt : now.toISOString(),
    };
    const { entry: newEntry, approvalMode } = this.entryWithCapabilities({
      base: baseEntry,
      previous,
      carry,
      report,
      approvable: strict.outcome !== 'block',
      expanded: expansion.length > 0,
      approve: opts.approve,
      now,
    });

    const auditBase = {
      name,
      version: plan.skill.version,
      digest: pkg.digest,
      scope,
      targets: plan.targets.map((t) => t.lockPath),
      dev: plan.dev,
      capabilityDigest: newEntry.capabilityDigest ?? null,
      approval: approvalMode,
      ...(expansion.length > 0 ? { approvedExpansion: expansion } : {}),
    };
    if (override) {
      await this.audit({
        ...auditBase,
        action: 'override',
        findings: strict.findings
          .filter((f) => f.decision === 'BLOCK')
          .map((f) => `${f.ruleId} ${f.file}:${f.line}`),
        result: 'ok',
      });
    }

    const result: InstallResult = {
      name,
      version: plan.skill.version,
      digest: pkg.digest,
      scope,
      targets: plan.targets.map((t) => ({
        dir: t.dir,
        lockPath: t.lockPath,
        agents: [...t.agents],
      })),
      hints: [...plan.hints],
    };

    const changing = plan.targets.filter((t) => t.action !== 'unchanged');
    if (changing.length === 0) {
      if (entryKey(previous) !== entryKey(newEntry)) {
        const guard = this.guard(scope);
        lock.skills[name] = newEntry;
        await this.writeScopeLock(guard, scope, lockFile, lock);
        await this.audit({ ...auditBase, action: internals.action, result: 'ok' });
      }
      return result;
    }

    const committed = await this.transact({
      plan,
      pkg,
      changing,
      lock,
      lockFile,
      previousLockText,
      newEntry,
    }).catch(async (error: unknown) => {
      await this.audit({
        ...auditBase,
        action: internals.action,
        result: 'failed',
        error: errorText(error),
      }).catch(() => undefined);
      throw error;
    });

    // Past the commit point: everything below is best effort.
    const { guard, journal, backups } = committed;
    if (previous && previous.digest !== pkg.digest) {
      try {
        const snapshot = await this.writeSnapshot(
          guard,
          scope,
          name,
          previous,
          backups,
          journal.txid,
        );
        if (snapshot) result.snapshot = snapshot;
        else
          result.hints.push(
            `no intact copy of ${name}@${previous.version} was found to keep as a snapshot`,
          );
      } catch (error) {
        result.hints.push(
          `could not save a snapshot of ${name}@${previous.version}: ${errorText(error)}`,
        );
      }
    }
    try {
      await this.cachePackage(pkg);
    } catch (error) {
      result.hints.push(`could not cache ${name}@${plan.skill.version}: ${errorText(error)}`);
    }
    try {
      await this.audit({ ...auditBase, action: internals.action, result: 'ok' });
    } catch (error) {
      result.hints.push(`could not write the audit log: ${errorText(error)}`);
    }
    try {
      for (const dir of journal.stagingDirs) await fsu.removeTree(guard, dir);
      await fsu.removeEmptyDirs(guard, [scopeTmpDir(scope, this.loc)]);
      await deleteJournal(guard, this.deps.agenthubHome, journal.txid);
    } catch (error) {
      result.hints.push(`could not clean up the transaction files: ${errorText(error)}`);
    }
    return result;
  }

  /**
   * The lock entry an apply writes (design §4.3):
   * - same digest (restore, re-target): the capability block, approval and reserved fields are
   *   carried verbatim, so a scanner upgrade never dirties the lock;
   * - rollback: the snapshot entry's block, with its approval when bound to its digest;
   * - another digest: a fresh block; an approval only when the strict outcome allows it —
   *   new on a fresh install or with an explicit approval, carried forward when nothing expands.
   */
  private entryWithCapabilities(args: {
    base: LockEntry;
    previous: LockEntry | undefined;
    carry: LockEntry | undefined;
    report: CapabilityReport;
    approvable: boolean;
    expanded: boolean;
    approve: ApprovalInput | undefined;
    now: Date;
  }): { entry: LockEntry; approvalMode: string } {
    const { base, previous, carry, report, approve, now } = args;
    if (carry !== undefined) {
      const fields = carriedFields(carry);
      if (fields.approval !== undefined && fields.approval.digest !== carry.digest) {
        delete fields.approval;
      }
      return {
        entry: { ...base, ...fields },
        approvalMode: fields.approval === undefined ? 'none' : 'rollback',
      };
    }
    if (previous !== undefined && previous.digest === base.digest) {
      const fields = carriedFields(previous);
      return { entry: { ...base, ...fields }, approvalMode: 'unchanged' };
    }
    const entry: LockEntry = { ...base, ...capabilityBlock(report) };
    if (!args.approvable) return { entry, approvalMode: 'none' };
    const approval: LockApproval = {
      digest: base.digest,
      capabilityDigest: report.digest,
      rulesetDigest: report.rulesetDigest,
      approvedAt: now.toISOString(),
    };
    let mode: string;
    if (previous === undefined || args.expanded || approve !== undefined) {
      if (approve?.by !== undefined) approval.approvedBy = approve.by;
      if (approve?.note !== undefined) approval.note = approve.note;
      mode = approve?.mode ?? (previous === undefined ? 'yes' : 'flag');
    } else {
      const by = previous.approval?.approvedBy;
      if (by !== undefined) approval.approvedBy = by;
      approval.note = `carried forward from ${previous.digest.slice('sha256:'.length, 'sha256:'.length + 8)}`;
      mode = 'carried';
    }
    entry.approval = approval;
    return { entry, approvalMode: mode };
  }

  private async writeScopeLock(
    guard: WriteGuard,
    scope: Scope,
    lockFile: string,
    lock: LockFile,
  ): Promise<void> {
    if (scope === 'project') await ensureStateGitignore(guard, this.stateDir(scope));
    await writeLock(guard, lockFile, lock);
  }

  /** Steps 1–6 of design §8.4. Undoes everything and rethrows on any failure before commit. */
  private async transact(args: {
    plan: InstallPlan;
    pkg: SkillPackage;
    changing: PlannedTarget[];
    lock: LockFile;
    lockFile: string;
    previousLockText: string | null;
    newEntry: LockEntry;
  }): Promise<{ guard: WriteGuard; journal: Journal; backups: string[] }> {
    const { plan, pkg, changing, lock, lockFile, newEntry } = args;
    const scope = plan.scope;
    const home = this.deps.agenthubHome;
    const txid = newTxid(this.now());
    const stagingRoot = path.join(scopeTmpDir(scope, this.loc), txid);
    const guard = this.guard(
      scope,
      changing.map((t) => t.absDir),
    );
    const journal: Journal = {
      txid,
      scope,
      scopeRoot: plan.scopeRoot,
      name: pkg.name,
      stagingRoot,
      stagingDirs: [stagingRoot],
      createdDirs: [],
      steps: [],
      committed: false,
      lockFile,
      previousLockText: args.previousLockText,
      newEntry,
      startedAt: this.now().toISOString(),
      pid: process.pid,
      host: hostname(),
    };
    const steps: {
      target: PlannedTarget;
      staged: string;
      backup?: string;
      journal: JournalStep;
    }[] = [];

    try {
      // 1. Journal.
      await writeJournal(guard, home, journal);

      // 2–3. Stage one verified copy per target, on the target's volume.
      journal.createdDirs.push(...(await fsu.mkdirp(guard, stagingRoot)));
      for (const [index, target] of changing.entries()) {
        let base = stagingRoot;
        const skillsDir = path.dirname(target.absDir);
        if (!(await fsu.sameDevice(stagingRoot, skillsDir))) {
          base = path.join(path.dirname(skillsDir), `.agenthub-tmp-${txid}`);
          guard.allow(base);
          if (!journal.stagingDirs.includes(base)) journal.stagingDirs.push(base);
          await writeJournal(guard, home, journal);
        }
        const staged = path.join(base, 'new', String(index));
        await fsu.writePackageFiles(guard, staged, pkg.files);
        const stagedHashes = await fsu.hashInstalledDir(staged);
        if (!sameRecord(stagedHashes, pkg.fileHashes)) {
          throw new AgentHubError(
            'INTEGRITY',
            `the staged copy for ${target.lockPath} does not match the package`,
          );
        }
        const step: JournalStep = { absDir: target.absDir, staged, swapped: false };
        const backup =
          target.action === 'replace' ? path.join(base, 'old', String(index)) : undefined;
        if (backup) step.backup = backup;
        steps.push({ target, staged, journal: step, ...(backup ? { backup } : {}) });
      }

      // 4. Swap: park the existing folder (or link), move the staged copy into place.
      for (const step of steps) {
        journal.steps.push(step.journal);
        journal.createdDirs.push(...(await fsu.mkdirp(guard, path.dirname(step.target.absDir))));
        await writeJournal(guard, home, journal);
        if (step.backup) {
          await fsu.mkdirp(guard, path.dirname(step.backup));
          await fsu.renameWithRetry(guard, step.target.absDir, step.backup);
        }
        await fsu.renameWithRetry(guard, step.staged, step.target.absDir);
        step.journal.swapped = true;
        await writeJournal(guard, home, journal);
        await this.deps.hooks?.afterSwap?.(step.target.absDir);
      }

      // 5. Validate (D8: structural only).
      for (const step of steps) await this.validateTarget(scope, step.target, pkg);

      // 6. Commit point.
      lock.skills[pkg.name] = newEntry;
      await this.writeScopeLock(guard, scope, lockFile, lock);
      journal.committed = true;
      await writeJournal(guard, home, journal);
    } catch (error) {
      if (this.deps.hooks?.simulateCrash) throw error;
      const problems = await this.undoTransaction(guard, journal, false);
      if (problems.length > 0) {
        throw new AgentHubError(
          'IO',
          `${errorText(error)} — and the install could not be fully undone (${problems.join('; ')}). The journal ${journalFile(home, txid)} was kept; the next agenthub command will finish the recovery`,
          { cause: errorText(error), problems },
        );
      }
      throw error;
    }

    const backups = steps
      .filter((s) => s.backup !== undefined && !s.target.unmanaged)
      .map((s) => s.backup as string);
    return { guard, journal, backups };
  }

  private async validateTarget(
    scope: Scope,
    target: PlannedTarget,
    pkg: SkillPackage,
  ): Promise<void> {
    if ((await fsu.pathKind(target.absDir)) !== 'dir') {
      throw new AgentHubError('INTEGRITY', `${target.lockPath} is not a folder after the swap`);
    }
    const hashes = await fsu.hashInstalledDir(target.absDir);
    if (!sameRecord(hashes, pkg.fileHashes)) {
      const bad = fsu
        .diffFiles(pkg.fileHashes, hashes)
        .filter((s) => s.status !== 'ok')
        .map((s) => `${s.path} (${s.status})`);
      throw new AgentHubError(
        'INTEGRITY',
        `${target.lockPath} does not match the package: ${bad.join(', ')}`,
      );
    }
    const text = await fs.readFile(path.join(target.absDir, 'SKILL.md'), 'utf8');
    const folderName = path.basename(target.absDir);
    const parsed = parseSkillMd(text, { folderName });
    const errors = parsed.issues.filter((issue) => issue.level === 'error');
    if (errors.length > 0 || parsed.frontmatter.name !== folderName) {
      throw new AgentHubError(
        'VALIDATION',
        `${target.lockPath}/SKILL.md is invalid after install: ${errors[0]?.message ?? `name is not ${folderName}`}`,
      );
    }
    if (!this.isWritable(scope, target.dir)) {
      throw new AgentHubError(
        'VALIDATION',
        `${target.dir} is not a folder agenthub installs into at ${scope} scope`,
      );
    }
    for (const agent of target.agents) {
      if (!this.deps.agents.reads(agent, scope, target.dir)) {
        throw new AgentHubError(
          'INCOMPATIBLE',
          `${agent} does not read skills from ${target.dir} at ${scope} scope`,
        );
      }
    }
  }

  /**
   * Undo a transaction in reverse. Returns problems; the journal is kept when any remain.
   * Progress is written back to the journal after every step, so undoing the same journal again
   * (an interrupted undo, a later recover()) never repeats a step that already happened.
   * `fromRecovery`: the journal comes from disk, so nothing is deleted unless its contents prove
   * it is the copy this transaction installed.
   */
  private async undoTransaction(
    guard: WriteGuard,
    journal: Journal,
    fromRecovery: boolean,
  ): Promise<string[]> {
    const problems: string[] = [];
    const home = this.deps.agenthubHome;
    const persist = await fsu.exists(journalFile(home, journal.txid));
    for (const step of [...journal.steps].reverse()) {
      try {
        await this.undoStep(guard, journal, step, fromRecovery);
      } catch (error) {
        problems.push(`${step.absDir}: ${errorText(error)}`);
      }
      if (persist) {
        try {
          await writeJournal(guard, home, journal);
        } catch (error) {
          problems.push(`${journalFile(home, journal.txid)}: ${errorText(error)}`);
        }
      }
    }
    try {
      await this.restoreLockEntry(guard, journal);
    } catch (error) {
      problems.push(`${journal.lockFile}: ${errorText(error)}`);
    }
    if (problems.length > 0) return problems;
    for (const dir of journal.stagingDirs) {
      try {
        await fsu.removeTree(guard, dir);
      } catch (error) {
        problems.push(`${dir}: ${errorText(error)}`);
      }
    }
    const created = [...new Set(journal.createdDirs)].sort((a, b) => b.length - a.length);
    await fsu.removeEmptyDirs(guard, created);
    if (problems.length === 0) await deleteJournal(guard, home, journal.txid);
    return problems;
  }

  /**
   * Put one target back: remove the new copy if it is (provably) there, then move the parked
   * previous folder back. Marks the step undone in the journal object.
   */
  private async undoStep(
    guard: WriteGuard,
    journal: Journal,
    step: JournalStep,
    fromRecovery: boolean,
  ): Promise<void> {
    const kind = await fsu.pathKind(step.absDir);
    const backupExists = step.backup !== undefined && (await fsu.exists(step.backup));
    const stagedExists = step.staged !== undefined && (await fsu.exists(step.staged));
    if (kind !== 'missing') {
      // The folder at absDir can only be the new copy when the previous one was parked (replace)
      // or the staged copy has left staging (create).
      const mayBeNew = step.backup !== undefined ? backupExists : step.swapped || !stagedExists;
      let isNew = false;
      if (mayBeNew) {
        if (!fromRecovery && step.swapped) isNew = true;
        else if (kind === 'dir' && journal.newEntry !== null) {
          const files = journal.newEntry.files;
          isNew = sameRecord(await hashSkillDir(step.absDir, files), files);
        }
      }
      if (isNew) await fsu.removeTree(guard, step.absDir);
      else if (backupExists) {
        throw new AgentHubError(
          'CONFLICT',
          `cannot move the previous copy back: ${step.absDir} exists and is not the copy agenthub installed (the previous copy is in ${step.backup})`,
        );
      }
    }
    step.swapped = false;
    if (step.backup !== undefined && backupExists) {
      if (await fsu.exists(step.absDir)) {
        throw new AgentHubError(
          'CONFLICT',
          `cannot move the previous copy back: ${step.absDir} exists`,
        );
      }
      await fsu.renameWithRetry(guard, step.backup, step.absDir);
    }
    if (step.backup !== undefined && !(await fsu.exists(step.backup))) delete step.backup;
  }

  /**
   * Put this skill's lock entry back to what it was before the transaction, if the transaction
   * wrote it. Other skills' entries are left alone (they may have changed since).
   */
  private async restoreLockEntry(guard: WriteGuard, journal: Journal): Promise<void> {
    const current = await fsu.readTextOrNull(journal.lockFile);
    if (current === null || current === journal.previousLockText) return;
    if (journal.newEntry === null) return;
    let lock: LockFile;
    try {
      lock = parseLock(current, journal.lockFile);
    } catch {
      return;
    }
    if (entryKey(own(lock.skills, journal.name)) !== entryKey(journal.newEntry)) return;
    let previousLock: LockFile | null = null;
    if (journal.previousLockText !== null) {
      try {
        previousLock = parseLock(journal.previousLockText, journal.lockFile);
      } catch {
        previousLock = null;
      }
    }
    const previous = previousLock ? own(previousLock.skills, journal.name) : undefined;
    if (previous) lock.skills[journal.name] = previous;
    else delete lock.skills[journal.name];
    // Nothing else changed: put the exact previous bytes back (or remove a lock we created).
    const unchangedOtherwise =
      (previousLock === null && Object.keys(lock.skills).length === 0) ||
      (previousLock !== null && serializeLock(previousLock) === serializeLock(lock));
    if (unchangedOtherwise) {
      if (journal.previousLockText === null) await fsu.removeFile(guard, journal.lockFile);
      else await fsu.writeFileAtomic(guard, journal.lockFile, journal.previousLockText);
      return;
    }
    await writeLock(guard, journal.lockFile, lock);
  }

  private snapshotBase(scope: Scope, name: string, projectRoot = this.projectRoot): string {
    return path.join(this.deps.agenthubHome, 'snapshots', scopeId(scope, projectRoot), name);
  }

  /**
   * Save `entry`'s files as the snapshot for scope+name (only the newest one is kept). The files
   * come from the first candidate folder that still matches the entry, else from the cache.
   */
  private async writeSnapshot(
    guard: WriteGuard,
    scope: Scope,
    name: string,
    entry: LockEntry,
    candidates: string[],
    txid: string,
    projectRoot = this.projectRoot,
  ): Promise<string | undefined> {
    const base = this.snapshotBase(scope, name, projectRoot);
    const temp = path.join(base, `.tmp-${txid}`);
    const filesDir = path.join(temp, 'files');
    let wrote = false;
    for (const dir of candidates) {
      if ((await fsu.pathKind(dir)) !== 'dir') continue;
      const hashes = await fsu.hashInstalledDir(dir);
      if (!Object.entries(entry.files).every(([file, hash]) => hashes[file] === hash)) continue;
      await fsu.copyFiles(guard, dir, filesDir, Object.keys(entry.files));
      wrote = true;
      break;
    }
    if (!wrote) {
      const cached = await this.readCached(entry.digest, name);
      if (cached) {
        await fsu.writePackageFiles(guard, filesDir, cached.files);
        wrote = true;
      }
    }
    if (!wrote) {
      await fsu.removeTree(guard, temp);
      return undefined;
    }
    await fsu.writeFileAtomic(
      guard,
      path.join(temp, 'entry.json'),
      `${JSON.stringify(sortKeysDeep(entry), null, 2)}\n`,
    );
    for (const old of await fsu.listDir(base)) {
      if (old !== `.tmp-${txid}`) await fsu.removeTree(guard, path.join(base, old));
    }
    const finalName = isSafeVersionName(entry.version)
      ? entry.version
      : entry.digest.slice('sha256:'.length, 'sha256:'.length + 16);
    const final = path.join(base, finalName);
    await fsu.renameWithRetry(guard, temp, final);
    return final;
  }

  private cacheFile(digest: string): string {
    return path.join(
      this.deps.agenthubHome,
      'cache',
      'sha256',
      `${digest.slice('sha256:'.length)}.skillpkg`,
    );
  }

  private async cachePackage(pkg: SkillPackage): Promise<void> {
    const file = this.cacheFile(pkg.digest);
    if (await fsu.exists(file)) return;
    const guard = new WriteGuard([this.deps.agenthubHome]);
    await fsu.writeFileAtomic(guard, file, packSkill(pkg));
  }

  private async readCached(digest: string, name: string): Promise<SkillPackage | null> {
    const file = this.cacheFile(digest);
    try {
      const bytes = new Uint8Array(await fs.readFile(file));
      return readSkillArchive(bytes, { expectedDigest: digest, folderName: name });
    } catch {
      return null;
    }
  }

  private async audit(event: Record<string, unknown> & { action: AuditAction }): Promise<void> {
    const guard = new WriteGuard([this.deps.agenthubHome]);
    const line = JSON.stringify({ ts: this.now().toISOString(), ...event });
    await fsu.appendFileGuarded(guard, path.join(this.deps.agenthubHome, 'audit.log'), `${line}\n`);
  }

  // -------------------------------------------------------------------------
  // Restore, remove, verify, list
  // -------------------------------------------------------------------------

  private async readFilesFrom(dir: string, files: string[]): Promise<RawFile[]> {
    const out: RawFile[] = [];
    for (const file of files) {
      out.push({
        path: file,
        content: new Uint8Array(await fs.readFile(path.join(dir, ...file.split('/')))),
      });
    }
    return out;
  }

  /**
   * What the registry says about a lock entry installed from it. The entry must come from the
   * configured registry (CONFLICT naming both otherwise); a revoked or quarantined version, or a
   * registry copy with other contents, becomes a blocker. When the registry cannot be asked, the
   * plan says so in a hint.
   */
  private async registryCheck(
    scope: Scope,
    name: string,
    entry: LockEntry,
  ): Promise<{
    registry: RegistrySource | null;
    version?: RegistryVersion;
    blockers: Blocker[];
    hints: string[];
  }> {
    const out: {
      registry: RegistrySource | null;
      version?: RegistryVersion;
      blockers: Blocker[];
      hints: string[];
    } = {
      registry: null,
      blockers: [],
      hints: [],
    };
    if (entry.source !== 'registry') return out;
    const registry = this.registryOrNull(scope);
    const label = `${name}@${entry.version}`;
    if (registry === null) {
      out.hints.push(
        `could not check whether ${label} was revoked: no registry is configured (it was installed from ${entry.registry ?? 'an unknown registry'})`,
      );
      return out;
    }
    if (!sameRegistry(entry.registry, registry.id)) {
      throw new AgentHubError(
        'CONFLICT',
        `${name} was installed from ${entry.registry ?? 'an unknown registry'}, but the configured registry is ${registry.id} — configure ${entry.registry ?? 'that registry'} or reinstall ${name} explicitly`,
        { recorded: entry.registry, configured: registry.id },
      );
    }
    out.registry = registry;
    let versions: RegistryVersion[];
    try {
      versions = await registry.listVersions(name);
    } catch (error) {
      if (isAgentHubError(error) && ['NOT_FOUND', 'REGISTRY', 'IO'].includes(error.code)) {
        out.hints.push(
          `could not check whether ${label} was revoked: ${errorText(error)} — check again with "agenthub update --check" when the registry is reachable`,
        );
        return out;
      }
      throw error;
    }
    const match = versions.find((v) => sameVersion(v.version, entry.version));
    if (match === undefined) {
      out.hints.push(`${label} is no longer listed by ${registry.id}`);
      return out;
    }
    if (match.digest !== entry.digest) {
      out.blockers.push({
        code: 'CONFLICT',
        message: `the lock records ${entry.digest} for ${label}, but ${registry.id} publishes ${match.digest}`,
      });
    } else if (match.status !== 'active') {
      const reason = match.revokedReason ? `: ${match.revokedReason}` : '';
      out.blockers.push({
        code: 'REVOKED',
        message: `version ${match.version} of ${name} is ${match.status}${reason}`,
      });
    } else {
      out.version = match;
    }
    return out;
  }

  /** The exact package behind a lock entry: an intact installed copy, the cache, or the registry. */
  private async packageForEntry(
    scope: Scope,
    name: string,
    entry: LockEntry,
    check: { registry: RegistrySource | null; version?: RegistryVersion },
  ): Promise<{ pkg: SkillPackage; from: string }> {
    for (const lockPath of Object.keys(entry.paths)) {
      const { absDir } = this.resolveLockPath(scope, lockPath, name);
      if ((await fsu.pathKind(absDir)) !== 'dir') continue;
      const hashes = await fsu.hashInstalledDir(absDir);
      if (!Object.entries(entry.files).every(([file, hash]) => hashes[file] === hash)) continue;
      const pkg = buildSkillPackage(await this.readFilesFrom(absDir, Object.keys(entry.files)), {
        folderName: name,
      });
      if (pkg.digest === entry.digest)
        return { pkg: withVersion(pkg, entry.version), from: absDir };
    }
    const cached = await this.readCached(entry.digest, name);
    if (cached)
      return { pkg: withVersion(cached, entry.version), from: this.cacheFile(entry.digest) };
    if (entry.source === 'registry' && check.registry !== null && check.version !== undefined) {
      const { pkg } = await this.downloadVerified(check.registry, name, check.version);
      return { pkg: withVersion(pkg, entry.version), from: check.registry.id };
    }
    throw new AgentHubError(
      'NOT_FOUND',
      `cannot restore ${name}@${entry.version}: no intact installed copy, cache entry or registry source`,
    );
  }

  async planRestore(
    scope: Scope,
    opts: { dev?: boolean; force?: boolean } = {},
  ): Promise<InstallPlan[]> {
    const scopeRoot = this.scopeRoot(scope);
    const lock = await readLock(this.lockFile(scope));
    const detected = await this.deps.agents.detect();
    const configHints = this.configHints(scope);
    const plans: InstallPlan[] = [];
    for (const name of Object.keys(lock.skills).sort()) {
      const entry = lock.skills[name] as LockEntry;
      const fixedTargets = Object.entries(entry.paths).map(([lockPath, agents]) => ({
        dir: this.resolveLockPath(scope, lockPath, name).dir,
        agents: [...agents],
      }));
      const check = await this.registryCheck(scope, name, entry);
      const registrySource: InstallPlan['source'] = {
        kind: 'registry',
        name,
        range: entry.version,
        ...(entry.registry ? { registry: entry.registry } : {}),
      };
      let found: { pkg: SkillPackage; from: string };
      try {
        found = await this.packageForEntry(scope, name, entry, check);
      } catch (error) {
        if (check.blockers.length === 0) throw error;
        plans.push(
          await this.stubPlan({
            name,
            skill: entry,
            source: registrySource,
            scope,
            scopeRoot,
            agents: [],
            blockers: check.blockers,
            hints: [...configHints, ...check.hints],
            dev: opts.dev ?? false,
            force: opts.force ?? false,
          }),
        );
        continue;
      }
      const { pkg, from } = found;
      const source: InstallPlan['source'] =
        entry.source === 'registry'
          ? registrySource
          : { kind: from.endsWith('.skillpkg') ? 'file' : 'dir', path: from };
      plans.push(
        await this.buildPlan({
          pkg,
          source,
          lockSource: entry.source,
          registry: entry.registry,
          scope,
          agents: [],
          detected,
          fixedTargets,
          dev: opts.dev ?? false,
          force: opts.force ?? false,
          hints: [...configHints, ...check.hints],
          blockers: check.blockers,
        }),
      );
    }
    return plans;
  }

  async restore(scope: Scope, opts: RestoreOptions = {}): Promise<InstallResult[]> {
    const plans = await this.planRestore(scope, {
      ...(opts.dev === undefined ? {} : { dev: opts.dev }),
      ...(opts.force === undefined ? {} : { force: opts.force }),
    });
    // Nothing is written unless every entry can be restored and every confirmation was given.
    for (const plan of plans) {
      const blocked = blockerError(plan);
      if (blocked) {
        throw new AgentHubError(
          blocked.code,
          `${plan.skill.name}: ${blocked.message}`,
          blocked.details,
        );
      }
    }
    for (const plan of plans) {
      if (!plan.needsConfirmation) continue;
      if (opts.confirm === undefined) {
        throw new AgentHubError(
          'USAGE',
          `${plan.skill.name} ${plan.skill.version} needs confirmation before it is restored (${describeConfirmation(plan)}); review it with "agenthub install ${plan.skill.name}"`,
          { plan },
        );
      }
      if (!(await opts.confirm(plan))) {
        throw new AgentHubError('CANCELLED', `restore cancelled at ${plan.skill.name}`);
      }
    }
    return this.exclusive(async () => {
      const results: InstallResult[] = [];
      for (const plan of plans) results.push(await this.applyLocked(plan));
      return results;
    });
  }

  async remove(
    name: string,
    scope: Scope,
    opts: { force?: boolean; dryRun?: boolean } = {},
  ): Promise<RemoveResult> {
    if (opts.dryRun) return this.removeLocked(name, scope, opts);
    return this.exclusive(() => this.removeLocked(name, scope, opts));
  }

  private async removeLocked(
    name: string,
    scope: Scope,
    opts: { force?: boolean; dryRun?: boolean },
  ): Promise<RemoveResult> {
    const lockFile = this.lockFile(scope);
    const lock = await readLock(lockFile);
    const entry = own(lock.skills, name);
    if (!entry) throw new AgentHubError('NOT_FOUND', `${name} is not installed at ${scope} scope`);
    const targets = Object.keys(entry.paths).map((lockPath) => ({
      lockPath,
      ...this.resolveLockPath(scope, lockPath, name),
    }));
    const guard = this.guard(
      scope,
      targets.map((t) => t.absDir),
    );
    for (const target of targets) {
      if (!(await this.contained(scope, target.absDir))) {
        throw new AgentHubError(
          'CONFLICT',
          `${target.lockPath} resolves outside the project through a symlinked folder; remove it by hand`,
        );
      }
    }
    const dryRun = opts.dryRun ?? false;
    const removed: string[] = [];
    const kept: string[] = [];

    if (!dryRun) {
      try {
        await this.writeSnapshot(
          guard,
          scope,
          name,
          entry,
          targets.map((t) => t.absDir),
          newTxid(this.now()),
        );
      } catch {
        // A missing snapshot only limits rollback; removal proceeds.
      }
    }

    for (const target of targets) {
      const kind = await fsu.pathKind(target.absDir);
      if (kind === 'missing') continue;
      if (kind !== 'dir') {
        if (opts.force) {
          if (!dryRun) await fsu.removeFile(guard, target.absDir);
          removed.push(target.lockPath);
        } else {
          kept.push(target.lockPath);
        }
        continue;
      }
      if (opts.force) {
        if (!dryRun) await fsu.removeTree(guard, target.absDir);
        removed.push(target.lockPath);
        continue;
      }
      const statuses = fsu.diffFiles(entry.files, await fsu.hashInstalledDir(target.absDir));
      for (const status of statuses) {
        const junk = status.status === 'extra' && fsu.isOsJunk(status.path);
        if (status.status === 'ok' || junk) {
          if (!dryRun)
            await fsu.removeFile(guard, path.join(target.absDir, ...status.path.split('/')));
        } else if (status.status !== 'missing') {
          kept.push(`${target.lockPath}/${status.path}`);
        }
      }
      if (!dryRun) await this.removeEmptyTree(guard, target.absDir);
      const gone = dryRun
        ? statuses.every(
            (s) =>
              s.status === 'ok' ||
              s.status === 'missing' ||
              (s.status === 'extra' && fsu.isOsJunk(s.path)),
          )
        : !(await fsu.exists(target.absDir));
      if (gone) removed.push(target.lockPath);
    }

    if (!dryRun) {
      delete lock.skills[name];
      await this.writeScopeLock(guard, scope, lockFile, lock);
      await this.audit({
        action: 'remove',
        name,
        version: entry.version,
        digest: entry.digest,
        scope,
        targets: removed,
        kept,
        dev: false,
        result: 'ok',
      });
    }
    return { name, scope, removed, kept };
  }

  /** Remove empty directories bottom-up (never descending into links). */
  private async removeEmptyTree(guard: WriteGuard, dir: string): Promise<void> {
    if ((await fsu.pathKind(dir)) !== 'dir') return;
    for (const child of await fsu.listDir(dir))
      await this.removeEmptyTree(guard, path.join(dir, child));
    await fsu.removeEmptyDirs(guard, [dir]);
  }

  private async verifyEntry(scope: Scope, name: string, entry: LockEntry): Promise<VerifyReport> {
    const targets: VerifyReport['targets'] = [];
    for (const lockPath of Object.keys(entry.paths)) {
      const { absDir } = this.resolveLockPath(scope, lockPath, name);
      const kind = await fsu.pathKind(absDir);
      const files =
        kind === 'dir'
          ? fsu.diffFiles(entry.files, await hashSkillDir(absDir, entry.files))
          : fsu.diffFiles(entry.files, {});
      targets.push({ lockPath, ok: files.every((f) => f.status === 'ok'), files });
    }
    return {
      name,
      scope,
      version: entry.version,
      digest: entry.digest,
      ok: targets.every((t) => t.ok),
      targets,
    };
  }

  async verify(scope: Scope, name?: string): Promise<VerifyReport[]> {
    return (await this.inspectAll(scope, name)).map((inspection) => inspection.verify);
  }

  /** Verify + rescan + approval state of one entry. */
  private async inspectEntry(
    scope: Scope,
    name: string,
    entry: LockEntry,
  ): Promise<InstalledInspection> {
    const verify = await this.verifyEntry(scope, name, entry);
    const scan = await this.scanInstalled(scope, name, entry);
    const approval = approvalState(entry, scan?.report ?? null, scan?.strict.outcome ?? null);
    verify.capabilities = {
      state: approval.state,
      stale: approval.stale,
      lockMatches: approval.lockMatches,
      checked: approval.checked,
      missingBlock: entry.capabilityDigest === undefined,
    };
    return {
      name,
      scope,
      entry,
      verify,
      current: scan?.report ?? null,
      policy: scan?.strict ?? null,
      approval,
    };
  }

  private async inspectAll(scope: Scope, name?: string): Promise<InstalledInspection[]> {
    const lock = await readLock(this.lockFile(scope));
    if (name !== undefined) {
      const entry = own(lock.skills, name);
      if (!entry)
        throw new AgentHubError('NOT_FOUND', `${name} is not installed at ${scope} scope`);
      return [await this.inspectEntry(scope, name, entry)];
    }
    const out: InstalledInspection[] = [];
    for (const skill of Object.keys(lock.skills).sort()) {
      out.push(await this.inspectEntry(scope, skill, lock.skills[skill] as LockEntry));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Approvals, diff and in-place records (trust features §4, §6)
  // -------------------------------------------------------------------------

  async approve(
    name: string,
    scope: Scope,
    input: ApprovalInput = {},
    opts: { dryRun?: boolean } = {},
  ): Promise<ApproveResult> {
    const run = async (): Promise<ApproveResult> => {
      const lockFile = this.lockFile(scope);
      const lock = await readLock(lockFile);
      const entry = own(lock.skills, name);
      if (!entry)
        throw new AgentHubError('NOT_FOUND', `${name} is not installed at ${scope} scope`);
      if (entry.quarantine !== undefined) {
        throw new AgentHubError(
          'POLICY_BLOCKED',
          `${name} is quarantined in the lock${quarantineText(entry)}; it cannot be approved`,
        );
      }
      const verify = await this.verifyEntry(scope, name, entry);
      if (!verify.ok || verify.targets.length === 0) {
        throw new AgentHubError(
          'DRIFT',
          `${name}: the installed files differ from the lock — only bytes that verify can be approved (see "agenthub verify ${name}")`,
          { report: verify },
        );
      }
      const pkg = await this.installedPackage(scope, name, entry);
      if (pkg === null) {
        throw new AgentHubError('DRIFT', `${name}: no intact installed copy to approve`);
      }
      const { strict, report } = this.evaluatePolicy(pkg, false);
      if (strict.outcome === 'block') {
        throw new AgentHubError(
          'POLICY_BLOCKED',
          `${name} cannot be approved: ${describeBlock(strict)}`,
          { findings: strict.findings.filter((f) => f.decision === 'BLOCK') },
        );
      }
      const status = approvalState(entry, report, strict.outcome);
      const before = approvedBaseline(entry, report, status);
      const newlyApproved = expansionTokens(diffCapabilities(before, report.set));
      const approval: LockApproval = {
        digest: entry.digest,
        capabilityDigest: report.digest,
        rulesetDigest: report.rulesetDigest,
        approvedAt: this.now().toISOString(),
      };
      if (input.by !== undefined) approval.approvedBy = input.by;
      if (input.note !== undefined) approval.note = input.note;
      const result: ApproveResult = {
        name,
        scope,
        version: entry.version,
        approval,
        previousState: status.state,
        newlyApproved,
        report,
        dryRun: opts.dryRun === true,
      };
      if (opts.dryRun === true) return result;
      lock.skills[name] = { ...entry, ...capabilityBlock(report), approval };
      const guard = this.guard(scope);
      await this.writeScopeLock(guard, scope, lockFile, lock);
      await this.audit({
        action: 'approve',
        name,
        version: entry.version,
        digest: entry.digest,
        scope,
        capabilityDigest: report.digest,
        rulesetDigest: report.rulesetDigest,
        approval: input.mode ?? 'command',
        newlyApproved,
        result: 'ok',
      }).catch(() => undefined);
      return result;
    };
    return opts.dryRun === true ? run() : this.exclusive(run);
  }

  async diff(
    name: string,
    scope: Scope,
    opts: { to?: string; channel?: 'stable' | 'beta' } = {},
  ): Promise<SkillDiff> {
    const lock = await readLock(this.lockFile(scope));
    const entry = own(lock.skills, name);
    if (!entry) throw new AgentHubError('NOT_FOUND', `${name} is not installed at ${scope} scope`);
    if (entry.source !== 'registry') {
      throw new AgentHubError(
        'USAGE',
        `${name} was not installed from a registry; compare a local version with "agenthub install <folder> --dry-run"`,
      );
    }
    const registry = this.registry(scope);
    if (!sameRegistry(entry.registry, registry.id)) {
      throw new AgentHubError(
        'CONFLICT',
        `${name} was installed from ${entry.registry ?? 'an unknown registry'}, but the configured registry is ${registry.id}`,
        { recorded: entry.registry, configured: registry.id },
      );
    }
    const channel = opts.channel ?? this.config(scope).effective.channel ?? 'stable';
    const versions = await registry.listVersions(name);
    const outcome = resolveVersion(versions, {
      range: opts.to ?? '*',
      channel,
      agents: entry.installedTargets,
    });
    if (outcome.kind === 'none') throw new AgentHubError('NOT_FOUND', `${name}: ${outcome.reason}`);
    if (outcome.kind === 'revoked') {
      throw new AgentHubError(
        'NOT_FOUND',
        `${name}: version ${outcome.version.version} is revoked${outcome.reason ? `: ${outcome.reason}` : ''}`,
      );
    }
    const { pkg } = await this.downloadVerified(registry, name, outcome.version);
    const { report } = this.evaluatePolicy(pkg, false);
    const { scan, status, baseline } = await this.baselineOf(scope, name, entry);
    const same = pkg.digest === entry.digest;
    const unapproved = diffCapabilities(baseline, report.set);
    return {
      name,
      scope,
      from: {
        version: entry.version,
        digest: entry.digest,
        capabilityDigest: scan?.report.digest ?? entry.capabilityDigest ?? null,
      },
      to: { version: pkg.version, digest: pkg.digest, capabilityDigest: report.digest },
      rulesetDigest: report.rulesetDigest,
      baseline: scan === null ? 'unavailable' : status.state,
      delta: diffCapabilities(scan?.report.set ?? recordedSet(entry), report.set),
      unapproved: same ? [] : expansionTokens(unapproved),
      approvalRequired: !same && unapproved.expansion,
      candidate: report,
      files: summarizeFileChanges(
        { files: entry.files, skillMd: scan === null ? null : skillMdText(scan.pkg) },
        { files: pkg.fileHashes, skillMd: skillMdText(pkg) },
      ),
    };
  }

  async list(scope?: Scope): Promise<ListedSkill[]> {
    const out: ListedSkill[] = [];
    for (const current of scope ? [scope] : this.scopes()) {
      const lock = await readLock(this.lockFile(current));
      for (const name of Object.keys(lock.skills).sort()) {
        const entry = lock.skills[name] as LockEntry;
        const report = await this.verifyEntry(current, name, entry);
        const anyMissing = report.targets.some(
          (t) => t.files.length > 0 && t.files.every((f) => f.status === 'missing'),
        );
        const listed: ListedSkill = {
          name,
          version: entry.version,
          scope: current,
          agents: [...entry.installedTargets],
          source: entry.source,
          registry: entry.registry,
          status: anyMissing ? 'missing' : report.ok ? 'ok' : 'drift',
          installedAt: entry.installedAt,
          approval: recordedApproval(entry, this.rulesetDigest()),
        };
        if (entry.capabilityDigest !== undefined) listed.capabilityDigest = entry.capabilityDigest;
        if (listed.approval !== 'unapproved' && entry.approval !== undefined) {
          listed.approvedAt = entry.approval.approvedAt;
          if (entry.approval.approvedBy !== undefined) {
            listed.approvedBy = entry.approval.approvedBy;
          }
        }
        out.push(listed);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Updates and rollback
  // -------------------------------------------------------------------------

  async checkUpdates(
    scope: Scope,
    names?: string[],
    opts: { channel?: 'stable' | 'beta'; capabilities?: boolean } = {},
  ): Promise<UpdateCandidate[]> {
    const candidates = await this.checkUpdatesBase(scope, names, opts);
    if (opts.capabilities !== true) return candidates;
    const registry = this.registryOrNull(scope);
    if (registry === null) return candidates;
    const lock = await readLock(this.lockFile(scope));
    const channel = opts.channel ?? this.config(scope).effective.channel ?? 'stable';
    for (const candidate of candidates) {
      const entry = own(lock.skills, candidate.name);
      if (candidate.status !== 'available' || entry === undefined) continue;
      const versions = await registry.listVersions(candidate.name);
      const outcome = resolveVersion(versions, {
        range: candidate.latestCompatible ?? '*',
        channel,
        agents: entry.installedTargets,
      });
      if (outcome.kind !== 'ok') continue;
      // Downloaded and verified in memory; nothing is written.
      const { pkg } = await this.downloadVerified(registry, candidate.name, outcome.version);
      const { report } = this.evaluatePolicy(pkg, false);
      const { scan, status, baseline } = await this.baselineOf(scope, candidate.name, entry);
      const unapproved = diffCapabilities(baseline, report.set);
      const installedSet = scan?.report.set ?? recordedSet(entry);
      const delta = diffCapabilities(installedSet, report.set);
      const removed =
        Object.values(delta.removed).reduce((sum, list) => sum + list.length, 0) +
        delta.externals.removed.length;
      candidate.change = {
        expansion: unapproved.expansion,
        unapproved: expansionTokens(unapproved),
        removed,
        state: scan === null ? 'unavailable' : status.state,
      };
    }
    return candidates;
  }

  private async checkUpdatesBase(
    scope: Scope,
    names: string[] | undefined,
    opts: { channel?: 'stable' | 'beta' },
  ): Promise<UpdateCandidate[]> {
    const lock = await readLock(this.lockFile(scope));
    const registry = this.registryOrNull(scope);
    const channel = opts.channel ?? this.config(scope).effective.channel ?? 'stable';
    const out: UpdateCandidate[] = [];
    const selected = names && names.length > 0 ? names : Object.keys(lock.skills).sort();
    for (const name of selected) {
      const entry = own(lock.skills, name);
      if (!entry)
        throw new AgentHubError('NOT_FOUND', `${name} is not installed at ${scope} scope`);
      const base = { name, scope, current: entry.version };
      const none = { latest: null, latestCompatible: null };
      if (entry.source !== 'registry') {
        out.push({
          ...base,
          ...none,
          status: 'not-in-registry',
          reason: `installed from a local ${entry.source === 'dir' ? 'folder' : 'package file'}`,
        });
        continue;
      }
      if (!registry) {
        out.push({ ...base, ...none, status: 'not-in-registry', reason: 'no registry configured' });
        continue;
      }
      if (!sameRegistry(entry.registry, registry.id)) {
        out.push({
          ...base,
          ...none,
          status: 'registry-mismatch',
          reason: `installed from ${entry.registry ?? 'an unknown registry'}, the configured registry is ${registry.id}`,
        });
        continue;
      }
      let versions: RegistryVersion[];
      try {
        versions = await registry.listVersions(name);
      } catch (error) {
        if (isAgentHubError(error) && error.code === 'NOT_FOUND') {
          out.push({ ...base, ...none, status: 'not-in-registry', reason: error.message });
          continue;
        }
        throw error;
      }
      const latest = latestVersion(versions, channel);
      const compatible = resolveVersion(versions, {
        range: '*',
        channel,
        agents: entry.installedTargets,
      });
      const latestCompatible = compatible.kind === 'ok' ? compatible.version.version : null;
      const found = { ...base, latest, latestCompatible };
      const current = versions.find((v) => sameVersion(v.version, entry.version));
      const drift = !(await this.verifyEntry(scope, name, entry)).ok;
      if (current !== undefined && current.digest !== entry.digest) {
        out.push({
          ...found,
          status: 'digest-mismatch',
          reason: `the lock records ${entry.digest}, the registry publishes ${current.digest} for ${current.version}`,
        });
      } else if (current?.status === 'revoked') {
        out.push({
          ...found,
          status: 'current-revoked',
          reason: `version ${entry.version} is revoked${current.revokedReason ? `: ${current.revokedReason}` : ''}`,
        });
      } else if (current?.status === 'quarantined') {
        out.push({
          ...found,
          status: 'current-quarantined',
          reason: `version ${entry.version} is quarantined by the registry`,
        });
      } else if (drift) {
        out.push({ ...found, status: 'drift', reason: 'installed files differ from the lock' });
      } else if (
        latestCompatible !== null &&
        semver.valid(entry.version) !== null &&
        semver.gt(latestCompatible, entry.version)
      ) {
        out.push({ ...found, status: 'available' });
      } else {
        out.push({ ...found, status: 'up-to-date' });
      }
    }
    return out;
  }

  async planUpdate(
    name: string,
    scope: Scope,
    opts: { range?: string; dev?: boolean; force?: boolean; channel?: 'stable' | 'beta' } = {},
  ): Promise<InstallPlan | null> {
    const lock = await readLock(this.lockFile(scope));
    const entry = own(lock.skills, name);
    if (!entry) throw new AgentHubError('NOT_FOUND', `${name} is not installed at ${scope} scope`);
    if (entry.source !== 'registry') {
      throw new AgentHubError(
        'CONFLICT',
        `${name} was installed from a local ${entry.source === 'dir' ? 'folder' : 'package file'}, not a registry — install it from the registry explicitly to switch`,
      );
    }
    const registry = this.registry(scope);
    if (!sameRegistry(entry.registry, registry.id)) {
      throw new AgentHubError(
        'CONFLICT',
        `${name} was installed from ${entry.registry ?? 'an unknown registry'}, but the configured registry is ${registry.id} — updates only come from the registry recorded in the lock`,
        { recorded: entry.registry, configured: registry.id },
      );
    }
    const channel = opts.channel ?? this.config(scope).effective.channel ?? 'stable';
    const versions = await registry.listVersions(name);
    const outcome = resolveVersion(versions, {
      ...(opts.range === undefined ? {} : { range: opts.range }),
      channel,
      agents: entry.installedTargets,
    });
    const current = versions.find((v) => sameVersion(v.version, entry.version));
    // A revoked/quarantined current version, or registry contents that differ from the lock,
    // always need a reinstall (never "up to date").
    const mustReplace =
      current !== undefined && (current.status !== 'active' || current.digest !== entry.digest);
    if (outcome.kind === 'none') {
      if (mustReplace) throw new AgentHubError('NOT_FOUND', `${name}: ${outcome.reason}`);
      return null;
    }
    const target = outcome.version;
    if (sameVersion(target.version, entry.version) && target.digest === entry.digest) return null;
    if (
      outcome.kind === 'ok' &&
      !mustReplace &&
      semver.valid(entry.version) !== null &&
      semver.lte(target.version, entry.version)
    ) {
      return null;
    }
    return this.plan({
      source: { kind: 'registry', name, range: target.version },
      scope,
      agents: entry.installedTargets,
      dev: opts.dev ?? false,
      force: opts.force ?? false,
      channel,
    });
  }

  async rollback(name: string, scope: Scope): Promise<InstallResult> {
    this.lockFile(scope);
    const base = this.snapshotBase(scope, name);
    const candidates: { dir: string; mtime: number }[] = [];
    for (const child of await fsu.listDir(base)) {
      if (child.startsWith('.')) continue;
      const dir = path.join(base, child);
      const st = await fsu.lstatOrNull(dir);
      if (st?.isDirectory()) candidates.push({ dir, mtime: st.mtimeMs });
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const snapshot = candidates[0];
    if (!snapshot)
      throw new AgentHubError(
        'NOT_FOUND',
        `no snapshot of ${name} at ${scope} scope to roll back to`,
      );
    const entryFile = path.join(snapshot.dir, 'entry.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(entryFile, 'utf8'));
    } catch (error) {
      throw new AgentHubError('VALIDATION', `invalid snapshot ${entryFile}: ${errorText(error)}`);
    }
    const entry = parseLockEntry(raw, entryFile, name);
    const filesDir = path.join(snapshot.dir, 'files');
    const built = buildSkillPackage(await fsu.readTreeFiles(filesDir), { folderName: name });
    if (built.digest !== entry.digest) {
      throw new AgentHubError(
        'INTEGRITY',
        `snapshot ${snapshot.dir} does not match its recorded digest: expected ${entry.digest}, got ${built.digest}`,
      );
    }
    const pkg = withVersion(built, entry.version);
    const fixedTargets = Object.entries(entry.paths).map(([lockPath, agents]) => ({
      dir: this.resolveLockPath(scope, lockPath, name).dir,
      agents: [...agents],
    }));
    // Design 8.1: revoked (and quarantined) versions are never installed, from snapshots either.
    const check = await this.registryCheck(scope, name, entry);
    const plan = await this.buildPlan({
      pkg,
      source:
        entry.source === 'registry'
          ? {
              kind: 'registry',
              name,
              range: entry.version,
              ...(entry.registry ? { registry: entry.registry } : {}),
            }
          : { kind: 'dir', path: filesDir },
      lockSource: entry.source,
      registry: entry.registry,
      scope,
      agents: [],
      detected: await this.deps.agents.detect(),
      fixedTargets,
      dev: false,
      force: false,
      action: 'rollback',
      hints: check.hints,
      blockers: check.blockers,
      carry: entry,
    });
    const blocked = blockerError(plan);
    if (blocked) throw blocked;
    return this.apply(plan);
  }

  // -------------------------------------------------------------------------
  // Recovery and doctor
  // -------------------------------------------------------------------------

  /**
   * A journal comes from disk and is checked against real state, never against itself: its
   * scope root must be the user home or a project (this one, or one whose lock lists the
   * journal's folders), every target must be `<skills folder>/<name>` in that root, staging must
   * be the transaction's own staging folders, and the lock file must be that scope's lock.
   */
  private async journalProblem(file: string, journal: Journal): Promise<string | null> {
    if (path.basename(file) !== `${journal.txid}.json`) {
      return 'the file name does not match its transaction id';
    }
    let root: string;
    let stateDir: string;
    if (journal.scope === 'user') {
      root = this.deps.home;
      stateDir = this.deps.agenthubHome;
      if (!fsu.samePath(journal.scopeRoot, root)) {
        return `scope root ${journal.scopeRoot} is not the user home ${root}`;
      }
    } else {
      root = path.resolve(journal.scopeRoot);
      stateDir = path.join(root, STATE_DIR);
      if (fsu.samePath(stateDir, this.deps.agenthubHome) || fsu.samePath(root, this.deps.home)) {
        return `scope root ${root} is not a project`;
      }
      try {
        assertProjectStateSafe(root);
      } catch (error) {
        return errorText(error);
      }
    }
    if (!fsu.samePath(journal.lockFile, path.join(stateDir, LOCK_FILE))) {
      return `lock file ${journal.lockFile} is not the lock of ${root}`;
    }
    const ownStaging = path.join(stateDir, 'tmp', journal.txid);
    if (!fsu.samePath(journal.stagingRoot, ownStaging)) {
      return `staging folder ${journal.stagingRoot} is not ${ownStaging}`;
    }
    if (journal.newEntry !== null) {
      try {
        parseLockEntry(journal.newEntry, file, journal.name);
      } catch (error) {
        return errorText(error);
      }
    }
    const lockPaths: string[] = [];
    for (const step of journal.steps) {
      const rel = path.relative(root, step.absDir);
      if (rel === '' || path.isAbsolute(rel) || rel.startsWith('..')) {
        return `target outside the scope root: ${step.absDir}`;
      }
      const segments = rel.split(path.sep).join('/');
      const lockPath = journal.scope === 'user' ? `~/${segments}` : segments;
      try {
        const checked = this.checkLockPath(journal.scope, root, lockPath, journal.name);
        if (!fsu.samePath(checked.absDir, step.absDir)) throw new Error('mismatch');
      } catch {
        return `target ${step.absDir} is not a skills folder entry for ${journal.name}`;
      }
      lockPaths.push(lockPath);
    }
    const allowedStaging = [
      ownStaging,
      ...journal.steps.map((step) =>
        path.join(path.dirname(path.dirname(step.absDir)), `.agenthub-tmp-${journal.txid}`),
      ),
    ];
    for (const dir of journal.stagingDirs) {
      if (!allowedStaging.some((allowed) => fsu.samePath(allowed, dir))) {
        return `staging folder outside the state folders: ${dir}`;
      }
    }
    const inStaging = (p: string, kind: 'new' | 'old') =>
      journal.stagingDirs.some(
        (dir) =>
          /^\d+$/.test(path.basename(p)) && fsu.samePath(path.dirname(p), path.join(dir, kind)),
      );
    for (const step of journal.steps) {
      if (step.backup !== undefined && !inStaging(step.backup, 'old'))
        return `backup outside staging: ${step.backup}`;
      if (step.staged !== undefined && !inStaging(step.staged, 'new'))
        return `staged copy outside staging: ${step.staged}`;
    }
    const strictlyInside = (base: string, p: string) =>
      fsu.isWithin(base, p) && !fsu.samePath(base, p);
    for (const dir of journal.createdDirs) {
      if (!strictlyInside(root, dir) && !strictlyInside(this.deps.agenthubHome, dir)) {
        return `created folder outside the scope: ${dir}`;
      }
    }
    // A project other than the current one: only when its own lock lists the journal's folders.
    if (
      journal.scope === 'project' &&
      !(this.projectRoot && fsu.samePath(root, this.projectRoot))
    ) {
      let entry: LockEntry | undefined;
      try {
        entry = own((await readLock(journal.lockFile)).skills, journal.name);
      } catch {
        entry = undefined;
      }
      if (!entry || !lockPaths.every((lockPath) => Object.hasOwn(entry.paths, lockPath))) {
        return `it belongs to the project ${root}; run agenthub inside that project to recover it`;
      }
    }
    return null;
  }

  async recover(): Promise<string[]> {
    const home = this.deps.agenthubHome;
    if ((await fsu.listDir(path.join(home, 'journal'))).length === 0) return [];
    // Never replay a journal while another agenthub process may be writing it.
    const release = await acquireProcessLock(home, { waitMs: 0, now: this.now });
    if (release === null) {
      return ['another agenthub process is running; interrupted transactions were not checked'];
    }
    try {
      return await this.recoverLocked();
    } finally {
      await release().catch(() => undefined);
    }
  }

  private async recoverLocked(): Promise<string[]> {
    const messages: string[] = [];
    const home = this.deps.agenthubHome;
    for (const item of await readJournals(home)) {
      if (!('journal' in item)) {
        messages.push(`skipped unreadable journal ${item.file}: ${item.error}`);
        continue;
      }
      const journal = item.journal;
      if (journal.pid !== process.pid && ownerAlive(journal.pid, journal.host)) {
        messages.push(
          `skipped journal ${item.file}: its transaction is still running (pid ${journal.pid})`,
        );
        continue;
      }
      const problem = await this.journalProblem(item.file, journal);
      if (problem) {
        messages.push(`skipped journal ${item.file}: ${problem}`);
        continue;
      }
      const guard = new WriteGuard([
        home,
        path.dirname(journal.lockFile),
        ...journal.stagingDirs,
        ...journal.steps.map((step) => step.absDir),
      ]);
      if (!journal.committed) {
        const problems = await this.undoTransaction(guard, journal, true);
        messages.push(
          problems.length === 0
            ? `rolled back an interrupted install of ${journal.name} (${journal.steps.length} folder(s) restored)`
            : `could not fully roll back the interrupted install of ${journal.name}: ${problems.join('; ')}`,
        );
        continue;
      }
      try {
        messages.push(...(await this.finishCommitted(guard, journal)));
      } catch (error) {
        messages.push(
          `could not finish the interrupted install of ${journal.name}: ${errorText(error)}`,
        );
      }
    }
    return messages;
  }

  /**
   * A transaction that crashed after its commit point: the lock already holds the new entry.
   * Keep a snapshot of the parked previous copy, then remove staging. The lock is never rewritten
   * here — if it has moved on since, that newer state wins.
   */
  private async finishCommitted(guard: WriteGuard, journal: Journal): Promise<string[]> {
    const messages: string[] = [];
    const lockText = await fsu.readTextOrNull(journal.lockFile);
    const current =
      lockText === null
        ? undefined
        : own(parseLock(lockText, journal.lockFile).skills, journal.name);
    if (journal.newEntry !== null && entryKey(current) !== entryKey(journal.newEntry)) {
      messages.push(
        `the lock entry of ${journal.name} changed after the interrupted install; it was left as it is`,
      );
    }
    let previous: LockEntry | undefined;
    if (journal.previousLockText !== null) {
      try {
        previous = own(parseLock(journal.previousLockText, journal.lockFile).skills, journal.name);
      } catch {
        previous = undefined;
      }
    }
    if (previous && journal.newEntry && previous.digest !== journal.newEntry.digest) {
      const backups: string[] = [];
      for (const step of journal.steps) {
        if (step.backup !== undefined && (await fsu.exists(step.backup))) backups.push(step.backup);
      }
      const root = journal.scope === 'project' ? path.resolve(journal.scopeRoot) : this.projectRoot;
      try {
        await this.writeSnapshot(
          guard,
          journal.scope,
          journal.name,
          previous,
          backups,
          journal.txid,
          root,
        );
      } catch (error) {
        messages.push(
          `could not save a snapshot of ${journal.name}@${previous.version}: ${errorText(error)}`,
        );
      }
    }
    for (const dir of journal.stagingDirs) await fsu.removeTree(guard, dir);
    await deleteJournal(guard, this.deps.agenthubHome, journal.txid);
    messages.push(`finished an interrupted install of ${journal.name}`);
    return messages;
  }

  private async installedManifest(
    scope: Scope,
    name: string,
    entry: LockEntry,
  ): Promise<SkillManifest | null> {
    if (!Object.hasOwn(entry.files, MANIFEST_FILE)) return null;
    for (const lockPath of Object.keys(entry.paths)) {
      const { absDir } = this.resolveLockPath(scope, lockPath, name);
      const text = await fsu.readTextOrNull(path.join(absDir, MANIFEST_FILE)).catch(() => null);
      if (text === null) continue;
      try {
        return parseManifest(text);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** Doctor problems for one entry's capability record and approval (trust features §6.3). */
  private approvalProblems(
    name: string,
    scope: Scope,
    inspection: InstalledInspection,
  ): DoctorProblem[] {
    const { entry, approval } = inspection;
    const label = `${name} (${scope})`;
    const out: DoctorProblem[] = [];
    if (entry.quarantine !== undefined) {
      out.push({
        level: 'error',
        code: 'quarantine.present',
        message: `${label} is quarantined in the lock${quarantineText(entry)}`,
      });
    }
    if (approval.lockMatches === false) {
      out.push({
        level: 'error',
        code: 'lock.capabilities-mismatch',
        message: `${label}: the lock's capability record does not describe the installed files — review the lock change, then run "agenthub approve ${name}"`,
      });
      return out;
    }
    if (entry.capabilityDigest === undefined) {
      out.push({
        level: 'warning',
        code: 'lock.capabilities-missing',
        message: `${label} has no capability record (written by an older agenthub) — review it with "agenthub approve ${name}"`,
      });
    } else if (approval.state === 'stale') {
      out.push({
        level: 'warning',
        code: 'approval.stale',
        message: `${label}: the current scanner rules also see ${approval.stale.join(', ')} — review and run "agenthub approve ${name}"`,
      });
    } else if (approval.state === 'unapproved' && approval.checked) {
      out.push({
        level: 'warning',
        code: 'approval.missing',
        message: `${label} has no capability approval — review it with "agenthub approve ${name}"`,
      });
    }
    return out;
  }

  async doctor(): Promise<DoctorReport> {
    const problems: DoctorProblem[] = [];
    const agents = await this.deps.agents.detect();
    try {
      for (const warning of this.config().warnings) {
        problems.push({ level: 'warning', code: 'config.project-ignored', message: warning });
      }
    } catch (error) {
      problems.push({ level: 'error', code: 'config.invalid', message: errorText(error) });
    }

    const scopes: DoctorReport['scopes'] = [];
    const byScope = new Map<Scope, Record<string, LockEntry>>();
    const tmpDirs: string[] = [];
    const skillsParents = new Set<string>();
    for (const scope of this.scopes()) {
      const root = this.scopeRoot(scope);
      let lockFile: string;
      try {
        lockFile = this.lockFile(scope);
      } catch (error) {
        problems.push({ level: 'error', code: 'state.unsafe', message: errorText(error) });
        continue;
      }
      const lockExists = await fsu.exists(lockFile);
      let skills: Record<string, LockEntry> = {};
      try {
        skills = (await readLock(lockFile)).skills;
        const text = await fsu.readTextOrNull(lockFile);
        if (text !== null && peekLockVersion(text) === 1) {
          problems.push({
            level: 'warning',
            code: 'lock.v1',
            message: `${lockFile} is a version 1 lock; the next command that changes it writes version 2 (upgrade agenthub for the whole team first: older versions cannot read version 2)`,
          });
        }
      } catch (error) {
        problems.push({ level: 'error', code: 'lock.invalid', message: errorText(error) });
      }
      scopes.push({
        scope,
        root,
        lockPath: lockFile,
        lockExists,
        skills: Object.keys(skills).length,
      });
      byScope.set(scope, skills);
      tmpDirs.push(scopeTmpDir(scope, this.loc));

      for (const name of Object.keys(skills).sort()) {
        const entry = skills[name] as LockEntry;
        try {
          const inspection = await this.inspectEntry(scope, name, entry);
          problems.push(...this.approvalProblems(name, scope, inspection));
          const report = inspection.verify;
          for (const target of report.targets) {
            if (target.ok) continue;
            const allMissing = target.files.every((f) => f.status === 'missing');
            const changed = target.files
              .filter((f) => f.status !== 'ok')
              .map((f) => `${f.path} (${f.status})`);
            problems.push({
              level: 'error',
              code: allMissing ? 'skill.missing' : 'skill.drift',
              message: allMissing
                ? `${name} (${scope}): ${target.lockPath} is missing`
                : `${name} (${scope}): ${target.lockPath} differs from the lock: ${changed.join(', ')}`,
            });
          }
          for (const lockPath of Object.keys(entry.paths)) {
            const { absDir } = this.resolveLockPath(scope, lockPath, name);
            skillsParents.add(path.dirname(path.dirname(absDir)));
          }
        } catch (error) {
          problems.push({ level: 'error', code: 'lock.invalid', message: errorText(error) });
          continue;
        }
        const dirs = Object.keys(entry.paths).map(
          (lockPath) => this.resolveLockPath(scope, lockPath, name).dir,
        );
        for (const agent of AGENT_IDS) {
          const seen = dirs.filter((dir) => this.deps.agents.reads(agent, scope, dir));
          if (seen.length > 1) {
            problems.push({
              level: 'warning',
              code: 'skill.duplicate',
              message: `${agent} sees ${name} twice at ${scope} scope (${seen.join(', ')})`,
            });
          }
        }
        const manifest = await this.installedManifest(scope, name, entry);
        for (const check of await this.checkRequirements(manifest)) {
          if (check.ok === false) {
            problems.push({
              level: 'warning',
              code: 'requirement.unmet',
              message: describeRequirement(name, check),
            });
          }
        }
      }
    }

    const project = byScope.get('project');
    const user = byScope.get('user');
    if (project && user) {
      for (const [name, entry] of Object.entries(project)) {
        const other = own(user, name);
        if (other && other.digest !== entry.digest) {
          problems.push({
            level: 'warning',
            code: 'skill.scope-conflict',
            message: `${name} is installed at project scope (${entry.version}) and user scope (${other.version}) with different contents; agents disagree on which one wins`,
          });
        }
      }
    }

    const journals = await readJournals(this.deps.agenthubHome);
    const pendingJournals = journals.map((item) => item.file);
    for (const file of pendingJournals) {
      problems.push({
        level: 'error',
        code: 'journal.pending',
        message: `interrupted transaction ${file} — run any install command to recover it`,
      });
    }
    for (const dir of tmpDirs) {
      for (const child of await fsu.listDir(dir)) {
        problems.push({
          level: 'warning',
          code: 'tmp.leftover',
          message: `leftover staging folder ${path.join(dir, child)}`,
        });
      }
    }
    for (const parent of skillsParents) {
      for (const child of await fsu.listDir(parent)) {
        if (child.startsWith('.agenthub-tmp-')) {
          problems.push({
            level: 'warning',
            code: 'tmp.leftover',
            message: `leftover staging folder ${path.join(parent, child)}`,
          });
        }
      }
    }

    return {
      agents,
      pathTableVersion: this.deps.agents.tableVersion,
      projectRoot: this.projectRoot,
      scopes,
      problems,
      pendingJournals,
      cacheBytes: await fsu.treeSize(path.join(this.deps.agenthubHome, 'cache')),
    };
  }
}

export function createEngine(deps: EngineDeps): Engine {
  return new InstallEngine(deps);
}
