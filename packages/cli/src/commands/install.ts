import type { InstallRequest } from '@agenthub/core';
import { AgentHubError } from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { formatInstalled } from '../format';
import { classifyTarget } from '../target';
import { runPlan } from './plan-flow';

export async function installCommand(
  ctx: CommandContext,
  target: string | undefined,
): Promise<CommandResult> {
  const engine = await ctx.engine();
  const scope = await ctx.scope();

  if (target === undefined) {
    if (ctx.opts.dryRun) {
      const listed = await engine.list(scope);
      ctx.out.print(`dry run: would restore ${listed.length} skill(s) from the ${scope} lock`);
      return { data: { dryRun: true, scope, skills: listed } };
    }
    ctx.devBanner();
    const results = await engine.restore(scope, { dev: ctx.opts.dev, force: ctx.opts.force });
    if (results.length === 0)
      ctx.out.print(`Nothing to restore: the ${scope} lock lists no skills.`);
    for (const result of results) ctx.out.lines(formatInstalled('Restored', result, ctx.out.style));
    return { data: { scope, restored: results } };
  }

  const source = await classifyTarget(target, { cwd: ctx.cwd });
  if (source.kind === 'registry') {
    const wiring = await ctx.wiring();
    if (wiring.registry === null) {
      throw new AgentHubError(
        'USAGE',
        `no registry configured for "${target}" — run "agenthub config set registry <https://… | file:<folder>>" or set AGENTHUB_REGISTRY`,
      );
    }
    if (wiring.registryError !== undefined) throw wiring.registryError;
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
  });
  return { data: { dryRun: flow.dryRun, plan: flow.plan, result: flow.result } };
}
