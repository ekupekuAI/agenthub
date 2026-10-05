/**
 * `agenthub install` with no argument: restore every skill in the scope's lock, through the
 * same plan → print → confirm → apply flow as a single install (design §8.3). The lock and the
 * project config are committed files, so a restore never applies anything the user has not
 * seen and agreed to.
 */
import type { InstallResult } from '@agenthub/core';
import { AgentHubError } from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { formatInstalled } from '../format';
import { clean } from '../output';
import { confirm, hasWarnings, planWrites } from '../prompt';
import { blockedError, printPlan } from './plan-flow';

export async function restoreCommand(ctx: CommandContext): Promise<CommandResult> {
  const engine = await ctx.engine();
  const scope = await ctx.scope();
  const s = ctx.out.style;

  if (ctx.opts.dev && !ctx.opts.yes && !ctx.opts.dryRun) {
    throw new AgentHubError(
      'USAGE',
      'install --dev without a skill name overrides policy blocks for every skill in the lock — review the plans with --dry-run, then re-run with --yes',
    );
  }
  ctx.devBanner();
  await ctx.registryNotice({ warnings: false });

  const plans = await engine.planRestore(scope, { dev: ctx.opts.dev, force: ctx.opts.force });
  if (plans.length === 0) {
    ctx.out.print(`Nothing to restore: the ${scope} lock lists no skills.`);
    return { data: { scope, dryRun: ctx.opts.dryRun, plans, restored: [] } };
  }
  plans.forEach((plan, index) => {
    printPlan(ctx, plan, `Restore plan ${index + 1}/${plans.length}`);
  });

  // Nothing is applied when any entry is blocked (revoked, policy, drift, …).
  const blocked = plans.find((plan) => plan.blockers.length > 0);
  if (blocked !== undefined) {
    const error = blockedError(blocked);
    throw new AgentHubError(error.code, `${blocked.skill.name}: ${error.message}`, error.details);
  }
  if (ctx.opts.dryRun) {
    ctx.out.progress('dry run: nothing was changed');
    return { data: { scope, dryRun: true, plans, restored: [] } };
  }

  const writing = plans.filter((plan) => planWrites(plan) || plan.needsConfirmation || plan.dev);
  if (writing.length > 0) {
    const names = writing.map((plan) => `${clean(plan.skill.name)} ${clean(plan.skill.version)}`);
    await confirm(`Restore ${names.join(', ')}?`, {
      ...ctx.confirmOptions(),
      defaultYes: !writing.some((plan) => hasWarnings(plan) || plan.dev),
      required: true,
    });
  }

  const restored: InstallResult[] = [];
  for (const plan of plans) {
    const result = await engine.apply(plan);
    restored.push(result);
    ctx.out.lines(formatInstalled('Restored', result, s));
  }
  return { data: { scope, dryRun: false, plans, restored } };
}
