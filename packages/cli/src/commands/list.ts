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
    ]);
    const lines = table(['SKILL', 'VERSION', 'SCOPE', 'AGENTS', 'SOURCE', 'STATUS'], rows, s);
    ctx.out.lines(lines);
  }
  return { data: { skills } };
}
