import type { RegistrySource } from '@agenthub/core';
import { AgentHubError } from '@agenthub/core';
import type { CommandContext } from '../context';

/** The configured registry, or a USAGE error explaining how to configure one. */
export async function requireRegistry(ctx: CommandContext): Promise<RegistrySource> {
  const wiring = await ctx.wiring();
  if (wiring.registry === null) {
    throw new AgentHubError(
      'USAGE',
      'no registry configured — run "agenthub config set registry <https://… | file:<folder>>" or set AGENTHUB_REGISTRY',
    );
  }
  if (wiring.registryError !== undefined) throw wiring.registryError;
  await ctx.registryNotice();
  return wiring.registry;
}
