/**
 * Confirmation (design §8.3). On a terminal the prompt is [Y/n] without warnings and [y/N]
 * with warnings. Without a terminal, or with --json, a plan that needs confirmation requires
 * --yes.
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

/** One confirmation for an install or update plan. */
export function confirmPlan(
  plan: InstallPlan,
  question: string,
  opts: ConfirmOptions,
): Promise<void> {
  return confirm(question, {
    ...opts,
    defaultYes: !hasWarnings(plan),
    required: plan.needsConfirmation,
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
