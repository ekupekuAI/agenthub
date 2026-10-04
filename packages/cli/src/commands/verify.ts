import { AgentHubError } from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { clean } from '../output';
import { assertSkillName } from './shared';

export async function verifyCommand(
  ctx: CommandContext,
  name: string | undefined,
): Promise<CommandResult> {
  if (name !== undefined) assertSkillName(name);
  const engine = await ctx.engine();
  const scope = await ctx.scope();
  const reports = await engine.verify(scope, name);
  const s = ctx.out.style;
  if (reports.length === 0) ctx.out.print(`No skills to verify in the ${scope} scope.`);
  for (const report of reports) {
    const mark = report.ok ? s.green('✔') : s.red('✘');
    ctx.out.print(
      `${mark} ${s.bold(clean(report.name))} ${clean(report.version)} (${report.scope}) ${report.ok ? 'ok' : s.red('drift')}`,
    );
    for (const target of report.targets) {
      const bad = target.files.filter((file) => file.status !== 'ok');
      if (target.ok && bad.length === 0) continue;
      ctx.out.print(`  ${clean(target.lockPath)}`);
      for (const file of bad) ctx.out.print(`    ${file.status.padEnd(8)} ${clean(file.path)}`);
    }
  }
  const drifted = reports.filter((report) => !report.ok);
  if (drifted.length > 0) {
    throw new AgentHubError(
      'DRIFT',
      `${drifted.length} skill(s) differ from the lock: ${drifted.map((r) => r.name).join(', ')}`,
      { reports },
    );
  }
  return { data: { scope, reports } };
}
