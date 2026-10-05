/**
 * Where each supported agent reads skills (design §7.1).
 *
 * This is the single data file for agent skill locations. Every row carries the official
 * documentation it was verified against and the verification date; `doctor` prints it.
 * All paths are POSIX, relative to the project root (`project`) or the home directory (`user`).
 */
import type { AgentId, AgentPathTable, Scope } from '@agenthub/core';

/** Date the table below was last checked against each agent's official docs. */
export const PATH_TABLE_VERSION = '2026-09-28';

/** Folders an agent still reads but its maintainers mark deprecated. agenthub never writes there. */
export interface LegacyPaths {
  project: string[];
  user: string[];
  note: string;
}

export interface AgentPathEntry extends AgentPathTable {
  /** Shown after an install creates a skills folder that did not exist before (design §7.4). */
  reloadHint?: string;
  legacy?: LegacyPaths;
}

export const AGENT_PATHS: Record<AgentId, AgentPathEntry> = {
  // `CLAUDE_CONFIG_DIR` relocates the user-level folder. For the MVP, user-scope installs still
  // target `~/.claude/skills` as listed here; claudeUserSkillsRelocation() reports when that
  // folder is not the one Claude Code reads, and detection says so in its evidence.
  'claude-code': {
    project: ['.claude/skills'],
    user: ['.claude/skills'],
    sources: ['https://code.claude.com/docs/en/skills'],
    verifiedAt: PATH_TABLE_VERSION,
    reloadHint: 'Claude Code: run /reload-skills in an open session if this is a new skills folder',
  },
  codex: {
    project: ['.agents/skills'],
    user: ['.agents/skills'],
    sources: ['https://learn.chatgpt.com/docs/build-skills'],
    verifiedAt: PATH_TABLE_VERSION,
    legacy: {
      project: ['.codex/skills'],
      user: ['.codex/skills'],
      note: 'Codex still loads .codex/skills and $CODEX_HOME/skills, but marks them deprecated',
    },
  },
  cursor: {
    project: ['.agents/skills', '.cursor/skills', '.claude/skills', '.codex/skills'],
    user: ['.agents/skills', '.cursor/skills', '.claude/skills', '.codex/skills'],
    sources: ['https://cursor.com/docs/skills'],
    verifiedAt: PATH_TABLE_VERSION,
    reloadHint: 'Cursor CLI: restart to pick up a new skills folder',
  },
  vscode: {
    project: ['.github/skills', '.claude/skills', '.agents/skills'],
    user: ['.copilot/skills', '.claude/skills', '.agents/skills'],
    sources: [
      'https://code.visualstudio.com/docs/agent-customization/agent-skills',
      'https://docs.github.com/en/copilot/concepts/agents/about-agent-skills',
    ],
    verifiedAt: PATH_TABLE_VERSION,
    reloadHint: 'Copilot CLI: run /skills reload',
  },
};

/**
 * Folders agenthub may write into, in preference order (design §7.2). The legacy Codex
 * folders are deliberately absent. Frozen: isWritableSkillsDir() relies on it.
 */
export const WRITE_CANDIDATES: Readonly<Record<Scope, readonly string[]>> = Object.freeze({
  project: Object.freeze(['.agents/skills', '.claude/skills', '.cursor/skills', '.github/skills']),
  user: Object.freeze(['.agents/skills', '.claude/skills', '.cursor/skills', '.copilot/skills']),
});

/**
 * May agenthub write skills into `dir` at `scope`? Exact match only: `dir` must be one of
 * WRITE_CANDIDATES[scope] spelled canonically (POSIX, relative to the project root or home,
 * no `~/`, `./`, backslashes, padding or trailing slash). Legacy folders such as
 * `.codex/skills` are never writable, even though some agents still read them.
 *
 * Use this, not an adapter's reads(), to validate any folder that will be written, in
 * particular folders taken from a lock file, which is untrusted input.
 */
export function isWritableSkillsDir(scope: Scope, dir: string): boolean {
  return WRITE_CANDIDATES[scope].includes(dir) && !isLegacySkillsDir(scope, dir);
}

/** Is `dir` (canonical spelling) a deprecated folder that agenthub must never write? */
export function isLegacySkillsDir(scope: Scope, dir: string): boolean {
  return Object.values(AGENT_PATHS).some((entry) => entry.legacy?.[scope].includes(dir) ?? false);
}

/**
 * Normalizes a hand-typed skills folder for display and lookup: forward slashes, no leading
 * `./`, no duplicate or trailing slashes; at user scope one leading `~/` is dropped.
 * Comparison stays case-sensitive, like the folders the agents look for. Whitespace is kept
 * (it is part of a folder name).
 *
 * This is deliberately lenient and must not be used to validate untrusted input: an adapter's
 * reads() and isWritableSkillsDir() accept only the canonical spelling.
 */
export function normalizeSkillsDir(scope: Scope, dir: string): string {
  let out = dir.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (scope === 'user' && out.startsWith('~/')) out = out.slice(2);
  while (out.startsWith('./')) out = out.slice(2);
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}
