import type { InstallPlan, InstallResult, UpdateCandidate } from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { formatInstalled, table } from '../format';
import { asAgentHubError, clean } from '../output';
import { blockedError, printPlan, runPlan } from './plan-flow';
import { requireRegistry } from './registry';
import { assertSkillName } from './shared';

export interface UpdateOptions {
  check?: boolean;
  safe?: boolean;
}

interface Skipped {
  name: string;
  current: string;
  target: string | null;
  reason: string;
}

interface Updated {
  name: string;
  from: string;
  to: string;
  result: InstallResult | null;
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
    c.reason ? `${c.status} (${c.reason})` : c.status,
  ]);
  ctx.out.lines(
    table(['SKILL', 'SCOPE', 'CURRENT', 'LATEST', 'COMPATIBLE', 'STATUS'], rows, ctx.out.style),
  );
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

export async function updateCommand(
  ctx: CommandContext,
  name: string | undefined,
  opts: UpdateOptions,
): Promise<CommandResult> {
  if (name !== undefined) assertSkillName(name);
  await requireRegistry(ctx);
  const engine = await ctx.engine();
  const scope = await ctx.scope();

  if (opts.check) {
    const candidates = await engine.checkUpdates(scope, name === undefined ? undefined : [name]);
    candidatesTable(ctx, candidates);
    return { data: { scope, candidates } };
  }

  ctx.devBanner();

  if (name !== undefined && !opts.safe) {
    const plan = await planFor(ctx, name);
    if (plan === null) {
      ctx.out.print(`${clean(name)} is up to date.`);
      return { data: { name, upToDate: true, plan: null, result: null } };
    }
    const flow = await runPlan(ctx, plan, {
      title: 'Update plan',
      question: `Update ${plan.skill.name} ${plan.previous?.version ?? ''} → ${plan.skill.version}?`,
      done: 'Updated',
    });
    return {
      data: { name, upToDate: false, dryRun: flow.dryRun, plan: flow.plan, result: flow.result },
    };
  }

  // Several skills: --safe (unattended) or every available update (one confirmation each).
  const candidates = await engine.checkUpdates(scope, name === undefined ? undefined : [name]);
  const updated: Updated[] = [];
  const skipped: Skipped[] = [];
  const failed: (Skipped & { code: string })[] = [];
  for (const candidate of candidates) {
    if (candidate.status === 'up-to-date') continue;
    if (candidate.status !== 'available') {
      skipped.push({
        name: candidate.name,
        current: candidate.current,
        target: candidate.latestCompatible,
        reason: candidate.reason ? `${candidate.status}: ${candidate.reason}` : candidate.status,
      });
      continue;
    }
    try {
      const plan = await planFor(ctx, candidate.name);
      if (plan === null) continue;
      const target = plan.skill.version;
      if (opts.safe) {
        if (plan.blockers.length > 0) {
          skipped.push({
            name: candidate.name,
            current: candidate.current,
            target,
            reason: blockedError(plan).message,
          });
          continue;
        }
        if (plan.policy.outcome !== 'allow') {
          const warns = plan.policy.findings.filter((f) => f.decision !== 'INFO');
          skipped.push({
            name: candidate.name,
            current: candidate.current,
            target,
            reason: `needs review: ${warns.map((f) => f.ruleId).join(', ') || plan.policy.outcome}`,
          });
          continue;
        }
        if (ctx.opts.dryRun) {
          updated.push({ name: candidate.name, from: candidate.current, to: target, result: null });
          continue;
        }
        const result = await engine.apply(plan);
        ctx.out.lines(formatInstalled('Updated', result, ctx.out.style));
        updated.push({ name: candidate.name, from: candidate.current, to: target, result });
        continue;
      }
      // Interactive: plan, confirm, apply — one skill at a time.
      if (plan.blockers.length > 0) {
        printPlan(ctx, plan, 'Update plan');
        skipped.push({
          name: candidate.name,
          current: candidate.current,
          target,
          reason: blockedError(plan).message,
        });
        continue;
      }
      const flow = await runPlan(ctx, plan, {
        title: 'Update plan',
        question: `Update ${plan.skill.name} ${candidate.current} → ${target}?`,
        done: 'Updated',
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
      failed.push({
        name: candidate.name,
        current: candidate.current,
        target: candidate.latestCompatible,
        reason: error instanceof Error ? error.message : String(error),
        code: known?.code ?? 'INTERNAL',
      });
    }
  }

  const s = ctx.out.style;
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
    exitCode: failed.length > 0 ? 1 : 0,
  };
}
