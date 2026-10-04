/**
 * Builds the install engine's ports from the real machine: agent adapters, the scanner, a
 * requirement probe and the configured registry.
 */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNodeDetectContext,
  detectAgents,
  duplicateAgents,
  getAdapter,
  PATH_TABLE_VERSION,
  selectTargetFolders,
} from '@agenthub/adapters';
import type {
  AgentEnvironment,
  AgentHubConfig,
  AgentId,
  AgentPort,
  Confidence,
  DetectContext,
  Engine,
  RegistrySource,
  RequirementProbe,
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

const PROBE_TIMEOUT_MS = 5000;
const VERSION_TOKEN = /\d+(\.\d+){0,2}/;
/** Names a package may ask us to look up; never paths. */
const SAFE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** Commands that are never started, even with --version. */
const NEVER_RUN = new Set([
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'init',
  'telinit',
  'format',
  'mkfs',
  'dd',
  'rm',
  'del',
  'rd',
  'rmdir',
  'kill',
  'killall',
  'pkill',
  'taskkill',
]);

export function firstVersionToken(text: string): string | null {
  return VERSION_TOKEN.exec(text)?.[0] ?? null;
}

export function createRequirementProbe(ctx: DetectContext): RequirementProbe {
  const runtimes = new Map<string, Promise<string | null>>();
  const commands = new Map<string, Promise<boolean>>();

  async function versionOf(command: string, args: string[]): Promise<string | null> {
    if (!SAFE_COMMAND.test(command) || NEVER_RUN.has(command.toLowerCase())) return null;
    const executable = await ctx.which(command).catch(() => null);
    if (executable === null) return null;
    const result = await ctx.run(executable, args, PROBE_TIMEOUT_MS).catch(() => null);
    if (result === null || result.code !== 0) return null;
    return firstVersionToken(result.stdout.trim() !== '' ? result.stdout : result.stderr);
  }

  async function probeRuntime(name: string): Promise<string | null> {
    const key = name.trim().toLowerCase();
    if (key === 'node' || key === 'nodejs') return process.versions.node;
    if (key === 'python' || key === 'python3') {
      for (const candidate of ['python3', 'python', 'py']) {
        const version = await versionOf(candidate, ['--version']);
        if (version !== null) return version;
      }
      return null;
    }
    if (key === 'go') return versionOf('go', ['version']);
    return versionOf(key, ['--version']);
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
  };
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

export function createRegistry(value: string, baseDir: string): RegistrySource {
  const trimmed = value.trim();
  if (trimmed.startsWith('file:')) {
    let dir: string;
    if (trimmed.startsWith('file://')) {
      try {
        dir = fileURLToPath(trimmed);
      } catch {
        throw new AgentHubError('USAGE', `invalid file registry URL: ${trimmed}`);
      }
    } else {
      dir = trimmed.slice('file:'.length);
    }
    if (dir === '') throw new AgentHubError('USAGE', 'file registry path must not be empty');
    return createFileRegistry(isAbsolute(dir) ? dir : resolve(baseDir, dir));
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
  /** The configuration error that made the registry unusable, if any. */
  registryError: unknown;
  engine: Engine;
}

export interface WiringOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  flags?: Partial<AgentHubConfig>;
}

export async function loadEffectiveConfig(opts: WiringOptions): Promise<LoadedConfig> {
  const paths = resolvePaths(opts.env);
  return loadConfig({
    cwd: opts.cwd,
    home: paths.home,
    agenthubHome: paths.agenthubHome,
    env: opts.env,
    flags: opts.flags ?? {},
  });
}

export async function createWiring(opts: WiringOptions): Promise<Wiring> {
  const paths = resolvePaths(opts.env);
  const config = await loadEffectiveConfig(opts);
  const ctx = createNodeDetectContext({ home: paths.home });

  let registry: RegistrySource | null = null;
  let registryError: unknown;
  const registryValue = config.effective.registry;
  if (registryValue !== undefined && registryValue.trim() !== '') {
    try {
      // loadConfig has already resolved relative file: paths against their config file.
      registry = createRegistry(registryValue, opts.cwd);
    } catch (error) {
      registryError = error;
      registry = brokenRegistry(registryValue, error);
    }
  }

  const engine = createEngine({
    cwd: opts.cwd,
    home: paths.home,
    agenthubHome: paths.agenthubHome,
    agents: createAgentPort(ctx, opts.env),
    security: createSecurityPort(),
    probe: createRequirementProbe(ctx),
    registry,
  });
  return { paths, config, registry, registryError, engine };
}
