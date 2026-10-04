import type { AgentId } from '@agenthub/core';
import { AgentHubError } from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { agentList, table } from '../format';
import { requireRegistry } from './registry';

export async function searchCommand(
  ctx: CommandContext,
  query: string,
  opts: { category?: string },
): Promise<CommandResult> {
  const registry = await requireRegistry(ctx);
  if (registry.search === undefined) {
    throw new AgentHubError(
      'USAGE',
      `the configured registry (${registry.id}) does not support search`,
    );
  }
  const agent = ctx.opts.agent;
  if (agent !== undefined && agent.length > 1) {
    throw new AgentHubError('USAGE', 'search takes a single --agent');
  }
  const filters: { agent?: AgentId; category?: string } = {};
  if (agent?.[0] !== undefined) filters.agent = agent[0];
  if (opts.category !== undefined) filters.category = opts.category;
  const results = await registry.search(query, filters);
  if (results.length === 0) {
    ctx.out.print('No skills found.');
  } else {
    const rows = results.map((result) => [
      result.name === result.slug ? result.slug : `${result.slug} (${result.name})`,
      result.latestVersion ?? '—',
      agentList(result.agents),
      result.scanOutcome ?? '—',
      result.publisher === undefined
        ? '—'
        : `${result.publisher.name}${result.publisher.verified ? ' ✔' : ''}`,
    ]);
    ctx.out.lines(table(['SKILL', 'LATEST', 'AGENTS', 'SCAN', 'PUBLISHER'], rows, ctx.out.style));
  }
  return { data: { query, registry: registry.id, results } };
}
