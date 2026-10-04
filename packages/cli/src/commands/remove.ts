import type { CommandContext, CommandResult } from '../context';
import { clean } from '../output';
import { assertSkillName } from './shared';

export async function removeCommand(ctx: CommandContext, name: string): Promise<CommandResult> {
  assertSkillName(name);
  const engine = await ctx.engine();
  const scope = await ctx.scope();
  const result = await engine.remove(name, scope, {
    force: ctx.opts.force,
    dryRun: ctx.opts.dryRun,
  });
  const s = ctx.out.style;
  const verb = ctx.opts.dryRun ? 'Would remove' : 'Removed';
  ctx.out.print(`${s.green('✔')} ${verb} ${s.bold(clean(result.name))} (${result.scope})`);
  for (const path of result.removed) ctx.out.print(s.dim(`  - ${clean(path)}`));
  if (result.kept.length > 0) {
    ctx.out.warn(
      `kept ${result.kept.length} modified or extra file(s); re-run with --force to delete the folder entirely:`,
    );
    for (const path of result.kept) ctx.out.notice(`  ${clean(path)}`);
  }
  return { data: { dryRun: ctx.opts.dryRun, ...result } };
}
