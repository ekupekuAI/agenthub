/**
 * Confirmation (design §8.3). On a terminal the prompt is [Y/n] without warnings and [y/N]
 * with warnings. Without a terminal, or with --json, --yes is required for every plan that
 * would change something.
 */
import { createInterface } from 'node:readline/promises';
import type { InstallPlan } from '@agenthub/core';
import { AgentHubError } from '@agenthub/core';
import { stripControl } from './output';

export interface PromptInput {
  isTTY?: boolean;
}

export interface ConfirmOptions {
  /** --yes */
  yes: boolean;
  /** --json */
  json: boolean;
  stdin: NodeJS.ReadableStream & PromptInput;
}

export const CONFIRMATION_REQUIRED =
  'confirmation required — re-run with --yes after reviewing the plan';

export function hasWarnings(plan: Pick<InstallPlan, 'policy'>): boolean {
  return plan.policy.findings.some((finding) => finding.decision === 'WARN');
}

/** Can we ask the user at all? */
export function canPrompt(opts: Pick<ConfirmOptions, 'json' | 'stdin'>): boolean {
  return !opts.json && opts.stdin.isTTY === true;
}

/**
 * Asks a yes/no question. `required` says whether proceeding without an answer is allowed:
 * without a terminal, a required confirmation needs --yes; an optional one proceeds.
 * Resolves when the user agrees; throws CANCELLED when they decline.
 */
export async function confirm(
  question: string,
  opts: ConfirmOptions & { defaultYes: boolean; required: boolean },
): Promise<void> {
  if (opts.yes) return;
  if (!canPrompt(opts)) {
    if (opts.required) throw new AgentHubError('USAGE', CONFIRMATION_REQUIRED);
    return;
  }
  const answer = await ask(`${question} ${opts.defaultYes ? '[Y/n]' : '[y/N]'} `, opts);
  const normalized = answer.trim().toLowerCase();
  const agreed = normalized === '' ? opts.defaultYes : normalized === 'y' || normalized === 'yes';
  if (!agreed) throw new AgentHubError('CANCELLED', 'cancelled — nothing was changed');
}

/** True when applying the plan would write anything (not every target is unchanged). */
export function planWrites(plan: Pick<InstallPlan, 'targets'>): boolean {
  return plan.targets.length === 0 || plan.targets.some((target) => target.action !== 'unchanged');
}

/**
 * One confirmation for an install or update plan. Without a terminal (or with --json) every
 * plan that writes needs --yes. `caution` makes the terminal default "no" even without
 * warnings (e.g. the skill's source registry changes).
 */
export function confirmPlan(
  plan: InstallPlan,
  question: string,
  opts: ConfirmOptions & { caution?: boolean },
): Promise<void> {
  const { caution, ...rest } = opts;
  return confirm(question, {
    ...rest,
    defaultYes: !hasWarnings(plan) && !plan.dev && caution !== true,
    required: plan.needsConfirmation || planWrites(plan) || plan.dev || caution === true,
  });
}

async function ask(text: string, opts: ConfirmOptions): Promise<string> {
  const controller = new AbortController();
  const rl = createInterface({ input: opts.stdin, output: process.stderr, terminal: true });
  rl.on('SIGINT', () => controller.abort());
  try {
    return await rl.question(stripControl(text), { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || (error as { name?: string }).name === 'AbortError') {
      throw new AgentHubError('CANCELLED', 'cancelled — nothing was changed');
    }
    throw error;
  } finally {
    rl.close();
  }
}
