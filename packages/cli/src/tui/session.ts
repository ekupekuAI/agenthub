/**
 * The interactive mode's link to the engine. Every operation goes through the same
 * CommandContext, wiring and command helpers as the classic commands (install requests, update
 * plans, registry checks, crash recovery, plan confirmation rules), so the policy and
 * capability-approval gates are the engine's own. Notices those helpers print (recovery,
 * registry choice, ignored project settings) are collected and shown as toasts.
 */
import type {
  AgentEnvironment,
  AgentHubConfig,
  AgentId,
  ApproveResult,
  DoctorProblem,
  DoctorReport,
  InstallPlan,
  InstallResult,
  ListedSkill,
  RemoveResult,
  Scope,
  SearchResult,
  SkillDiff,
  SkillInfo,
  UpdateCandidate,
  VerifyReport,
} from '@agenthub/core';
import { AgentHubError } from '@agenthub/core';
import { installRequest } from '../commands/install';
import {
  approvalRequiredError,
  approvedBy,
  blockedError,
  interactiveApproval,
} from '../commands/plan-flow';
import { requireRegistry } from '../commands/registry';
import { assertSkillName } from '../commands/shared';
import { checkUpdates, planFor, sourceChange } from '../commands/update';
import { CommandContext, type GlobalOptions, type Runtime } from '../context';
import { normalizeRegistryUrl } from '../http-registry';
import { asAgentHubError, Output, type OutStream } from '../output';
import { resolvePaths } from '../wiring';
import { safe } from './sanitize';

/** CommandContext with a session registry override (like AGENTHUB_REGISTRY, for this session). */
class SessionContext extends CommandContext {
  constructor(
    opts: GlobalOptions,
    runtime: Runtime,
    out: Output,
    private readonly registryOverride: string | undefined,
  ) {
    super('interactive', opts, runtime, out);
  }

  override configFlags(): Partial<AgentHubConfig> {
    const flags = super.configFlags();
    if (this.registryOverride !== undefined) flags.registry = this.registryOverride;
    return flags;
  }
}

export interface SessionOptions {
  runtime: Runtime;
  /** -g at launch: start in the user scope. */
  global: boolean;
  /** --no-color at launch. */
  color: boolean;
}

export interface Overview {
  scope: Scope;
  projectRoot: string | null;
  registry: { id: string | null; source: string | undefined; error: string | null };
  agents: AgentEnvironment[];
  /** Agents chosen with /agents; undefined = detected agents (high/medium confidence). */
  selectedAgents: AgentId[] | undefined;
  problems: DoctorProblem[];
  /** Installed skill names (both scopes unless -g), for completion. */
  installed: string[];
}

export interface SkillDetail {
  info: SkillInfo;
  registry: string;
  installed: ListedSkill[];
}

export interface DoctorView {
  report: DoctorReport | null;
  problems: DoctorProblem[];
  registry: string | null;
  home: string;
}

export interface Timed<T> {
  value: T;
  ms: number;
}

async function timed<T>(work: () => Promise<T>): Promise<Timed<T>> {
  const started = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - started) };
}

export class Session {
  private context: SessionContext | null = null;
  private scopeOverride: Scope | undefined;
  private agents: AgentId[] | undefined;
  private registryOverride: string | undefined;
  private listeners = new Set<(text: string) => void>();
  readonly runtime: Runtime;

  constructor(private readonly opts: SessionOptions) {
    this.runtime = opts.runtime;
    if (opts.global) this.scopeOverride = 'user';
  }

  /** Subscribes to notices (recovered transactions, registry notes, warnings). */
  onNotice(listener: (text: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(text: string): void {
    const line = safe(text).trim();
    if (line === '') return;
    for (const listener of this.listeners) listener(line);
  }

  /** The context for the current settings (rebuilt when a setting changes). */
  ctx(): CommandContext {
    if (this.context !== null) return this.context;
    const sink: OutStream = {
      isTTY: false,
      write: (chunk: string) => {
        for (const line of String(chunk).split('\n')) this.emit(line);
        return true;
      },
    };
    const quiet: OutStream = { isTTY: false, write: () => true };
    const out = new Output({
      json: false,
      verbose: false,
      color: false,
      env: this.runtime.env,
      stdout: quiet,
      stderr: sink,
    });
    const opts: GlobalOptions = {
      json: false,
      // The interactive mode always asks; it never answers for the user.
      yes: false,
      dryRun: false,
      global: this.scopeOverride === 'user',
      // Never overrides policy blocks, never replaces modified folders.
      dev: false,
      force: false,
      verbose: false,
      color: this.opts.color,
    };
    if (this.agents !== undefined) opts.agent = this.agents;
    this.context = new SessionContext(opts, this.runtime, out, this.registryOverride);
    return this.context;
  }

  private reset(): void {
    this.context = null;
  }

  get home(): string {
    return resolvePaths(this.runtime.env).home;
  }

  async scope(): Promise<Scope> {
    return this.ctx().scope();
  }

  selectedAgents(): AgentId[] | undefined {
    return this.agents;
  }

  /** null = back to detection. */
  setAgents(agents: AgentId[] | null): void {
    if (agents !== null && agents.length === 0) {
      throw new AgentHubError('USAGE', 'select at least one agent, or reset to the detected ones');
    }
    this.agents = agents ?? undefined;
    this.reset();
  }

  async setScope(scope: Scope): Promise<Scope> {
    if (scope === 'project') {
      const engine = await this.ctx().engine();
      if (engine.projectRoot === null) {
        throw new AgentHubError(
          'USAGE',
          'not inside a project (no .git or .agenthub folder above this one), so the user scope is used',
        );
      }
      this.scopeOverride = undefined;
    } else {
      this.scopeOverride = 'user';
    }
    this.reset();
    return this.scope();
  }

  /** Sets (or with null clears) the registry for this session; validated like `config set`. */
  async setRegistry(value: string | null): Promise<string | null> {
    if (value === null) {
      this.registryOverride = undefined;
    } else {
      const trimmed = value.trim();
      if (!/^(https?:|file:)/i.test(trimmed)) {
        throw new AgentHubError(
          'USAGE',
          `unsupported registry "${safe(trimmed)}" — use https://… or file:<folder>`,
        );
      }
      this.registryOverride = trimmed.startsWith('file:') ? trimmed : normalizeRegistryUrl(trimmed);
    }
    this.reset();
    const wiring = await this.ctx().wiring();
    if (wiring.registryError !== undefined) throw wiring.registryError;
    return wiring.registry?.id ?? null;
  }

  async overview(): Promise<Overview> {
    const ctx = this.ctx();
    const wiring = await ctx.wiring();
    await ctx.registryNotice();
    const engine = wiring.engine;
    const [scope, report, installed] = await Promise.all([
      ctx.scope(),
      engine.doctor().catch(() => null),
      engine.list().catch(() => [] as ListedSkill[]),
    ]);
    const registryError =
      wiring.registryError === undefined
        ? null
        : wiring.registryError instanceof Error
          ? wiring.registryError.message
          : String(wiring.registryError);
    return {
      scope,
      projectRoot: engine.projectRoot,
      registry: {
        id: wiring.registry?.id ?? null,
        source: wiring.registrySource,
        error: registryError,
      },
      agents: report?.agents ?? [],
      selectedAgents: this.agents,
      problems: report?.problems ?? [],
      installed: [...new Set(installed.map((skill) => skill.name))].sort(),
    };
  }

  async search(query: string): Promise<Timed<{ registry: string; results: SearchResult[] }>> {
    return timed(async () => {
      const registry = await requireRegistry(this.ctx());
      if (registry.search === undefined) {
        throw new AgentHubError(
          'USAGE',
          `the configured registry (${registry.id}) does not support search`,
        );
      }
      const agent = this.agents?.length === 1 ? this.agents[0] : undefined;
      const results = await registry.search(query, agent === undefined ? {} : { agent });
      return { registry: registry.id, results };
    });
  }

  async detail(name: string): Promise<SkillDetail> {
    assertSkillName(name);
    const ctx = this.ctx();
    const registry = await requireRegistry(ctx);
    let info: SkillInfo;
    if (registry.info !== undefined) {
      info = await registry.info(name);
    } else {
      const versions = await registry.listVersions(name);
      info = { slug: name, name, summary: '', latest: versions[0] ?? null, versions };
    }
    const engine = await ctx.engine();
    const installed = (await engine.list().catch(() => [] as ListedSkill[])).filter(
      (skill) => skill.name === name,
    );
    return { info, registry: registry.id, installed };
  }

  /** Plans an install (download, verify, scan, policy): nothing is written. */
  async planInstall(target: string): Promise<Timed<InstallPlan>> {
    return timed(async () => {
      const ctx = this.ctx();
      const request = await installRequest(ctx, target);
      return (await ctx.engine()).plan(request);
    });
  }

  /** Update plan for one skill; null when up to date. */
  async planUpdate(
    name: string,
  ): Promise<Timed<{ plan: InstallPlan | null; sourceChange: string | null }>> {
    assertSkillName(name);
    return timed(async () => {
      const ctx = this.ctx();
      await requireRegistry(ctx);
      const plan = await planFor(ctx, name);
      return { plan, sourceChange: plan === null ? null : sourceChange(plan) };
    });
  }

  /**
   * Applies a plan the user confirmed. `confirmed` says which question was answered yes: a plan
   * that expands capabilities is refused unless the capability question was answered (the engine
   * enforces the same gate again from the lock).
   */
  async apply(
    plan: InstallPlan,
    confirmed: 'plan' | 'capabilities',
  ): Promise<Timed<InstallResult>> {
    if (plan.blockers.length > 0) throw blockedError(plan);
    if (plan.capabilities?.approvalRequired && confirmed !== 'capabilities') {
      throw approvalRequiredError(plan);
    }
    return timed(async () => {
      const ctx = this.ctx();
      await ctx.recover();
      const engine = await ctx.engine();
      const approve = interactiveApproval(plan, this.runtime.env);
      return engine.apply(plan, approve === undefined ? {} : { approve });
    });
  }

  async list(): Promise<ListedSkill[]> {
    const ctx = this.ctx();
    const engine = await ctx.engine();
    return ctx.opts.global ? engine.list('user') : engine.list();
  }

  async verify(name?: string): Promise<Timed<VerifyReport[]>> {
    if (name !== undefined) assertSkillName(name);
    return timed(async () => {
      const ctx = this.ctx();
      return (await ctx.engine()).verify(await ctx.scope(), name);
    });
  }

  async checkUpdates(name?: string): Promise<Timed<UpdateCandidate[]>> {
    if (name !== undefined) assertSkillName(name);
    return timed(async () => {
      const ctx = this.ctx();
      await requireRegistry(ctx);
      return checkUpdates(ctx, await ctx.scope(), name, true);
    });
  }

  async diff(name: string): Promise<SkillDiff> {
    assertSkillName(name);
    const ctx = this.ctx();
    await requireRegistry(ctx);
    const engine = await ctx.engine();
    const channel = ctx.channel();
    return engine.diff(name, await ctx.scope(), channel === undefined ? {} : { channel });
  }

  /** What `approve` would record (verifies and rescans the installed bytes; writes nothing). */
  async approvePreview(name: string): Promise<ApproveResult> {
    assertSkillName(name);
    const ctx = this.ctx();
    const engine = await ctx.engine();
    return engine.approve(name, await ctx.scope(), {}, { dryRun: true });
  }

  async approve(name: string): Promise<ApproveResult> {
    assertSkillName(name);
    const ctx = this.ctx();
    const engine = await ctx.engine();
    const by = approvedBy(this.runtime.env);
    return engine.approve(
      name,
      await ctx.scope(),
      by === undefined ? { mode: 'prompt' } : { mode: 'prompt', by },
    );
  }

  async installedVersion(name: string): Promise<string | null> {
    const ctx = this.ctx();
    const engine = await ctx.engine();
    const scope = await ctx.scope();
    const entry = (await engine.list(scope)).find((skill) => skill.name === name);
    return entry === undefined ? null : entry.version;
  }

  async rollback(name: string): Promise<Timed<InstallResult>> {
    assertSkillName(name);
    return timed(async () => {
      const ctx = this.ctx();
      await ctx.recover();
      return (await ctx.engine()).rollback(name, await ctx.scope());
    });
  }

  async remove(name: string, dryRun: boolean): Promise<RemoveResult> {
    assertSkillName(name);
    const ctx = this.ctx();
    if (!dryRun) await ctx.recover();
    return (await ctx.engine()).remove(name, await ctx.scope(), { force: false, dryRun });
  }

  async doctor(): Promise<DoctorView> {
    const ctx = this.ctx();
    let wiring: Awaited<ReturnType<CommandContext['wiring']>>;
    try {
      wiring = await ctx.wiring();
    } catch (error) {
      const known = asAgentHubError(error);
      if (known?.code !== 'VALIDATION' && known?.code !== 'IO') throw error;
      return {
        report: null,
        problems: [{ level: 'error', code: 'config.invalid', message: known.message }],
        registry: null,
        home: this.home,
      };
    }
    const report = await wiring.engine.doctor();
    const problems = [...report.problems];
    if (wiring.registryError !== undefined) {
      const message =
        wiring.registryError instanceof Error
          ? wiring.registryError.message
          : String(wiring.registryError);
      problems.push({ level: 'error', code: 'config.registry', message });
    }
    return {
      report,
      problems,
      registry: wiring.config.effective.registry ?? null,
      home: wiring.paths.home,
    };
  }
}
