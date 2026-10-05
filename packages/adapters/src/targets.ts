/**
 * Choosing which skills folders to write for a set of agents: the smallest cover (design §7.2).
 */
import type { AgentId, Scope, TargetFolder } from '@agenthub/core';
import { AGENT_IDS, AgentHubError } from '@agenthub/core';
import { getAdapter, isAgentId } from './adapters';
import { isWritableSkillsDir, normalizeSkillsDir, WRITE_CANDIDATES } from './paths';

/** Every folder `agent` reads skills from at `scope`, as listed in the path table. */
export function foldersReadBy(agent: AgentId, scope: Scope): string[] {
  return [...getAdapter(agent).paths[scope]];
}

/**
 * Every supported agent that loads skills from `dir` (canonical spelling) at `scope`,
 * whether or not it was selected. A plan should disclose the readers beyond the selected
 * agents: writing `.claude/skills` for claude-code also exposes the skill to Cursor and
 * VS Code + Copilot.
 */
export function readersOf(scope: Scope, dir: string): AgentId[] {
  return AGENT_IDS.filter((id) => getAdapter(id).reads(scope, dir));
}

/**
 * The smallest set of write candidates such that every selected agent reads at least one of
 * them. Among sets of equal size the one with the most preferred folders wins (the sorted
 * candidate indexes compared lexicographically, lower first). Each folder lists the selected
 * agents that read it, so an agent can appear under more than one folder. Output follows
 * preference order.
 *
 * `candidates` defaults to WRITE_CANDIDATES[scope] and only needs overriding in tests; every
 * candidate must pass isWritableSkillsDir() (USAGE error otherwise), so a legacy folder such
 * as `.codex/skills` can never be chosen.
 */
export function selectTargetFolders(
  scope: Scope,
  agents: AgentId[],
  candidates: readonly string[] = WRITE_CANDIDATES[scope],
): TargetFolder[] {
  for (const agent of agents) {
    if (!isAgentId(agent)) {
      throw new AgentHubError(
        'USAGE',
        `Unknown agent "${agent}". Known agents: ${AGENT_IDS.join(', ')}`,
      );
    }
  }
  for (const dir of candidates) {
    if (!isWritableSkillsDir(scope, dir)) {
      throw new AgentHubError(
        'USAGE',
        `${JSON.stringify(dir)} is not a ${scope} skills folder agenthub writes`,
        { scope, dir, writable: [...WRITE_CANDIDATES[scope]] },
      );
    }
  }
  const selected = AGENT_IDS.filter((id) => agents.includes(id));
  if (selected.length === 0) return [];

  const options: TargetFolder[] = [];
  for (const dir of candidates) {
    if (options.some((option) => option.dir === dir)) continue;
    options.push({ dir, agents: selected.filter((id) => getAdapter(id).reads(scope, dir)) });
  }

  const uncovered = selected.filter((id) => !options.some((option) => option.agents.includes(id)));
  if (uncovered.length > 0) {
    throw new AgentHubError(
      'INCOMPATIBLE',
      `No ${scope} skills folder agenthub can write is read by ${uncovered.join(', ')}`,
      { scope, agents: uncovered, candidates: options.map((option) => option.dir) },
    );
  }

  for (let size = 1; size <= options.length; size++) {
    for (const subset of combinations(options, size)) {
      if (selected.every((id) => subset.some((option) => option.agents.includes(id)))) {
        return subset.map((option) => ({ dir: option.dir, agents: [...option.agents] }));
      }
    }
  }
  // Unreachable: the full candidate set covers everyone once the check above has passed.
  throw new AgentHubError('INTERNAL', 'smallest-cover search found no covering set');
}

/**
 * Agents that will see the skill in more than one of `folders`. By default every supported
 * agent is considered, the same rule `doctor` applies to installed skills, so a plan and the
 * next doctor run agree; pass `among` (e.g. the detected agents) to narrow it.
 */
export function duplicateAgents(
  scope: Scope,
  folders: TargetFolder[],
  among: readonly AgentId[] = AGENT_IDS,
): AgentId[] {
  const dirs = [...new Set(folders.map((folder) => normalizeSkillsDir(scope, folder.dir)))];
  const considered = AGENT_IDS.filter((id) => among.includes(id));
  return considered.filter((id) => {
    const adapter = getAdapter(id);
    return dirs.filter((dir) => adapter.reads(scope, dir)).length > 1;
  });
}

/** Subsets of `items` of the given size, in lexicographic order of their indexes. */
function* combinations<T>(items: readonly T[], size: number, start = 0): Generator<T[]> {
  if (size === 0) {
    yield [];
    return;
  }
  for (const [index, head] of items.entries()) {
    if (index < start || index > items.length - size) continue;
    for (const tail of combinations(items, size - 1, index + 1)) yield [head, ...tail];
  }
}
