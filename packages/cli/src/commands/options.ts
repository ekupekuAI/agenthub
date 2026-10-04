import type { AgentId } from '@agenthub/core';
import { AGENT_IDS, AgentHubError } from '@agenthub/core';

/** `--agent claude-code,codex` → validated, de-duplicated ids. */
export function parseAgentIds(value: string): AgentId[] {
  const ids: AgentId[] = [];
  for (const item of value.split(',')) {
    const id = item.trim();
    if (id === '') continue;
    if (!(AGENT_IDS as readonly string[]).includes(id)) {
      throw new AgentHubError(
        'USAGE',
        `unknown agent "${id}" (known agents: ${AGENT_IDS.join(', ')})`,
      );
    }
    if (!ids.includes(id as AgentId)) ids.push(id as AgentId);
  }
  if (ids.length === 0) {
    throw new AgentHubError('USAGE', `--agent needs at least one of: ${AGENT_IDS.join(', ')}`);
  }
  return ids;
}

export function parseChannel(value: string): 'stable' | 'beta' {
  if (value !== 'stable' && value !== 'beta') {
    throw new AgentHubError('USAGE', `--channel must be "stable" or "beta", not "${value}"`);
  }
  return value;
}
