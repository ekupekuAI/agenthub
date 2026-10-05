import type { ErrorCode, InstallPlan, InstallResult, Scope, UpdateCandidate } from '@agenthub/core';
import { AgentHubError, EXIT_CODES, expansionTokens, sameRegistry } from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { formatInstalled, table } from '../format';
import { asAgentHubError, clean } from '../output';
import { blockedError, printPlan, runPlan } from './plan-flow';
import { requireRegistry } from './registry';
import { assertSkillName } from './shared';

export interface UpdateOptions {
  check?: boolean;
  safe?: boolean;
  /** --approve-capabilities: approve capabilities beyond the approved baseline. */
  approveCapabilities?: boolean;
}

interface Skipped {
  name: string;
  current: string;
  target: string | null;
  reason: string;
}

interface Failed extends Skipped {
  code: string;
}

interface Updated {
  name: string;
  from: string;
  to: string;
  result: InstallResult | null;
}

/** Installed versions that must not stay installed: an update has to replace them. */
const NEEDS_REPLACEMENT = new Set<string>(['current-revoked', 'current-quarantined']);

/** Exit code precedence for a run with several failures: the most security-relevant wins. */
const SEVERITY: ErrorCode[] = [
  'INTEGRITY',
  'DRIFT',
  'POLICY_BLOCKED',
  'APPROVAL_REQUIRED',
  'CONFLICT',
  'INCOMPATIBLE',
  'REGISTRY',
  'NOT_FOUND',
  'IO',
  'VALIDATION',
  'INTERNAL',
];

export function bulkExitCode(failed: { code: string }[]): number {
  if (failed.length === 0) return 0;
  for (const code of SEVERITY) {
    if (failed.some((f) => f.code === code)) return EXIT_CODES[code];
  }
  return 1;
}

function candidatesTable(ctx: CommandContext, candidates: UpdateCandidate[]): void {
  if (candidates.length === 0) {
    ctx.out.print('No installed skills to check.');
    return;
  }
  const rows = candidates.map((c) => [
    c.name,
    c.scope,
    c.current,
    c.latest ?? '—',
    c.latestCompatible ?? '—',
    changeLabel(c),
    c.reason ? `${c.status} (${c.reason})` : c.status,
  ]);
  ctx.out.lines(
    table(
      ['SKILL', 'SCOPE', 'CURRENT', 'LATEST', 'COMPATIBLE', 'CHANGE', 'STATUS'],
      rows,
      ctx.out.style,
    ),
  );
  const expanding = candidates.filter((c) => c.change?.expansion);
  for (const c of expanding) {
    ctx.out.print(
      `  ${clean(c.name)} ${clean(c.latestCompatible ?? '')} needs approval for: ${(c.change?.unapproved ?? []).map(clean).join(', ')}`,
    );
  }
  if (expanding.length > 0) {
    ctx.out.print(
      ctx.out.style.dim(
        '  (capability inventory from static analysis — review with "agenthub diff <skill>")',
      ),
    );
  }
}

/** CHANGE column: what the available version can do compared with the approved baseline. */
export function changeLabel(c: UpdateCandidate): string {
  const change = c.change;
  if (change === undefined) return '—';
  if (!change.expansion) return change.removed > 0 ? 'narrower' : 'none';
  const approvedBefore =
    change.state === 'approved' || change.state === 'approved-carried' || change.state === 'stale';
  return approvedBefore ? `expands (+${change.unapproved.length})` : 'unapproved';
}

async function checkUpdates(
  ctx: CommandContext,
  scope: Scope,
  name: string | undefined,
  capabilities?: boolean,
): Promise<UpdateCandidate[]> {
  const engine = await ctx.engine();
  const channel = ctx.channel();
  return engine.checkUpdates(scope, name === undefined ? undefined : [name], {
    ...(channel === undefined ? {} : { channel }),
    capabilities: capabilities === true,
  });
}

async function planFor(ctx: CommandContext, name: string): Promise<InstallPlan | null> {
  const engine = await ctx.engine();
  const scope = await ctx.scope();
  const opts: { dev: boolean; force: boolean; channel?: 'stable' | 'beta' } = {
    dev: ctx.opts.dev,
    force: ctx.opts.force,
  };
  const channel = ctx.channel();
  if (channel !== undefined) opts.channel = channel;
  return engine.planUpdate(name, scope, opts);
}

/**
 * Why a plan would switch the skill to a different source (a local folder or file, or another
 * registry); null when it updates from the registry it was installed from.
 */
export function sourceChange(plan: InstallPlan): string | null {
  const previous = plan.previous;
  if (previous === undefined) return null;
  const next = plan.source.registry ?? '(unknown registry)';
  if (previous.source !== 'registry') {
    return `${plan.skill.name} was installed from a local ${previous.source === 'dir' ? 'folder' : 'package'}, not from ${next}`;
  }
  if (previous.registry !== null && !sameRegistry(previous.registry, plan.source.registry)) {
    return `${plan.skill.name} was installed from ${previous.registry}, not from ${next}`;
  }
  return null;
}

export async function updateCommand(
  ctx: CommandContext,
  name: string | undefined,
  opts: UpdateOptions,
): Promise<CommandResult> {
  if (name !== undefined) assertSkillName(name);
  if (opts.safe && ctx.opts.dev) {
    throw new AgentHubError('USAGE', '--safe never overrides policy blocks; drop --dev');
  }
  if (opts.safe && opts.approveCapabilities) {
    throw new AgentHubError(
      'USAGE',
      '--safe only applies updates that need no new approval; drop --approve-capabilities',
    );
  }
  await requireRegistry(ctx);
  const engine = await ctx.engine();
  const scope = await ctx.scope();
  const s = ctx.out.style;

  if (opts.check) {
    const candidates = await checkUpdates(ctx, scope, name, true);
    candidatesTable(ctx, candidates);
    const attention = candidates.filter(
      (c) => NEEDS_REPLACEMENT.has(c.status) || c.status === 'digest-mismatch',
    );
    for (const c of attention) {
      ctx.out.warn(
        `${clean(c.name)} ${clean(c.current)}: ${clean(c.reason ?? c.status)} — run "agenthub update ${clean(c.name)}" or "agenthub remove ${clean(c.name)}"`,
      );
    }
    return {
      data: { scope, candidates, attention: attention.map((c) => c.name) },
      exitCode: attention.length > 0 ? 1 : 0,
    };
  }

  ctx.devBanner();

  if (name !== undefined && !opts.safe) {
    const plan = await planFor(ctx, name);
    if (plan === null) {
      ctx.out.print(`${clean(name)} is up to date.`);
      return { data: { name, upToDate: true, plan: null, result: null } };
    }
    const change = sourceChange(plan);
    if (change !== null) {
      ctx.out.warn(`${clean(change)}; updating replaces it with the registry's package`);
    }
    const flow = await runPlan(ctx, plan, {
      title: 'Update plan',
      question: `Update ${plan.skill.name} ${plan.previous?.version ?? ''} → ${plan.skill.version}?`,
      done: 'Updated',
      caution: change !== null,
      approveCapabilities: opts.approveCapabilities === true,
    });
    return {
      data: {
        name,
        upToDate: false,
        dryRun: flow.dryRun,
        sourceChange: change,
        plan: flow.plan,
        result: flow.result,
      },
    };
  }

  if (!opts.safe && ctx.opts.dev && !ctx.opts.yes && !ctx.opts.dryRun) {
    throw new AgentHubError(
      'USAGE',
      'update --dev without a skill name overrides policy blocks for every update — name the skill, or review with --dry-run and re-run with --yes',
    );
  }

  // Several skills: --safe (unattended) or every available update (one confirmation each).
  const candidates = await checkUpdates(ctx, scope, name);
  const updated: Updated[] = [];
  const skipped: Skipped[] = [];
  const failed: Failed[] = [];
  let integrityStop: string | null = null;
  for (const candidate of candidates) {
    const base = {
      name: candidate.name,
      current: candidate.current,
      target: candidate.latestCompatible,
    };
    const statusReason = candidate.reason
      ? `${candidate.status}: ${candidate.reason}`
      : candidate.status;
    if (candidate.status === 'up-to-date') continue;
    if (integrityStop !== null) {
      skipped.push({ ...base, reason: `not attempted after ${integrityStop}` });
      continue;
    }
    if (candidate.status === 'digest-mismatch') {
      failed.push({ ...base, reason: statusReason, code: 'INTEGRITY' });
      continue;
    }
    const replace = NEEDS_REPLACEMENT.has(candidate.status);
    const plannable =
      candidate.status === 'available' ||
      replace ||
      (candidate.status === 'drift' && ctx.opts.force && !opts.safe);
    if (!plannable) {
      skipped.push({ ...base, reason: statusReason });
      continue;
    }
    const guidance = `${statusReason} — it is still installed; review with "agenthub update ${candidate.name}" or remove it with "agenthub remove ${candidate.name}"`;
    try {
      const plan = await planFor(ctx, candidate.name);
      if (plan === null) {
        if (replace) failed.push({ ...base, reason: guidance, code: 'CONFLICT' });
        else skipped.push({ ...base, reason: 'no newer version on the selected channel' });
        continue;
      }
      const target = plan.skill.version;
      const change = sourceChange(plan);
      if (change !== null) {
        // Switching where a skill comes from is never done in bulk.
        const reason = `${change} — run "agenthub update ${candidate.name}" to switch explicitly`;
        if (replace)
          failed.push({ ...base, target, reason: `${reason}; ${guidance}`, code: 'CONFLICT' });
        else skipped.push({ ...base, target, reason });
        continue;
      }
      if (plan.blockers.length > 0) {
        if (!opts.safe) printPlan(ctx, plan, 'Update plan');
        const error = blockedError(plan);
        failed.push({
          ...base,
          target,
          reason: replace ? `${error.message}; ${guidance}` : error.message,
          code: error.code,
        });
        continue;
      }
      if (opts.safe) {
        const reason = safeSkipReason(plan);
        if (reason !== null) {
          if (replace) {
            failed.push({ ...base, target, reason: `${reason}; ${guidance}`, code: 'CONFLICT' });
          } else {
            skipped.push({ ...base, target, reason });
          }
          continue;
        }
        if (ctx.opts.dryRun) {
          updated.push({ name: candidate.name, from: candidate.current, to: target, result: null });
          continue;
        }
        // No expansion, so nothing new is approved: the approval is carried forward.
        const result = await engine.apply(plan);
        ctx.out.lines(formatInstalled('Updated', result, s));
        updated.push({ name: candidate.name, from: candidate.current, to: target, result });
        continue;
      }
      // Interactive: plan, confirm, apply — one skill at a time.
      const flow = await runPlan(ctx, plan, {
        title: 'Update plan',
        question: `Update ${plan.skill.name} ${candidate.current} → ${target}?`,
        done: 'Updated',
        approveCapabilities: opts.approveCapabilities === true,
      });
      updated.push({
        name: candidate.name,
        from: candidate.current,
        to: target,
        result: flow.result,
      });
    } catch (error) {
      const known = asAgentHubError(error);
      if (known?.code === 'CANCELLED' || known?.code === 'USAGE') throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = known?.code ?? 'INTERNAL';
      failed.push({ ...base, reason: replace ? `${message}; ${guidance}` : message, code });
      // A registry that served a mismatching archive is not trusted for the rest of the run.
      if (code === 'INTEGRITY') integrityStop = `an integrity failure for ${candidate.name}`;
    }
  }

  ctx.out.print();
  ctx.out.print(s.bold('Summary'));
  const verb = ctx.opts.dryRun ? 'would update' : 'updated';
  if (updated.length === 0 && skipped.length === 0 && failed.length === 0) {
    ctx.out.print(`  ${s.green('✔')} everything is up to date`);
  }
  for (const u of updated)
    ctx.out.print(`  ${s.green('✔')} ${verb} ${clean(u.name)} ${clean(u.from)} → ${clean(u.to)}`);
  for (const k of skipped)
    ctx.out.print(
      `  ${s.yellow('-')} skipped ${clean(k.name)} ${clean(k.current)}: ${clean(k.reason)}`,
    );
  for (const f of failed)
    ctx.out.print(
      `  ${s.red('✘')} failed ${clean(f.name)} ${clean(f.current)}: ${clean(f.reason)}`,
    );
  return {
    data: { scope, safe: opts.safe === true, dryRun: ctx.opts.dryRun, updated, skipped, failed },
    exitCode: bulkExitCode(failed),
  };
}

const OUTCOME_RANK = { allow: 0, confirm: 1, block: 2 } as const;

/**
 * Why `update --safe` must not apply a plan (trust features §4.3), or null: it applies only an
 * update with no capability expansion, an approval that still holds, and a policy outcome no
 * worse than the installed version's. It never prompts and never approves.
 */
export function safeSkipReason(plan: InstallPlan): string | null {
  if (plan.dev) return 'needs review: --dev';
  const caps = plan.capabilities;
  if (caps === undefined) return 'needs review: no capability report';
  if (caps.approvalRequired) {
    const tokens = expansionTokens(caps.unapproved).map((t) => `+${t}`);
    if (caps.state === 'approved' || caps.state === 'approved-carried') {
      return `capability expansion: ${tokens.join(', ')}`;
    }
  }
  if (caps.state === 'stale')
    return `approval stale (new under the current rules: ${caps.stale.join(', ')})`;
  if (caps.state === 'unavailable') return 'approval cannot be checked: no intact installed copy';
  if (caps.state !== 'approved' && caps.state !== 'approved-carried') return 'approval missing';
  if (caps.approvalRequired) return 'capability expansion';
  const previous = caps.previousOutcome ?? 'block';
  if (OUTCOME_RANK[plan.policy.outcome] > OUTCOME_RANK[previous]) {
    const warns = plan.policy.findings.filter((f) => f.decision !== 'INFO').map((f) => f.ruleId);
    return `needs review: policy outcome ${plan.policy.outcome} (was ${previous}): ${[...new Set(warns)].join(', ')}`;
  }
  return null;
}
