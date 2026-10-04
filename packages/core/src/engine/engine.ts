/**
 * The install engine (design §8): plan → apply as one transaction over every target folder,
 * plus restore, remove, verify, list, update checks, rollback, crash recovery and doctor.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { packSkill, readSkillArchive } from '../archive';
import { AgentHubError, isAgentHubError } from '../errors';
import { archiveDigest } from '../hash';
import { MANIFEST_FILE, parseManifest } from '../manifest';
import { buildSkillPackage, loadSkillFromDir, type RawFile } from '../package';
import { parseSkillMd } from '../skillmd';
import {
  AGENT_IDS,
  type AgentEnvironment,
  type AgentId,
  type LockEntry,
  type LockFile,
  type PolicyResult,
  type Scope,
  type SkillManifest,
  type SkillPackage,
  type TargetFolder,
} from '../types';
import type {
  DoctorProblem,
  DoctorReport,
  Engine,
  EngineDeps,
  InstallPlan,
  InstallRequest,
  InstallResult,
  ListedSkill,
  PlannedTarget,
  RegistrySource,
  RegistryVersion,
  RemoveResult,
  RequirementCheck,
  UpdateCandidate,
  VerifyReport,
} from './api';
import { type LoadedConfig, loadConfig } from './config';
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
import { emptyLock, parseLock, parseLockEntry, readLock, sortKeysDeep, writeLock } from './lock';
import { latestVersion, resolveVersion } from './resolve';
import {
  ensureStateGitignore,
  findProjectRoot,
  lockFilePath,
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

type AuditAction = 'install' | 'update' | 'rollback' | 'remove' | 'override';

interface PlanInternals {
  pkg: SkillPackage;
  action: 'install' | 'update' | 'rollback';
  lockSource: LockEntry['source'];
  registry: string | null;
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

/** Files operating systems drop into folders; never treated as hand edits that block an update. */
const OS_JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

function isOsJunk(file: string): boolean {
  return OS_JUNK.has(file.slice(file.lastIndexOf('/') + 1));
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

  private stateDir(scope: Scope): string {
    this.scopeRoot(scope);
    return scopeStateDir(scope, this.loc);
  }

  private lockFile(scope: Scope): string {
    this.scopeRoot(scope);
    return lockFilePath(scope, this.loc);
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
      if (segment === '' || segment === '.' || segment === '..' || /[\\:\0]/.test(segment)) {
        fail(`unsafe segment "${segment}"`);
      }
    }
    if (segments[segments.length - 1] !== name) fail(`the folder must be named ${name}`);
    const dir = segments.slice(0, -1).join('/');
    if (!AGENT_IDS.some((agent) => this.deps.agents.reads(agent, scope, dir))) {
      fail(`${dir} is not a skills folder any supported agent reads`);
    }
    const root = this.scopeRoot(scope);
    const absDir = path.join(root, ...segments);
    if (!fsu.isWithin(root, absDir)) fail('outside the scope root');
    return { dir, absDir };
  }

  private config(): LoadedConfig {
    return loadConfig({
      cwd: this.deps.cwd,
      home: this.deps.home,
      agenthubHome: this.deps.agenthubHome,
      env: process.env,
    });
  }

  private registryOrNull(): RegistrySource | null {
    if (this.deps.registry) return this.deps.registry;
    const configured = this.config().effective.registry;
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

  private registry(): RegistrySource {
    const registry = this.registryOrNull();
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
    const config = this.config();
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
      });
    }

    const registry = this.registry();
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
    const lock = await readLock(this.lockFile(req.scope));
    const previous = own(lock.skills, name);
    const reason = version.revokedReason ? `: ${version.revokedReason}` : '';
    return {
      id: newTxid(this.now()),
      skill: {
        name,
        version: version.version,
        digest: version.digest,
        ...(version.archiveDigest ? { archiveDigest: version.archiveDigest } : {}),
      },
      source,
      scope: req.scope,
      scopeRoot,
      agents,
      targets: [],
      duplicates: [],
      policy: { findings: [], outcome: 'allow' },
      requirements: [],
      issues: [],
      blockers: [
        { code: 'REVOKED', message: `version ${version.version} of ${name} is revoked${reason}` },
      ],
      needsConfirmation: false,
      hints: [],
      ...(previous ? { previous } : {}),
      dev: req.dev ?? false,
      force: req.force ?? false,
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
  ): { policy: PolicyResult; override: boolean; strict: PolicyResult } {
    const scan = this.deps.security.scan(
      pkg.files.map((file) => ({ path: file.path, content: file.content, kind: file.kind })),
    );
    const strict = this.deps.security.evaluate(scan.findings, pkg.manifest, { dev: false });
    if (strict.outcome !== 'block' || !dev) return { policy: strict, override: false, strict };
    return {
      policy: this.deps.security.evaluate(scan.findings, pkg.manifest, { dev: true }),
      override: true,
      strict,
    };
  }

  private async inspectTarget(
    absDir: string,
    lockPath: string,
    previous: LockEntry | undefined,
    digest: string,
  ): Promise<TargetState> {
    const kind = await fsu.pathKind(absDir);
    if (kind === 'missing') return { action: 'create' };
    if (kind !== 'dir') return { action: 'replace', unmanaged: true, link: kind === 'link' };
    if (previous === undefined || !Object.hasOwn(previous.paths, lockPath)) {
      return { action: 'replace', unmanaged: true };
    }
    const drift = fsu
      .diffFiles(previous.files, await fsu.hashInstalledDir(absDir))
      .filter((status) => status.status !== 'ok')
      .filter((status) => !(status.status === 'extra' && isOsJunk(status.path)))
      .map((status) => status.path);
    if (drift.length === 0 && previous.digest === digest) return { action: 'unchanged' };
    return drift.length > 0 ? { action: 'replace', drift } : { action: 'replace' };
  }

  private async buildPlan(input: BuildPlanInput): Promise<InstallPlan> {
    const { pkg, scope } = input;
    const scopeRoot = this.scopeRoot(scope);
    const lock = await readLock(this.lockFile(scope));
    const previous = own(lock.skills, pkg.name);
    const hints = [...(input.hints ?? [])];
    const blockers: InstallPlan['blockers'] = [];

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
    const { policy, override, strict } = this.evaluatePolicy(pkg, input.dev);
    if (policy.outcome === 'block' && !override) {
      blockers.push({ code: 'POLICY_BLOCKED', message: describeBlock(policy) });
    }
    if (override) {
      hints.push(
        `--dev: installing despite BLOCK findings (${describeBlock(strict).slice('blocked by policy: '.length)}); the override is written to the audit log`,
      );
    }

    // Targets.
    const targets: PlannedTarget[] = [];
    const newFolderAgents = new Set<AgentId>();
    for (const [dir, agents] of folders) {
      const lockPath = this.lockPathFor(scope, dir, pkg.name);
      const { absDir } = this.resolveLockPath(scope, lockPath, pkg.name);
      const state = await this.inspectTarget(absDir, lockPath, previous, pkg.digest);
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
        policy.outcome !== 'allow' || override || targets.some((t) => t.action === 'replace'),
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
      const reg = this.registry();
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

  async apply(plan: InstallPlan): Promise<InstallResult> {
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
    const { policy, override, strict } = this.evaluatePolicy(pkg, plan.dev);
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
      const state = await this.inspectTarget(target.absDir, target.lockPath, previous, pkg.digest);
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
    const newEntry: LockEntry = {
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

    const auditBase = {
      name,
      version: plan.skill.version,
      digest: pkg.digest,
      scope,
      targets: plan.targets.map((t) => t.lockPath),
      dev: plan.dev,
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
      const problems = await this.undoTransaction(guard, journal);
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
    for (const agent of target.agents) {
      if (!this.deps.agents.reads(agent, scope, target.dir)) {
        throw new AgentHubError(
          'INCOMPATIBLE',
          `${agent} does not read skills from ${target.dir} at ${scope} scope`,
        );
      }
    }
  }

  /** Undo a transaction in reverse. Returns problems; the journal is kept when any remain. */
  private async undoTransaction(guard: WriteGuard, journal: Journal): Promise<string[]> {
    const problems: string[] = [];
    for (const step of [...journal.steps].reverse()) {
      try {
        await this.undoStep(guard, step);
      } catch (error) {
        problems.push(`${step.absDir}: ${errorText(error)}`);
      }
    }
    try {
      await this.restoreLockText(guard, journal);
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
    if (problems.length === 0) await deleteJournal(guard, this.deps.agenthubHome, journal.txid);
    return problems;
  }

  private async undoStep(guard: WriteGuard, step: JournalStep): Promise<void> {
    const stagedGone = step.staged !== undefined && !(await fsu.exists(step.staged));
    const newInPlace = step.swapped || (stagedGone && (await fsu.exists(step.absDir)));
    if (newInPlace) await fsu.removeTree(guard, step.absDir);
    if (step.backup !== undefined && (await fsu.exists(step.backup))) {
      if (await fsu.exists(step.absDir)) {
        throw new AgentHubError(
          'CONFLICT',
          `cannot move the previous copy back: ${step.absDir} exists`,
        );
      }
      await fsu.renameWithRetry(guard, step.backup, step.absDir);
    }
  }

  /** Put the lock back to its pre-transaction bytes if this transaction changed it. */
  private async restoreLockText(guard: WriteGuard, journal: Journal): Promise<void> {
    const current = await fsu.readTextOrNull(journal.lockFile);
    if (current === journal.previousLockText || current === null) return;
    let entry: LockEntry | undefined;
    try {
      entry = own(parseLock(current, journal.lockFile).skills, journal.name);
    } catch {
      entry = undefined;
    }
    if (journal.newEntry === null || entryKey(entry) !== entryKey(journal.newEntry)) return;
    if (journal.previousLockText === null) await fsu.removeFile(guard, journal.lockFile);
    else await fsu.writeFileAtomic(guard, journal.lockFile, journal.previousLockText);
  }

  private snapshotBase(scope: Scope, name: string): string {
    return path.join(this.deps.agenthubHome, 'snapshots', scopeId(scope, this.projectRoot), name);
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
  ): Promise<string | undefined> {
    const base = this.snapshotBase(scope, name);
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

  /** The exact package behind a lock entry: an intact installed copy, the cache, or the registry. */
  private async packageForEntry(
    scope: Scope,
    name: string,
    entry: LockEntry,
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
    if (entry.source === 'registry') {
      const registry = this.registryOrNull();
      if (registry) {
        const versions = await registry.listVersions(name);
        const version = versions.find(
          (v) => v.version === entry.version && v.digest === entry.digest,
        );
        if (version) {
          if (version.status === 'revoked') {
            throw new AgentHubError(
              'CONFLICT',
              `version ${entry.version} of ${name} is revoked${version.revokedReason ? `: ${version.revokedReason}` : ''}`,
            );
          }
          const { pkg } = await this.downloadVerified(registry, name, version);
          return { pkg, from: registry.id };
        }
      }
    }
    throw new AgentHubError(
      'NOT_FOUND',
      `cannot restore ${name}@${entry.version}: no intact installed copy, cache entry or registry source`,
    );
  }

  async restore(
    scope: Scope,
    opts: { dev?: boolean; force?: boolean } = {},
  ): Promise<InstallResult[]> {
    const lock = await readLock(this.lockFile(scope));
    const detected = await this.deps.agents.detect();
    const results: InstallResult[] = [];
    for (const name of Object.keys(lock.skills).sort()) {
      const entry = lock.skills[name] as LockEntry;
      const fixedTargets = Object.entries(entry.paths).map(([lockPath, agents]) => ({
        dir: this.resolveLockPath(scope, lockPath, name).dir,
        agents: [...agents],
      }));
      const { pkg, from } = await this.packageForEntry(scope, name, entry);
      const source: InstallPlan['source'] =
        entry.source === 'registry'
          ? {
              kind: 'registry',
              name,
              range: entry.version,
              ...(entry.registry ? { registry: entry.registry } : {}),
            }
          : { kind: from.endsWith('.skillpkg') ? 'file' : 'dir', path: from };
      const plan = await this.buildPlan({
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
      });
      const blocked = blockerError(plan);
      if (blocked) {
        throw new AgentHubError(blocked.code, `${name}: ${blocked.message}`, blocked.details);
      }
      results.push(await this.apply(plan));
    }
    return results;
  }

  async remove(
    name: string,
    scope: Scope,
    opts: { force?: boolean; dryRun?: boolean } = {},
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
        if (status.status === 'ok') {
          if (!dryRun)
            await fsu.removeFile(guard, path.join(target.absDir, ...status.path.split('/')));
        } else if (status.status !== 'missing') {
          kept.push(`${target.lockPath}/${status.path}`);
        }
      }
      if (!dryRun) await this.removeEmptyTree(guard, target.absDir);
      const gone = dryRun
        ? statuses.every((s) => s.status === 'ok' || s.status === 'missing')
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
          ? fsu.diffFiles(entry.files, await fsu.hashInstalledDir(absDir))
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
    const lock = await readLock(this.lockFile(scope));
    if (name !== undefined) {
      const entry = own(lock.skills, name);
      if (!entry)
        throw new AgentHubError('NOT_FOUND', `${name} is not installed at ${scope} scope`);
      return [await this.verifyEntry(scope, name, entry)];
    }
    const out: VerifyReport[] = [];
    for (const skill of Object.keys(lock.skills).sort()) {
      out.push(await this.verifyEntry(scope, skill, lock.skills[skill] as LockEntry));
    }
    return out;
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
        out.push({
          name,
          version: entry.version,
          scope: current,
          agents: [...entry.installedTargets],
          source: entry.source,
          registry: entry.registry,
          status: anyMissing ? 'missing' : report.ok ? 'ok' : 'drift',
          installedAt: entry.installedAt,
        });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Updates and rollback
  // -------------------------------------------------------------------------

  async checkUpdates(scope: Scope, names?: string[]): Promise<UpdateCandidate[]> {
    const lock = await readLock(this.lockFile(scope));
    const registry = this.registryOrNull();
    const channel = this.config().effective.channel ?? 'stable';
    const out: UpdateCandidate[] = [];
    const selected = names && names.length > 0 ? names : Object.keys(lock.skills).sort();
    for (const name of selected) {
      const entry = own(lock.skills, name);
      if (!entry)
        throw new AgentHubError('NOT_FOUND', `${name} is not installed at ${scope} scope`);
      const base = { name, scope, current: entry.version };
      if (!registry) {
        out.push({
          ...base,
          latest: null,
          latestCompatible: null,
          status: 'not-in-registry',
          reason: 'no registry configured',
        });
        continue;
      }
      let versions: RegistryVersion[];
      try {
        versions = await registry.listVersions(name);
      } catch (error) {
        if (isAgentHubError(error) && error.code === 'NOT_FOUND') {
          out.push({
            ...base,
            latest: null,
            latestCompatible: null,
            status: 'not-in-registry',
            reason: error.message,
          });
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
      const current = versions.find((v) => v.version === entry.version);
      const drift = !(await this.verifyEntry(scope, name, entry)).ok;
      if (current?.status === 'revoked') {
        out.push({
          ...base,
          latest,
          latestCompatible,
          status: 'current-revoked',
          reason: `version ${entry.version} is revoked${current.revokedReason ? `: ${current.revokedReason}` : ''}`,
        });
      } else if (drift) {
        out.push({
          ...base,
          latest,
          latestCompatible,
          status: 'drift',
          reason: 'installed files differ from the lock',
        });
      } else if (
        latestCompatible !== null &&
        semver.valid(entry.version) !== null &&
        semver.gt(latestCompatible, entry.version)
      ) {
        out.push({ ...base, latest, latestCompatible, status: 'available' });
      } else {
        out.push({ ...base, latest, latestCompatible, status: 'up-to-date' });
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
    const registry = this.registry();
    const channel = opts.channel ?? this.config().effective.channel ?? 'stable';
    const versions = await registry.listVersions(name);
    const outcome = resolveVersion(versions, {
      ...(opts.range === undefined ? {} : { range: opts.range }),
      channel,
      agents: entry.installedTargets,
    });
    const currentRevoked = versions.some(
      (v) => v.version === entry.version && v.status === 'revoked',
    );
    if (outcome.kind === 'none') {
      if (currentRevoked) throw new AgentHubError('NOT_FOUND', `${name}: ${outcome.reason}`);
      return null;
    }
    const target = outcome.version;
    if (target.version === entry.version && target.digest === entry.digest) return null;
    if (
      outcome.kind === 'ok' &&
      !currentRevoked &&
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
    const entry = parseLockEntry(raw, entryFile);
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
    });
    const blocked = blockerError(plan);
    if (blocked) throw blocked;
    return this.apply(plan);
  }

  // -------------------------------------------------------------------------
  // Recovery and doctor
  // -------------------------------------------------------------------------

  private journalProblem(journal: Journal): string | null {
    const root = journal.scopeRoot;
    const home = this.deps.agenthubHome;
    const inScope = (p: string) => fsu.isWithin(root, p);
    const inState = (p: string) =>
      fsu.isWithin(home, p) || fsu.isWithin(path.join(root, '.agenthub'), p);
    for (const dir of journal.stagingDirs) {
      const fallback = path.basename(dir) === `.agenthub-tmp-${journal.txid}` && inScope(dir);
      if (!inState(dir) && !fallback) return `staging folder outside the state folders: ${dir}`;
    }
    const inStaging = (p: string) => journal.stagingDirs.some((dir) => fsu.isWithin(dir, p));
    for (const step of journal.steps) {
      if (!inScope(step.absDir) || fsu.isWithin(step.absDir, root))
        return `target outside the scope root: ${step.absDir}`;
      if (step.backup !== undefined && !inStaging(step.backup))
        return `backup outside staging: ${step.backup}`;
      if (step.staged !== undefined && !inStaging(step.staged))
        return `staged copy outside staging: ${step.staged}`;
    }
    for (const dir of journal.createdDirs) {
      if (!inScope(dir) && !inState(dir)) return `created folder outside the scope: ${dir}`;
    }
    if (!inState(journal.lockFile))
      return `lock file outside the state folders: ${journal.lockFile}`;
    return null;
  }

  async recover(): Promise<string[]> {
    const messages: string[] = [];
    const home = this.deps.agenthubHome;
    for (const item of await readJournals(home)) {
      if (!('journal' in item)) {
        messages.push(`skipped unreadable journal ${item.file}: ${item.error}`);
        continue;
      }
      const journal = item.journal;
      const problem = this.journalProblem(journal);
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
        const problems = await this.undoTransaction(guard, journal);
        messages.push(
          problems.length === 0
            ? `rolled back an interrupted install of ${journal.name} (${journal.steps.length} folder(s) restored)`
            : `could not fully roll back the interrupted install of ${journal.name}: ${problems.join('; ')}`,
        );
        continue;
      }
      try {
        if (journal.newEntry) {
          const lock = await readLock(journal.lockFile);
          if (entryKey(own(lock.skills, journal.name)) !== entryKey(journal.newEntry)) {
            lock.skills[journal.name] = journal.newEntry;
            await writeLock(guard, journal.lockFile, lock);
          }
        }
        for (const dir of journal.stagingDirs) await fsu.removeTree(guard, dir);
        await deleteJournal(guard, home, journal.txid);
        messages.push(`finished an interrupted install of ${journal.name}`);
      } catch (error) {
        messages.push(
          `could not finish the interrupted install of ${journal.name}: ${errorText(error)}`,
        );
      }
    }
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

  async doctor(): Promise<DoctorReport> {
    const problems: DoctorProblem[] = [];
    const agents = await this.deps.agents.detect();
    try {
      this.config();
    } catch (error) {
      problems.push({ level: 'error', code: 'config.invalid', message: errorText(error) });
    }

    const scopes: DoctorReport['scopes'] = [];
    const byScope = new Map<Scope, Record<string, LockEntry>>();
    const tmpDirs: string[] = [];
    const skillsParents = new Set<string>();
    for (const scope of this.scopes()) {
      const root = this.scopeRoot(scope);
      const lockFile = this.lockFile(scope);
      const lockExists = await fsu.exists(lockFile);
      let skills: Record<string, LockEntry> = {};
      try {
        skills = (await readLock(lockFile)).skills;
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
          const report = await this.verifyEntry(scope, name, entry);
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
