/**
 * `agenthub diff <skill> [--to <version>]` (trust features §6.1): what a registry version can do
 * that the installed one cannot, and which files change. Read-only: the candidate is downloaded
 * and verified in memory; nothing is written.
 */
import type { SkillDiff } from '@agenthub/core';
import { AgentHubError } from '@agenthub/core';
import {
  approvalStateText,
  deltaLines,
  fileSummaryLine,
  INVENTORY_CAPTION,
} from '../capability-format';
import type { CommandContext, CommandResult } from '../context';
import { clean } from '../output';
import { requireRegistry } from './registry';
import { assertSkillName } from './shared';

export interface DiffOptions {
  to?: string;
}

export function formatDiff(diff: SkillDiff, ctx: CommandContext): string[] {
  const s = ctx.out.style;
  const lines = [
    `${s.bold(clean(diff.name))} ${clean(diff.from.version)} → ${clean(diff.to.version)}   ${s.dim(`(${INVENTORY_CAPTION})`)}`,
  ];
  if (diff.from.digest === diff.to.digest) {
    lines.push('  the same files as installed');
    return lines;
  }
  const rows = deltaLines(diff.delta, s);
  lines.push(...(rows.length > 0 ? rows : ['  no capability changes found by static analysis']));
  const undeclared = diff.candidate.undeclared;
  if (undeclared.length > 0) {
    lines.push(`  observed but not declared by the publisher: ${undeclared.map(clean).join(', ')}`);
  }
  lines.push(`  ${fileSummaryLine(diff.files)}`);
  lines.push(
    `  installed version: ${diff.baseline === 'unavailable' ? 'no intact copy to rescan' : approvalStateText(diff.baseline)}`,
  );
  if (diff.approvalRequired) {
    const n = diff.unapproved.length;
    lines.push(
      s.yellow(
        `Expansion: ${n} capabilit${n === 1 ? 'y needs' : 'ies need'} approval before this update can be applied (${diff.unapproved.map(clean).join(', ')}).`,
      ),
    );
  } else {
    lines.push(
      'No expansion found by static analysis. A capability diff cannot see prose-only changes: read the SKILL.md change.',
    );
  }
  return lines;
}

export async function diffCommand(
  ctx: CommandContext,
  name: string,
  opts: DiffOptions,
): Promise<CommandResult> {
  assertSkillName(name);
  if (opts.to !== undefined && !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(opts.to)) {
    throw new AgentHubError('USAGE', `invalid version "${clean(opts.to)}" for --to`);
  }
  await requireRegistry(ctx);
  const engine = await ctx.engine();
  const scope = await ctx.scope();
  const channel = ctx.channel();
  const diff = await engine.diff(name, scope, {
    ...(opts.to === undefined ? {} : { to: opts.to }),
    ...(channel === undefined ? {} : { channel }),
  });
  ctx.out.lines(formatDiff(diff, ctx));
  return { data: diff };
}
