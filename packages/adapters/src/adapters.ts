/**
 * The four verified agent adapters: claude-code, codex, cursor and vscode (design §7).
 */
import type {
  AgentAdapter,
  AgentEnvironment,
  AgentId,
  Confidence,
  DetectContext,
  Scope,
} from '@agenthub/core';
import { AGENT_IDS, AgentHubError } from '@agenthub/core';
import { AGENT_PATHS, type AgentPathEntry } from './paths';
import {
  displayPath,
  type ExecutableProbe,
  envFolder,
  type FolderProbe,
  homePath,
  pathApi,
  probeExecutable,
  probeFolders,
  safeListDir,
} from './probe';

interface AdapterSpec {
  id: AgentId;
  displayName: string;
  detect(ctx: DetectContext, adapter: AgentAdapter): Promise<AgentEnvironment | null>;
}

function createAdapter(spec: AdapterSpec): AgentAdapter {
  const entry: AgentPathEntry = AGENT_PATHS[spec.id];
  const read: Record<Scope, Set<string>> = {
    project: new Set(entry.project),
    user: new Set(entry.user),
  };
  const adapter: AgentAdapter = {
    id: spec.id,
    displayName: spec.displayName,
    status: 'verified',
    paths: entry,
    detect: (ctx) => spec.detect(ctx, adapter),
    // Exact match against the table's canonical spelling. reads() validates folders taken
    // from untrusted lock files, which are then written verbatim, so no lenient normalizing
    // (padding, backslashes, `./`, `~/`) is applied here.
    reads: (scope, dir) => read[scope].has(dir),
  };
  if (entry.reloadHint !== undefined) adapter.reloadHint = entry.reloadHint;
  return adapter;
}

function environment(
  adapter: AgentAdapter,
  confidence: Confidence,
  exe: ExecutableProbe,
  evidence: string[],
): AgentEnvironment {
  const env: AgentEnvironment = {
    id: adapter.id,
    displayName: adapter.displayName,
    confidence,
    evidence,
    status: adapter.status,
  };
  if (exe.version !== undefined) env.version = exe.version;
  if (exe.executable !== undefined) env.executable = exe.executable;
  return env;
}

/**
 * Executable + version plus optional folder evidence.
 * high = the executable answered with a version; medium = executable without a version, or
 * folder evidence only; null = no evidence at all.
 */
function detectByExecutableAndFolders(
  command: string,
  folders: (ctx: DetectContext) => FolderProbe[],
  notes: (ctx: DetectContext) => string[] = () => [],
): AdapterSpec['detect'] {
  return async (ctx, adapter) => {
    const [exe, folderEvidence] = await Promise.all([
      probeExecutable(ctx, command),
      probeFolders(ctx, folders(ctx)),
    ]);
    if (exe.executable === undefined && folderEvidence.length === 0) return null;
    const confidence: Confidence =
      exe.executable !== undefined && exe.version !== undefined ? 'high' : 'medium';
    return environment(adapter, confidence, exe, [
      ...exe.evidence,
      ...folderEvidence,
      ...notes(ctx),
    ]);
  };
}

export interface ClaudeUserSkillsRelocation {
  /** `$CLAUDE_CONFIG_DIR`, resolved to an absolute path. */
  configDir: string;
  /** The user skills folder Claude Code actually reads: `<configDir>/skills`. */
  skillsDir: string;
}

/**
 * When `$CLAUDE_CONFIG_DIR` points away from `~/.claude`, Claude Code reads user skills from
 * `<CLAUDE_CONFIG_DIR>/skills`, not from `~/.claude/skills` (the user-scope folder in the path
 * table). Callers planning a user-scope install for claude-code should block or warn when
 * this returns a value. Relative values are ignored, like everywhere else in detection.
 */
export function claudeUserSkillsRelocation(
  ctx: Pick<DetectContext, 'env' | 'home' | 'platform'>,
): ClaudeUserSkillsRelocation | undefined {
  const [folder] = envFolder(ctx, 'CLAUDE_CONFIG_DIR');
  if (folder === undefined) return undefined;
  const p = pathApi(ctx);
  const configDir = p.resolve(folder.path);
  const standard = p.resolve(homePath(ctx, '.claude'));
  const same =
    ctx.platform === 'win32'
      ? configDir.toLowerCase() === standard.toLowerCase()
      : configDir === standard;
  if (same) return undefined;
  return { configDir, skillsDir: p.join(configDir, 'skills') };
}

function claudeRelocationNotes(ctx: DetectContext): string[] {
  const moved = claudeUserSkillsRelocation(ctx);
  if (moved === undefined) return [];
  return [
    `$CLAUDE_CONFIG_DIR moves the user skills folder to ${displayPath(ctx, moved.skillsDir)}; ` +
      'user-scope installs to ~/.claude/skills are not loaded',
  ];
}

const COPILOT_CHAT_EXTENSION = /^github\.copilot-chat(?:-\d|$)/i;
const COPILOT_EXTENSION = /^github\.copilot(?:-\d|$)/i;

/** Copilot Chat as shipped inside VS Code itself (`resources/app/extensions/copilot`). */
const BUILT_IN_COPILOT = /^(?:copilot|copilot-chat)$/i;
/** Per-commit install folder of current VS Code builds, e.g. `7debcd0e2a`. */
const COMMIT_FOLDER = /^[0-9a-f]{7,40}$/i;

/** Name of an installed GitHub Copilot (Chat) extension folder, preferring Copilot Chat. */
async function findCopilotExtension(ctx: DetectContext): Promise<string | undefined> {
  const entries = (await safeListDir(ctx, homePath(ctx, '.vscode', 'extensions'))).sort();
  return (
    entries.find((name) => COPILOT_CHAT_EXTENSION.test(name)) ??
    entries.find((name) => COPILOT_EXTENSION.test(name))
  );
}

/**
 * Path of the Copilot Chat extension bundled with the VS Code install that `code` belongs
 * to, if any. `code` lives in `<install>/bin`; built-in extensions are in
 * `<install>/resources/app/extensions`, `<install>/<commit>/resources/app/extensions`
 * (current Windows builds) or, on macOS where `bin` sits inside `Resources/app`,
 * `<app>/extensions`. Read-only: directory listings only.
 */
async function findBuiltInCopilot(
  ctx: DetectContext,
  executable: string,
): Promise<string | undefined> {
  const p = pathApi(ctx);
  const install = p.dirname(p.dirname(executable));
  const dirs = [p.join(install, 'resources', 'app', 'extensions'), p.join(install, 'extensions')];
  for (const entry of (await safeListDir(ctx, install)).sort()) {
    if (COMMIT_FOLDER.test(entry)) {
      dirs.push(p.join(install, entry, 'resources', 'app', 'extensions'));
    }
  }
  for (const dir of dirs) {
    const hit = (await safeListDir(ctx, dir)).sort().find((name) => BUILT_IN_COPILOT.test(name));
    if (hit !== undefined) return p.join(dir, hit);
  }
  return undefined;
}

/**
 * VS Code counts as a skills agent only with GitHub Copilot. high = `code --version` answered
 * and a Copilot extension is installed; medium = `code` without a version or without Copilot,
 * or the Copilot extension alone; null = neither.
 */
async function detectVsCode(
  ctx: DetectContext,
  adapter: AgentAdapter,
): Promise<AgentEnvironment | null> {
  const [exe, userCopilot] = await Promise.all([
    probeExecutable(ctx, 'code'),
    findCopilotExtension(ctx),
  ]);
  if (exe.executable === undefined && userCopilot === undefined) return null;
  const builtIn =
    userCopilot === undefined && exe.executable !== undefined
      ? await findBuiltInCopilot(ctx, exe.executable)
      : undefined;
  const evidence = [...exe.evidence];
  if (userCopilot !== undefined) {
    evidence.push(`found Copilot extension ${userCopilot} in ~/.vscode/extensions`);
  } else if (builtIn !== undefined) {
    evidence.push(`found built-in Copilot extension at ${displayPath(ctx, builtIn)}`);
  } else {
    evidence.push('GitHub Copilot extension not found');
  }
  const copilot = userCopilot ?? builtIn;
  const confidence: Confidence =
    exe.executable !== undefined && exe.version !== undefined && copilot !== undefined
      ? 'high'
      : 'medium';
  return environment(adapter, confidence, exe, evidence);
}

export const claudeCodeAdapter: AgentAdapter = createAdapter({
  id: 'claude-code',
  displayName: 'Claude Code',
  detect: detectByExecutableAndFolders(
    'claude',
    (ctx) => [
      { path: homePath(ctx, '.claude'), label: '~/.claude' },
      ...envFolder(ctx, 'CLAUDE_CONFIG_DIR'),
    ],
    claudeRelocationNotes,
  ),
});

export const codexAdapter: AgentAdapter = createAdapter({
  id: 'codex',
  displayName: 'Codex',
  detect: detectByExecutableAndFolders('codex', (ctx) => [
    { path: homePath(ctx, '.codex'), label: '~/.codex' },
    ...envFolder(ctx, 'CODEX_HOME'),
  ]),
});

export const cursorAdapter: AgentAdapter = createAdapter({
  id: 'cursor',
  displayName: 'Cursor',
  // `cursor --version` is undocumented; its first line is the version.
  detect: detectByExecutableAndFolders('cursor', (ctx) => [
    { path: homePath(ctx, '.cursor'), label: '~/.cursor' },
  ]),
});

export const vscodeAdapter: AgentAdapter = createAdapter({
  id: 'vscode',
  displayName: 'VS Code + GitHub Copilot',
  detect: detectVsCode,
});

/** All adapters, in AGENT_IDS order. */
export const ADAPTERS: AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  cursorAdapter,
  vscodeAdapter,
];

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export function getAdapter(id: AgentId): AgentAdapter {
  const adapter = ADAPTERS.find((candidate) => candidate.id === id);
  if (adapter === undefined) {
    throw new AgentHubError(
      'USAGE',
      `Unknown agent "${id}". Known agents: ${AGENT_IDS.join(', ')}`,
    );
  }
  return adapter;
}
