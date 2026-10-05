import { AgentHubError, type VerifyReport } from '@agenthub/core';
import { approvalStateText } from '../capability-format';
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
    for (const line of approvalLines(report)) ctx.out.print(line);
  }
  const drifted = reports.filter((report) => !report.ok);
  if (drifted.length > 0) {
    throw new AgentHubError(
      'DRIFT',
      `${drifted.length} skill(s) differ from the lock: ${drifted.map((r) => r.name).join(', ')}`,
      { reports },
    );
  }
  // A capability record that does not describe the bytes is an integrity failure (exit 4).
  const forged = reports.filter((report) => report.capabilities?.lockMatches === false);
  if (forged.length > 0) {
    throw new AgentHubError(
      'DRIFT',
      `the lock's capability record does not match the installed files for: ${forged.map((r) => r.name).join(', ')} — review the lock change, then run "agenthub approve <skill>"`,
      { reports },
    );
  }
  return { data: { scope, reports } };
}

/** Approval state per skill (warnings only; they never change the exit code). */
function approvalLines(report: VerifyReport): string[] {
  const caps = report.capabilities;
  if (caps === undefined) return [];
  if (caps.lockMatches === false) {
    return ['  capabilities: the lock record does not match the installed files'];
  }
  if (caps.missingBlock) {
    return [
      `  approval: no capability record yet — review with "agenthub approve ${clean(report.name)}"`,
    ];
  }
  if (!caps.checked) return ['  approval: cannot recheck (no intact copy or cache)'];
  const lines = [`  approval: ${approvalStateText(caps.state)}`];
  if (caps.stale.length > 0) {
    lines.push(
      `    new under the current scanner rules: ${caps.stale.map(clean).join(', ')} — run "agenthub approve ${clean(report.name)}"`,
    );
  } else if (caps.state === 'unapproved') {
    lines.push(`    review with "agenthub approve ${clean(report.name)}"`);
  }
  return lines;
}
