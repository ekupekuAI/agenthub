import type { AgentEnvironment, DetectContext } from '@agenthub/core';
import { AGENT_IDS } from '@agenthub/core';
import { getAdapter } from './adapters';
import { createNodeDetectContext } from './context';

/**
 * Detects every supported agent on this machine, read-only and in parallel (design §7.3).
 * Agents without any evidence are left out; the rest come back in AGENT_IDS order.
 */
export async function detectAgents(
  ctx: DetectContext = createNodeDetectContext(),
): Promise<AgentEnvironment[]> {
  const results = await Promise.all(
    AGENT_IDS.map(async (id) => {
      try {
        return await getAdapter(id).detect(ctx);
      } catch {
        return null;
      }
    }),
  );
  return results.filter((result): result is AgentEnvironment => result !== null);
}
