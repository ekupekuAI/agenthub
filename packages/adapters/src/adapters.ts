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
import { AGENT_PATHS, type AgentPathEntry, normalizeSkillsDir } from './paths';
import {
  type ExecutableProbe,
  envFolder,
  type FolderProbe,
  homePath,
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
    project: new Set(entry.project.map((dir) => normalizeSkillsDir('project', dir))),
    user: new Set(entry.user.map((dir) => normalizeSkillsDir('user', dir))),
  };
  const adapter: AgentAdapter = {
    id: spec.id,
    displayName: spec.displayName,
    status: 'verified',
    paths: entry,
    detect: (ctx) => spec.detect(ctx, adapter),
    reads: (scope, dir) => read[scope].has(normalizeSkillsDir(scope, dir)),
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
): AdapterSpec['detect'] {
  return async (ctx, adapter) => {
    const [exe, folderEvidence] = await Promise.all([
      probeExecutable(ctx, command),
      probeFolders(ctx, folders(ctx)),
    ]);
    if (exe.executable === undefined && folderEvidence.length === 0) return null;
    const confidence: Confidence =
      exe.executable !== undefined && exe.version !== undefined ? 'high' : 'medium';
    return environment(adapter, confidence, exe, [...exe.evidence, ...folderEvidence]);
  };
}

const COPILOT_CHAT_EXTENSION = /^github\.copilot-chat(?:-\d|$)/i;
const COPILOT_EXTENSION = /^github\.copilot(?:-\d|$)/i;

/** Name of an installed GitHub Copilot (Chat) extension folder, preferring Copilot Chat. */
async function findCopilotExtension(ctx: DetectContext): Promise<string | undefined> {
  const entries = (await safeListDir(ctx, homePath(ctx, '.vscode', 'extensions'))).sort();
  return (
    entries.find((name) => COPILOT_CHAT_EXTENSION.test(name)) ??
    entries.find((name) => COPILOT_EXTENSION.test(name))
  );
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
  const [exe, copilot] = await Promise.all([
    probeExecutable(ctx, 'code'),
    findCopilotExtension(ctx),
  ]);
  if (exe.executable === undefined && copilot === undefined) return null;
  const evidence = [...exe.evidence];
  if (copilot !== undefined)
    evidence.push(`found Copilot extension ${copilot} in ~/.vscode/extensions`);
  else evidence.push('no GitHub Copilot extension in ~/.vscode/extensions');
  const confidence: Confidence =
    exe.executable !== undefined && exe.version !== undefined && copilot !== undefined
      ? 'high'
      : 'medium';
  return environment(adapter, confidence, exe, evidence);
}

export const claudeCodeAdapter: AgentAdapter = createAdapter({
  id: 'claude-code',
  displayName: 'Claude Code',
  detect: detectByExecutableAndFolders('claude', (ctx) => [
    { path: homePath(ctx, '.claude'), label: '~/.claude' },
    ...envFolder(ctx, 'CLAUDE_CONFIG_DIR'),
  ]),
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
