/**
 * Shared plan → (dry run | blocked | confirm) → apply flow for install and update.
 */
import type { InstallPlan, InstallResult } from '@agenthub/core';
import { AgentHubError, type ErrorCode } from '@agenthub/core';
import type { CommandContext } from '../context';
import { formatInstalled, formatPlan } from '../format';
import { confirmPlan } from '../prompt';
import { resolvePaths } from '../wiring';

/** Most important blocker first: policy, then revocation, compatibility, drift, conflicts. */
const BLOCKER_ORDER: InstallPlan['blockers'][number]['code'][] = [
  'POLICY_BLOCKED',
  'REVOKED',
  'INCOMPATIBLE',
  'DRIFT',
  'CONFLICT',
];

export function blockerErrorCode(code: InstallPlan['blockers'][number]['code']): ErrorCode {
  return code === 'REVOKED' ? 'CONFLICT' : code;
}

/** The error a blocked plan exits with (design §8.3: blocked by policy → exit 3). */
export function blockedError(plan: InstallPlan): AgentHubError {
  const sorted = [...plan.blockers].sort(
    (a, b) => BLOCKER_ORDER.indexOf(a.code) - BLOCKER_ORDER.indexOf(b.code),
  );
  const first = sorted[0];
  if (first === undefined) return new AgentHubError('INTERNAL', 'plan has no blockers');
  const more = sorted.length > 1 ? ` (and ${sorted.length - 1} more)` : '';
  return new AgentHubError(blockerErrorCode(first.code), `${first.message}${more}`, {
    blockers: plan.blockers,
    plan,
  });
}

export function printPlan(ctx: CommandContext, plan: InstallPlan, title?: string): void {
  ctx.out.lines(
    formatPlan(plan, ctx.out.style, {
      home: resolvePaths(ctx.env).home,
      ...(title === undefined ? {} : { title }),
      defaultScope: !ctx.opts.global,
    }),
  );
  ctx.out.print();
}

export interface PlanFlowResult {
  plan: InstallPlan;
  result: InstallResult | null;
  dryRun: boolean;
}

/**
 * Prints the plan, then stops for --dry-run, throws for blockers, asks for confirmation and
 * applies. `verb` is used in the question and the success line.
 */
export async function runPlan(
  ctx: CommandContext,
  plan: InstallPlan,
  verb: { question: string; done: string; title?: string },
): Promise<PlanFlowResult> {
  printPlan(ctx, plan, verb.title);
  if (plan.blockers.length > 0) throw blockedError(plan);
  if (ctx.opts.dryRun) {
    ctx.out.progress('dry run: nothing was changed');
    return { plan, result: null, dryRun: true };
  }
  await confirmPlan(plan, verb.question, ctx.confirmOptions());
  const engine = await ctx.engine();
  const result = await engine.apply(plan);
  ctx.out.lines(formatInstalled(verb.done, result, ctx.out.style));
  return { plan, result, dryRun: false };
}
