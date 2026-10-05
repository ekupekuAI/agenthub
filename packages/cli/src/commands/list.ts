import type { CommandContext, CommandResult } from '../context';
import { agentList, table } from '../format';

export async function listCommand(ctx: CommandContext): Promise<CommandResult> {
  const engine = await ctx.engine();
  const skills = ctx.opts.global ? await engine.list('user') : await engine.list();
  if (skills.length === 0) {
    ctx.out.print('No skills installed.');
  } else {
    const s = ctx.out.style;
    const rows = skills.map((skill) => [
      skill.name,
      skill.version,
      skill.scope,
      agentList(skill.agents),
      skill.registry ?? skill.source,
      skill.status,
      skill.approval,
    ]);
    const lines = table(
      ['SKILL', 'VERSION', 'SCOPE', 'AGENTS', 'SOURCE', 'STATUS', 'APPROVAL'],
      rows,
      s,
    );
    ctx.out.lines(lines);
    if (skills.some((skill) => skill.approval !== 'approved')) {
      ctx.out.print(
        s.dim(
          'APPROVAL from the lock: "recheck" = approved under other scanner rules (run "agenthub verify"); review with "agenthub approve <skill>"',
        ),
      );
    }
  }
  return { data: { skills } };
}
