import type { CommandContext, CommandResult } from '../context';
import { displayPath, formatBytes, table } from '../format';
import { asAgentHubError, clean } from '../output';

export async function doctorCommand(ctx: CommandContext): Promise<CommandResult> {
  let wiring: Awaited<ReturnType<CommandContext['wiring']>>;
  try {
    wiring = await ctx.wiring();
  } catch (error) {
    // An invalid config file is something doctor reports, not a reason to say nothing.
    const known = asAgentHubError(error);
    if (known?.code !== 'VALIDATION' && known?.code !== 'IO') throw error;
    const problems = [{ level: 'error' as const, code: 'config.invalid', message: known.message }];
    ctx.out.print(ctx.out.style.bold('Problems'));
    ctx.out.print(`  ${ctx.out.style.red('error  ')} config.invalid: ${clean(known.message)}`);
    ctx.out.print(
      '  fix the file by hand or with "agenthub config set|unset <key>" (-g for the user config)',
    );
    return { data: { problems }, exitCode: 1 };
  }
  const report = await wiring.engine.doctor();
  const s = ctx.out.style;
  const home = wiring.paths.home;

  ctx.out.print(s.bold('Agents'));
  if (report.agents.length === 0) {
    ctx.out.print('  none detected (use --agent to target agents explicitly)');
  } else {
    const rows = report.agents.map((agent) => [
      agent.id,
      agent.version ?? '—',
      agent.confidence,
      agent.status,
      ctx.opts.verbose ? agent.evidence.join('; ') : (agent.evidence[0] ?? ''),
    ]);
    for (const line of table(['AGENT', 'VERSION', 'CONFIDENCE', 'STATUS', 'EVIDENCE'], rows, s)) {
      ctx.out.print(`  ${line}`);
    }
  }
  ctx.out.print();
  ctx.out.print(`${s.bold('Path table')}  ${clean(report.pathTableVersion)}`);
  ctx.out.print();
  ctx.out.print(s.bold('Scopes'));
  for (const scope of report.scopes) {
    const lock = scope.lockExists ? `${scope.skills} skill(s)` : 'no lock yet';
    ctx.out.print(`  ${scope.scope.padEnd(8)} ${displayPath(scope.root, home)}  ${s.dim(lock)}`);
  }
  if (report.projectRoot === null) {
    ctx.out.print(s.dim('  (not inside a project: installs default to the user scope)'));
  }
  ctx.out.print(`  cache    ${formatBytes(report.cacheBytes)}`);
  const registry = wiring.config.effective.registry;
  const registrySource = wiring.config.sources.registry ?? 'default';
  if (registry !== undefined) {
    ctx.out.print(`  registry ${clean(registry)}  ${s.dim(`(${registrySource})`)}`);
  }
  if (report.pendingJournals.length > 0) {
    ctx.out.print();
    ctx.out.print(s.bold('Interrupted transactions'));
    for (const journal of report.pendingJournals) ctx.out.print(`  ${clean(journal)}`);
  }

  ctx.out.print();
  ctx.out.print(s.bold('Problems'));
  const problems = [...report.problems];
  if (wiring.registryError !== undefined) {
    const message =
      wiring.registryError instanceof Error
        ? wiring.registryError.message
        : String(wiring.registryError);
    problems.push({ level: 'error', code: 'config.registry', message });
  }
  if (problems.length === 0) ctx.out.print(`  ${s.green('✔')} none found`);
  for (const problem of problems) {
    const label = problem.level === 'error' ? s.red('error  ') : s.yellow('warning');
    ctx.out.print(`  ${label} ${clean(problem.code)}: ${clean(problem.message)}`);
  }
  const errors = problems.filter((problem) => problem.level === 'error').length;
  return {
    data: {
      ...report,
      registry: registry === undefined ? null : { url: registry, source: registrySource },
      problems,
    },
    exitCode: errors > 0 ? 1 : 0,
  };
}
