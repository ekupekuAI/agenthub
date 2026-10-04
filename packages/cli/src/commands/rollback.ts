import type { CommandContext, CommandResult } from '../context';
import { formatInstalled } from '../format';
import { confirm } from '../prompt';
import { assertSkillName } from './shared';

export async function rollbackCommand(ctx: CommandContext, name: string): Promise<CommandResult> {
  assertSkillName(name);
  const engine = await ctx.engine();
  const scope = await ctx.scope();
  const current = (await engine.list(scope)).find((skill) => skill.name === name);
  if (ctx.opts.dryRun) {
    ctx.out.print(
      `dry run: would restore the previous snapshot of ${name}${current ? ` (currently ${current.version})` : ''} in the ${scope} scope`,
    );
    return { data: { dryRun: true, name, scope, current: current?.version ?? null } };
  }
  await confirm(
    `Roll back ${name}${current ? ` ${current.version}` : ''} (${scope}) to its previous version?`,
    { ...ctx.confirmOptions(), defaultYes: true, required: true },
  );
  const result = await engine.rollback(name, scope);
  ctx.out.lines(formatInstalled('Rolled back', result, ctx.out.style));
  return { data: { dryRun: false, previous: current?.version ?? null, result } };
}
