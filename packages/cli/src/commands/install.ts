import type { InstallRequest } from '@agenthub/core';
import { AgentHubError } from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { clean } from '../output';
import { classifyTarget, shadowedLocalPath } from '../target';
import { runPlan } from './plan-flow';
import { restoreCommand } from './restore';

export interface InstallOptions {
  /** --approve-capabilities: approve capabilities beyond the approved baseline (replace only). */
  approveCapabilities?: boolean;
}

export async function installCommand(
  ctx: CommandContext,
  target: string | undefined,
  opts: InstallOptions = {},
): Promise<CommandResult> {
  if (target === undefined) return restoreCommand(ctx);
  const engine = await ctx.engine();
  const scope = await ctx.scope();

  const source = await classifyTarget(target, { cwd: ctx.cwd });
  if (source.kind === 'registry') {
    const wiring = await ctx.wiring();
    const local = await shadowedLocalPath(target, { cwd: ctx.cwd });
    const localHint =
      local === null ? '' : ` (to install the local folder, use "./${clean(source.name)}")`;
    if (wiring.registry === null) {
      throw new AgentHubError(
        'USAGE',
        `no registry configured for "${clean(target)}" — run "agenthub config set registry <https://… | file:<folder>>" or set AGENTHUB_REGISTRY${localHint}`,
      );
    }
    if (local !== null) {
      ctx.out.notice(
        `note: installing "${clean(source.name)}" from the registry, not the folder ${clean(local)}${localHint}`,
      );
    }
    if (wiring.registryError !== undefined) throw wiring.registryError;
    await ctx.registryNotice({ warnings: false });
  }

  ctx.devBanner();
  const request: InstallRequest = {
    source,
    scope,
    dev: ctx.opts.dev,
    force: ctx.opts.force,
  };
  const agents = ctx.agents();
  if (agents !== undefined) request.agents = agents;
  const channel = ctx.channel();
  if (channel !== undefined) request.channel = channel;

  const plan = await engine.plan(request);
  const flow = await runPlan(ctx, plan, {
    question: `Install ${plan.skill.name} ${plan.skill.version}?`,
    done: 'Installed',
    approveCapabilities: opts.approveCapabilities === true,
  });
  return { data: { dryRun: flow.dryRun, plan: flow.plan, result: flow.result } };
}
