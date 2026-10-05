/**
 * `agenthub approve <skill> [--note <text>]` (trust features §6.2): record that a person reviewed
 * the capability inventory of the installed digest under the current scanner rules. Writes only
 * the lock (and an `approve` line in the audit log).
 */
import { AgentHubError } from '@agenthub/core';
import { approvalStateText, INVENTORY_CAPTION, inventoryLines } from '../capability-format';
import type { CommandContext, CommandResult } from '../context';
import { shortDigest } from '../format';
import { clean } from '../output';
import { confirm } from '../prompt';
import { approvedBy } from './plan-flow';
import { assertSkillName } from './shared';

export interface ApproveOptions {
  note?: string;
}

function checkNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const trimmed = note.trim();
  if (trimmed === '' || trimmed.length > 500 || clean(trimmed) !== trimmed) {
    throw new AgentHubError('USAGE', '--note must be one line of 1–500 printable characters');
  }
  return trimmed;
}

export async function approveCommand(
  ctx: CommandContext,
  name: string,
  opts: ApproveOptions,
): Promise<CommandResult> {
  assertSkillName(name);
  const note = checkNote(opts.note);
  const engine = await ctx.engine();
  const scope = await ctx.scope();
  const s = ctx.out.style;
  // Preview: verifies the installed bytes and rescans them; writes nothing.
  const preview = await engine.approve(name, scope, {}, { dryRun: true });
  ctx.out.print(
    `${s.bold(clean(name))} ${clean(preview.version)} (${scope})  ${s.dim(shortDigest(preview.approval.digest))}  ${s.dim(`(${INVENTORY_CAPTION})`)}`,
  );
  ctx.out.lines(inventoryLines(preview.report, s));
  ctx.out.print(`  current approval: ${approvalStateText(preview.previousState)}`);
  if (preview.newlyApproved.length > 0) {
    ctx.out.print(`  not approved before: ${preview.newlyApproved.map(clean).join(', ')}`);
  }
  if (ctx.opts.dryRun) {
    ctx.out.progress('dry run: nothing was changed');
    return { data: { dryRun: true, name, scope, newlyApproved: preview.newlyApproved } };
  }
  await confirm(`Approve what ${clean(name)} ${clean(preview.version)} can do?`, {
    ...ctx.confirmOptions(),
    defaultYes: false,
    required: true,
  });
  const by = approvedBy(ctx.env);
  const result = await engine.approve(name, scope, {
    mode: ctx.opts.yes ? 'yes' : 'prompt',
    ...(note === undefined ? {} : { note }),
    ...(by === undefined ? {} : { by }),
  });
  ctx.out.print(
    `${s.green('✔')} Approved ${s.bold(clean(name))} ${clean(result.version)}  ${s.dim(`capabilities ${shortDigest(result.approval.capabilityDigest)}`)}`,
  );
  return {
    data: {
      name,
      scope,
      digest: result.approval.digest,
      capabilityDigest: result.approval.capabilityDigest,
      rulesetDigest: result.approval.rulesetDigest,
      approvedAt: result.approval.approvedAt,
      ...(result.approval.approvedBy === undefined
        ? {}
        : { approvedBy: result.approval.approvedBy }),
      ...(result.approval.note === undefined ? {} : { note: result.approval.note }),
      newlyApproved: result.newlyApproved,
    },
  };
}
