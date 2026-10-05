/**
 * Builds the install engine's ports from the real machine: agent adapters, the scanner, a
 * requirement probe and the configured registry.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claudeUserSkillsRelocation,
  createNodeDetectContext,
  detectAgents,
  duplicateAgents,
  getAdapter,
  isWritableSkillsDir,
  PATH_TABLE_VERSION,
  selectTargetFolders,
} from '@agenthub/adapters';
import type {
  AgentEnvironment,
  AgentHubConfig,
  AgentId,
  AgentPort,
  Confidence,
  ConfigSource,
  DetectContext,
  DoctorProblem,
  Engine,
  InstallPlan,
  RegistrySource,
  RequirementCheck,
  RequirementProbe,
  RunResult,
  SecurityPort,
} from '@agenthub/core';
import {
  AGENT_IDS,
  AgentHubError,
  createEngine,
  createFileRegistry,
  loadConfig,
} from '@agenthub/core';
import { evaluatePolicy, scanPackage } from '@agenthub/scanner';
import { HttpRegistry } from './http-registry';

export type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

export interface Paths {
  home: string;
  agenthubHome: string;
}

export function resolvePaths(env: Record<string, string | undefined>): Paths {
  const home = nonEmpty(env.AGENTHUB_USER_HOME) ?? homedir();
  const agenthubHome = nonEmpty(env.AGENTHUB_HOME) ?? join(home, '.agenthub');
  return { home: resolve(home), agenthubHome: resolve(agenthubHome) };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];

/**
 * AGENTHUB_AGENTS (testing and CI seam): `id[:confidence]` comma list that replaces agent
 * detection, e.g. `claude-code,codex:medium`.
 */
export function parseAgentsEnv(value: string): AgentEnvironment[] {
  const seen = new Set<AgentId>();
  const out: AgentEnvironment[] = [];
  for (const item of value.split(',')) {
    const trimmed = item.trim();
    if (trimmed === '') continue;
    const [rawId = '', rawConfidence] = trimmed.split(':');
    const id = rawId.trim();
    if (!(AGENT_IDS as readonly string[]).includes(id)) {
      throw new AgentHubError(
        'USAGE',
        `AGENTHUB_AGENTS: unknown agent "${id}" (known: ${AGENT_IDS.join(', ')})`,
      );
    }
    const confidence = (rawConfidence?.trim() || 'high') as Confidence;
    if (!CONFIDENCES.includes(confidence)) {
      throw new AgentHubError(
        'USAGE',
        `AGENTHUB_AGENTS: invalid confidence "${rawConfidence}" for ${id} (high, medium or low)`,
      );
    }
    const agentId = id as AgentId;
    if (seen.has(agentId)) continue;
    seen.add(agentId);
    const adapter = getAdapter(agentId);
    out.push({
      id: agentId,
      displayName: adapter.displayName,
      confidence,
      evidence: ['from AGENTHUB_AGENTS'],
      status: adapter.status,
    });
  }
  return out;
}

export function createAgentPort(
  ctx: DetectContext,
  env: Record<string, string | undefined>,
): AgentPort {
  let detected: Promise<AgentEnvironment[]> | undefined;
  const override = env.AGENTHUB_AGENTS;
  return {
    detect() {
      if (detected === undefined) {
        detected =
          override !== undefined
            ? Promise.resolve().then(() => parseAgentsEnv(override))
            : detectAgents(ctx);
      }
      return detected;
    },
    selectTargets: (scope, agents) => selectTargetFolders(scope, agents),
    duplicates: (scope, folders) => duplicateAgents(scope, folders),
    reads: (agent, scope, dir) => getAdapter(agent).reads(scope, dir),
    isWritable: (scope, dir) => isWritableSkillsDir(scope, dir),
    reloadHint: (agent) => getAdapter(agent).reloadHint,
    tableVersion: PATH_TABLE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

export function createSecurityPort(): SecurityPort {
  return {
    scan: (files) => scanPackage(files),
    evaluate: (findings, manifest, opts) => evaluatePolicy(findings, manifest, opts),
  };
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------
//
// Requirement names come from the (untrusted) package manifest. The probe therefore never
// starts a program a package names: commands are only looked up on PATH, and runtimes are
// version-probed only from a fixed allowlist with fixed arguments, from a neutral working
// folder, with stdin closed, and only when the executable lives outside the project and the
// current folder. Everything else is reported as "cannot be checked" (ok: null).

const PROBE_TIMEOUT_MS = 5000;
/** Total time all version probes of one command may take. */
const PROBE_BUDGET_MS = 15_000;
/** Only the start of a probe's output is inspected. */
const PROBE_OUTPUT_LIMIT = 4096;
const VERSION_TOKEN = /\d{1,9}(\.\d{1,9}){0,2}/;
/** Names a package may ask us to look up; never paths. */
const SAFE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

interface RuntimeProbeSpec {
  /** Executables tried in order (looked up on PATH). */
  executables: readonly string[];
  /** Fixed arguments; never derived from the package. */
  args: readonly string[];
}

const PYTHON: RuntimeProbeSpec = { executables: ['python3', 'python', 'py'], args: ['--version'] };
const GO: RuntimeProbeSpec = { executables: ['go'], args: ['version'] };
const RUST: RuntimeProbeSpec = { executables: ['rustc'], args: ['--version'] };

/** The only runtimes whose version agenthub checks by running them (node is read in-process). */
export const RUNTIME_PROBES: Readonly<Record<string, RuntimeProbeSpec>> = {
  python: PYTHON,
  python3: PYTHON,
  py: PYTHON,
  deno: { executables: ['deno'], args: ['--version'] },
  bun: { executables: ['bun'], args: ['--version'] },
  go: GO,
  golang: GO,
  ruby: { executables: ['ruby'], args: ['--version'] },
  java: { executables: ['java'], args: ['-version'] },
  dotnet: { executables: ['dotnet'], args: ['--version'] },
  cargo: { executables: ['cargo'], args: ['--version'] },
  rustc: RUST,
  rust: RUST,
};

export function firstVersionToken(text: string): string | null {
  return VERSION_TOKEN.exec(text.slice(0, PROBE_OUTPUT_LIMIT))?.[0] ?? null;
}

/** Runs one allowlisted probe. Injected in tests. */
export type ProbeRunner = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export interface ProbeOptions {
  /** The current working folder; executables under it are never run. */
  cwd: string;
  /** The project root, once known; executables under it are never run. */
  projectRoot?: () => string | null;
  runner?: ProbeRunner;
  /** Total time budget for all version probes. */
  budgetMs?: number;
}

export interface CliRequirementProbe extends RequirementProbe {
  /**
   * Why a runtime that `runtime()` reported as null is unknown rather than missing (it exists,
   * but agenthub will not or could not check its version); undefined when it is missing.
   */
  unknown(name: string): string | undefined;
}

/** A folder the project cannot influence: probes never run in the user's working folder. */
export function neutralProbeCwd(): string {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (systemRoot !== undefined && isAbsolute(systemRoot)) return systemRoot;
    return parse(homedir()).root || 'C:\\';
  }
  return '/';
}

/** Spawns an allowlisted probe: no shell, stdin closed, neutral cwd, bounded output and time. */
export const spawnProbe: ProbeRunner = (file, args, timeoutMs) =>
  new Promise((resolvePromise) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GOTOOLCHAIN: 'local' };
    if (process.platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
    let child: ChildProcess;
    try {
      child = spawn(file, args, {
        cwd: neutralProbeCwd(),
        env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({ code: null, stdout: '', stderr: String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const take = (current: string, chunk: Buffer): string =>
      current.length >= PROBE_OUTPUT_LIMIT
        ? current
        : (current + chunk.toString('utf8')).slice(0, PROBE_OUTPUT_LIMIT);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = take(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = take(stderr, chunk);
    });
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: null, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.on('error', (error) => finish({ code: null, stdout, stderr: String(error) }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });

function within(child: string, parent: string): boolean {
  const a = process.platform === 'win32' ? child.toLowerCase() : child;
  const b = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const rel = relative(b, a);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export function createRequirementProbe(
  ctx: DetectContext,
  opts: ProbeOptions,
): CliRequirementProbe {
  const runtimes = new Map<string, Promise<string | null>>();
  const commands = new Map<string, Promise<boolean>>();
  const unknown = new Map<string, string>();
  const runner = opts.runner ?? spawnProbe;
  let budget = opts.budgetMs ?? PROBE_BUDGET_MS;

  /** True when the executable lives inside the project or the current folder. */
  async function insideProject(executable: string): Promise<boolean> {
    const roots = [opts.cwd, opts.projectRoot?.() ?? null].filter(
      (root): root is string => root !== null && root !== '',
    );
    const file = resolve(executable);
    const realFile = await realOrResolved(executable);
    for (const root of roots) {
      const realRoot = await realOrResolved(root);
      if (within(file, resolve(root)) || within(realFile, realRoot)) return true;
    }
    return false;
  }

  async function probeAllowlisted(key: string, spec: RuntimeProbeSpec): Promise<string | null> {
    let reason: string | undefined;
    for (const candidate of spec.executables) {
      const executable = await ctx.which(candidate).catch(() => null);
      if (executable === null) continue;
      if (await insideProject(executable)) {
        reason ??= `${candidate} resolves inside the project or the current folder, so agenthub does not run it`;
        continue;
      }
      if (process.platform === 'win32' && extname(executable).toLowerCase() !== '.exe') {
        reason ??= `${candidate} is a script shim, so agenthub does not run it to check its version`;
        continue;
      }
      if (budget <= 0) {
        reason ??= 'the time budget for version checks is used up';
        continue;
      }
      const started = Date.now();
      const result = await runner(
        executable,
        [...spec.args],
        Math.min(PROBE_TIMEOUT_MS, budget),
      ).catch(() => null);
      budget -= Date.now() - started;
      if (result !== null && result.code === 0) {
        const output = result.stdout.trim() !== '' ? result.stdout : result.stderr;
        const version = firstVersionToken(output);
        if (version !== null) return version;
      }
    }
    if (reason !== undefined) unknown.set(key, reason);
    return null;
  }

  async function probeRuntime(name: string): Promise<string | null> {
    const key = name.trim().toLowerCase();
    if (key === 'node' || key === 'nodejs') return process.versions.node;
    const spec = Object.hasOwn(RUNTIME_PROBES, key) ? RUNTIME_PROBES[key] : undefined;
    if (spec !== undefined) return probeAllowlisted(key, spec);
    // Not on the allowlist: look it up on PATH, never run it.
    if (!SAFE_COMMAND.test(key)) return null;
    const executable = await ctx.which(key).catch(() => null);
    if (executable !== null) {
      unknown.set(
        key,
        `agenthub does not run ${key} to check its version; make sure it meets the requirement`,
      );
    }
    return null;
  }

  return {
    runtime(name) {
      let pending = runtimes.get(name);
      if (pending === undefined) {
        pending = probeRuntime(name).catch(() => null);
        runtimes.set(name, pending);
      }
      return pending;
    },
    command(name) {
      let pending = commands.get(name);
      if (pending === undefined) {
        pending = SAFE_COMMAND.test(name)
          ? ctx
              .which(name)
              .then((found) => found !== null)
              .catch(() => false)
          : Promise.resolve(false);
        commands.set(name, pending);
      }
      return pending;
    },
    unknown(name) {
      return unknown.get(name.trim().toLowerCase());
    },
  };
}

/** The engine's blocker text for a runtime reported as missing (engine describeRequirement). */
function missingRuntimeMessage(skill: string, check: RequirementCheck): string {
  return `${skill} requires ${check.name} ${check.constraint ?? ''}, ${check.name} was not found`.replace(
    / ,/,
    ',',
  );
}

/**
 * The engine treats a null runtime version as "missing". For runtimes the probe could not or
 * would not check, the CLI reports "cannot be checked locally" (ok: null) with a hint instead,
 * and drops the matching INCOMPATIBLE blocker.
 */
export function adjustUnknownRequirements(
  plan: InstallPlan,
  probe: Pick<CliRequirementProbe, 'unknown'>,
): InstallPlan {
  const requirements: RequirementCheck[] = [];
  const dropped = new Set<string>();
  const hints = [...plan.hints];
  for (const check of plan.requirements) {
    const reason =
      check.kind === 'runtime' && check.ok === false && !check.found
        ? probe.unknown(check.name)
        : undefined;
    if (reason === undefined) {
      requirements.push(check);
      continue;
    }
    dropped.add(missingRuntimeMessage(plan.skill.name, check));
    const { found: _found, ...rest } = check;
    requirements.push({ ...rest, ok: null });
    hints.push(
      `${plan.skill.name} requires ${check.name}${check.constraint ? ` ${check.constraint}` : ''}; ${reason}`,
    );
  }
  if (dropped.size === 0) return plan;
  let removed = 0;
  const blockers = plan.blockers.filter((blocker) => {
    if (blocker.code === 'INCOMPATIBLE' && dropped.has(blocker.message)) {
      removed += 1;
      return false;
    }
    return true;
  });
  // If the engine's wording ever changes, keep its blockers rather than guess.
  if (removed !== dropped.size) return plan;
  return { ...plan, requirements, blockers, hints };
}

/** The same adjustment for doctor's "requirement.unmet" warnings. */
export function adjustUnknownProblems(
  problems: DoctorProblem[],
  probe: Pick<CliRequirementProbe, 'unknown'>,
): DoctorProblem[] {
  return problems.map((problem) => {
    if (problem.code !== 'requirement.unmet') return problem;
    const match = / requires (\S+) .*, (\S+) was not found$/.exec(problem.message);
    const name = match?.[1];
    if (name === undefined || match?.[2] !== name) return problem;
    const reason = probe.unknown(name);
    if (reason === undefined) return problem;
    return {
      level: 'warning',
      code: 'requirement.unchecked',
      message: `${problem.message.replace(/, \S+ was not found$/, '')}; ${reason}`,
    };
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** A registry that fails on use; keeps a bad registry setting from breaking local commands. */
function brokenRegistry(id: string, error: unknown): RegistrySource {
  const fail = (): never => {
    throw error;
  };
  return {
    id,
    listVersions: async () => fail(),
    download: async () => fail(),
    search: async () => fail(),
    info: async () => fail(),
  };
}

/**
 * UNC and device paths (`\\server\share`, `//server/share`, `\\?\…`). Opening one makes
 * Windows authenticate to that server, so a repository must not be able to point us there.
 */
export function isNetworkPath(dir: string): boolean {
  return /^[\\/]{2}/.test(dir);
}

export interface CreateRegistryOptions {
  /**
   * Allow `file:` registries on network shares. Only for values the user chose (flags,
   * environment, user config), never for a repository's project config.
   */
  allowNetworkPath?: boolean;
}

export function createRegistry(
  value: string,
  baseDir: string,
  opts: CreateRegistryOptions = {},
): RegistrySource {
  const trimmed = value.trim();
  if (trimmed.startsWith('file:')) {
    let dir: string;
    if (trimmed.startsWith('file://')) {
      let url: URL;
      try {
        url = new URL(trimmed);
        dir = fileURLToPath(url);
      } catch {
        throw new AgentHubError('USAGE', `invalid file registry URL: ${trimmed}`);
      }
      if (url.hostname !== '' && url.hostname !== 'localhost' && opts.allowNetworkPath !== true) {
        throw new AgentHubError(
          'USAGE',
          `file registry ${trimmed} is on another host; agenthub only opens local folders from project config`,
        );
      }
    } else {
      dir = trimmed.slice('file:'.length);
    }
    if (dir === '') throw new AgentHubError('USAGE', 'file registry path must not be empty');
    const abs = isAbsolute(dir) && !/^[\\/](?![\\/])/.test(dir) ? dir : resolve(baseDir, dir);
    if (opts.allowNetworkPath !== true && (isNetworkPath(dir) || isNetworkPath(abs))) {
      throw new AgentHubError(
        'USAGE',
        `file registry ${trimmed} is a network path; agenthub only opens local folders from project config (set it in your user config or AGENTHUB_REGISTRY instead)`,
      );
    }
    return createFileRegistry(abs);
  }
  if (/^https?:/i.test(trimmed)) return new HttpRegistry(trimmed);
  throw new AgentHubError(
    'USAGE',
    `unsupported registry "${trimmed}" — use https://… or file:<folder>`,
  );
}

// ---------------------------------------------------------------------------
// Everything together
// ---------------------------------------------------------------------------

export interface Wiring {
  paths: Paths;
  config: LoadedConfig;
  registry: RegistrySource | null;
  /** Where the registry setting came from (undefined when none is configured). */
  registrySource: ConfigSource | undefined;
  /** The configuration error that made the registry unusable, if any. */
  registryError: unknown;
  engine: Engine;
}

export interface WiringOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  flags?: Partial<AgentHubConfig>;
  /** -g: user-scope command; a project's config never chooses its registry. */
  global?: boolean;
}

export async function loadEffectiveConfig(opts: WiringOptions): Promise<LoadedConfig> {
  const paths = resolvePaths(opts.env);
  return loadConfig({
    cwd: opts.cwd,
    home: paths.home,
    agenthubHome: paths.agenthubHome,
    env: opts.env,
    flags: opts.flags ?? {},
    // -g: a repository's config never applies to user-scope operations.
    ...(opts.global === true ? { scope: 'user' as const } : {}),
  });
}

/**
 * Claude Code reads user skills from `$CLAUDE_CONFIG_DIR/skills` when that variable moves its
 * config folder; a user-scope install into ~/.claude/skills would then never be loaded.
 */
export function addClaudeRelocationWarning(
  plan: InstallPlan,
  relocation: { skillsDir: string } | undefined,
): InstallPlan {
  if (relocation === undefined || plan.scope !== 'user') return plan;
  const affected = plan.targets.some((target) => target.agents.includes('claude-code'));
  if (!affected) return plan;
  return {
    ...plan,
    issues: [
      ...plan.issues,
      {
        level: 'warning',
        code: 'agent.claude-config-dir',
        message: `$CLAUDE_CONFIG_DIR moves Claude Code's user skills folder to ${relocation.skillsDir}; this user-scope install into ~/.claude/skills will not be loaded by Claude Code`,
      },
    ],
  };
}

/**
 * CLI-side checks on every plan the engine makes: runtimes the probe would not check are shown
 * as "cannot be checked locally" instead of "missing" (plans and doctor), and user-scope plans
 * for Claude Code warn when $CLAUDE_CONFIG_DIR relocates its skills folder.
 */
function withPlanChecks(engine: Engine, probe: CliRequirementProbe, ctx: DetectContext): Engine {
  const plan = engine.plan.bind(engine);
  const planUpdate = engine.planUpdate.bind(engine);
  const planRestore = engine.planRestore.bind(engine);
  const doctor = engine.doctor.bind(engine);
  const check = (planned: InstallPlan): InstallPlan =>
    addClaudeRelocationWarning(
      adjustUnknownRequirements(planned, probe),
      claudeUserSkillsRelocation(ctx),
    );
  engine.plan = async (req) => check(await plan(req));
  engine.planRestore = async (...args) => (await planRestore(...args)).map(check);
  engine.planUpdate = async (...args) => {
    const planned = await planUpdate(...args);
    return planned === null ? null : check(planned);
  };
  engine.doctor = async () => {
    const report = await doctor();
    return { ...report, problems: adjustUnknownProblems(report.problems, probe) };
  };
  return engine;
}

export async function createWiring(opts: WiringOptions): Promise<Wiring> {
  const paths = resolvePaths(opts.env);
  const config = await loadEffectiveConfig(opts);
  const ctx = createNodeDetectContext({
    home: paths.home,
    cwd: opts.cwd,
    ...(config.projectRoot === null ? {} : { projectRoot: config.projectRoot }),
  });

  let registry: RegistrySource | null = null;
  let registryError: unknown;
  const registryValue = config.effective.registry;
  // A project registry is only in effect when the user trusted it (core loadConfig).
  const registrySource = registryValue === undefined ? undefined : config.sources.registry;
  if (registryValue !== undefined && registryValue.trim() !== '') {
    try {
      // loadConfig has already resolved relative file: paths against their config file.
      registry = createRegistry(registryValue, opts.cwd, {
        allowNetworkPath: registrySource !== 'project',
      });
    } catch (error) {
      registryError = error;
      registry = brokenRegistry(registryValue, error);
    }
  }

  let projectRoot: string | null = config.projectRoot;
  const probe = createRequirementProbe(ctx, { cwd: opts.cwd, projectRoot: () => projectRoot });
  const engine = createEngine({
    cwd: opts.cwd,
    home: paths.home,
    agenthubHome: paths.agenthubHome,
    agents: createAgentPort(ctx, opts.env),
    security: createSecurityPort(),
    probe,
    registry,
  });
  projectRoot = engine.projectRoot ?? config.projectRoot;
  return {
    paths,
    config,
    registry,
    registrySource,
    registryError,
    engine: withPlanChecks(engine, probe, ctx),
  };
}
