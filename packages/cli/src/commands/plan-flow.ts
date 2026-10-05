/**
 * Shared plan → (dry run | blocked | confirm) → apply flow for install and update.
 */
import type { ApprovalInput, InstallPlan, InstallResult } from '@agenthub/core';
import { AgentHubError, type ErrorCode, expansionTokens } from '@agenthub/core';
import { expansionCount } from '../capability-format';
import type { CommandContext } from '../context';
import { formatInstalled, formatPlan } from '../format';
import { clean } from '../output';
import { canPrompt, confirm, confirmPlan, planDefaultYes } from '../prompt';
import { resolvePaths } from '../wiring';

/** AGENTHUB_APPROVED_BY, cleaned to what the lock accepts (self-asserted, may be absent). */
export function approvedBy(env: Record<string, string | undefined>): string | undefined {
  const raw = env.AGENTHUB_APPROVED_BY;
  if (raw === undefined) return undefined;
  const value = clean(raw).trim().slice(0, 128);
  return value === '' ? undefined : value;
}

/** The error for an expansion that was not explicitly approved (exit 3, nothing written). */
export function approvalRequiredError(plan: InstallPlan): AgentHubError {
  const tokens = plan.capabilities ? expansionTokens(plan.capabilities.unapproved) : [];
  const name = plan.skill.name;
  return new AgentHubError(
    'APPROVAL_REQUIRED',
    `${name} ${plan.skill.version} can do more than the version you approved (${tokens.map((t) => `+${t}`).join(', ')}) — review it with "agenthub diff ${name}", then re-run with --approve-capabilities (--yes alone never approves new capabilities)`,
    { skill: name, version: plan.skill.version, unapproved: tokens },
  );
}

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
 * applies. `verb` is used in the question and the success line; `caution` makes the terminal
 * prompt default to "no".
 */
export async function runPlan(
  ctx: CommandContext,
  plan: InstallPlan,
  verb: {
    question: string;
    done: string;
    title?: string;
    caution?: boolean;
    /** --approve-capabilities: approve an expansion without being asked. */
    approveCapabilities?: boolean;
  },
): Promise<PlanFlowResult> {
  printPlan(ctx, plan, verb.title);
  if (plan.blockers.length > 0) throw blockedError(plan);
  if (ctx.opts.dryRun) {
    if (plan.capabilities?.approvalRequired && verb.approveCapabilities !== true) {
      ctx.out.progress(
        'dry run: applying this would need --approve-capabilities (or a yes at the prompt)',
      );
    }
    ctx.out.progress('dry run: nothing was changed');
    return { plan, result: null, dryRun: true };
  }
  const approve = await confirmCapabilities(ctx, plan, verb);
  const engine = await ctx.engine();
  const result = await engine.apply(plan, approve === undefined ? {} : { approve });
  ctx.out.lines(formatInstalled(verb.done, result, ctx.out.style));
  return { plan, result, dryRun: false };
}

/**
 * Confirmation and capability approval for one plan (trust features §4.3):
 * - no expansion: the usual plan confirmation (a fresh install's confirmation is its approval);
 * - expansion with --approve-capabilities: the plan still needs --yes or a yes at the prompt;
 * - expansion on a terminal without --yes: one question, default No;
 * - otherwise (--yes alone, --json, no terminal): APPROVAL_REQUIRED, nothing is written.
 */
async function confirmCapabilities(
  ctx: CommandContext,
  plan: InstallPlan,
  verb: { question: string; caution?: boolean; approveCapabilities?: boolean },
): Promise<ApprovalInput | undefined> {
  const options = ctx.confirmOptions();
  const by = approvedBy(ctx.env);
  const caps = plan.capabilities;
  const withBy = (input: ApprovalInput): ApprovalInput =>
    by === undefined ? input : { ...input, by };
  if (caps?.approvalRequired) {
    if (verb.approveCapabilities === true) {
      await confirmPlan(plan, verb.question, { ...options, caution: true });
      return withBy({ mode: 'flag' });
    }
    if (!ctx.opts.yes && canPrompt(options)) {
      await confirm(capabilityApprovalQuestion(plan), {
        ...options,
        defaultYes: false,
        required: true,
      });
      return withBy({ mode: 'prompt' });
    }
    throw approvalRequiredError(plan);
  }
  await confirmPlan(plan, verb.question, { ...options, caution: verb.caution === true });
  // A fresh install records an approval: say who confirmed it and how.
  if (plan.previous === undefined) return withBy({ mode: ctx.opts.yes ? 'yes' : 'prompt' });
  return verb.approveCapabilities === true ? withBy({ mode: 'flag' }) : undefined;
}

/** The question that approves an expansion (asked on its own; a plain yes never approves). */
export function capabilityApprovalQuestion(plan: InstallPlan): string {
  const count = plan.capabilities === undefined ? 0 : expansionCount(plan.capabilities.unapproved);
  const from = plan.previous === undefined ? '' : `${clean(plan.previous.version)} → `;
  return `Approve ${count} new capabilit${count === 1 ? 'y' : 'ies'} and update ${clean(plan.skill.name)} ${from}${clean(plan.skill.version)}?`;
}

/**
 * How an interactive session (a person at a terminal, no --yes, no --approve-capabilities)
 * confirms a plan — the same rules as the prompt in runPlan:
 * - 'capabilities': the plan expands beyond the approved baseline; only an explicit capability
 *   approval applies it, default No;
 * - 'plan': the usual confirmation, default No with WARN findings, --dev or `caution`.
 */
export type InteractiveConfirmation =
  | { kind: 'capabilities'; question: string; count: number; defaultYes: false }
  | { kind: 'plan'; question: string; defaultYes: boolean };

export function interactiveConfirmation(
  plan: InstallPlan,
  verb: { question: string; caution?: boolean },
): InteractiveConfirmation {
  const caps = plan.capabilities;
  if (caps?.approvalRequired) {
    return {
      kind: 'capabilities',
      question: capabilityApprovalQuestion(plan),
      count: expansionCount(caps.unapproved),
      defaultYes: false,
    };
  }
  return {
    kind: 'plan',
    question: verb.question,
    defaultYes: planDefaultYes(plan, verb.caution === true),
  };
}

/**
 * The approval an interactive yes records (runPlan's prompt path): an approved expansion, or a
 * fresh install; an update without expansion carries the existing approval forward.
 */
export function interactiveApproval(
  plan: InstallPlan,
  env: Record<string, string | undefined>,
): ApprovalInput | undefined {
  const by = approvedBy(env);
  if (plan.capabilities?.approvalRequired || plan.previous === undefined) {
    return by === undefined ? { mode: 'prompt' } : { mode: 'prompt', by };
  }
  return undefined;
}
