/**
 * Human-readable rendering. Every value that came from a package, the registry or the disk
 * goes through `clean` before it is printed.
 */

import { readersOf } from '@agenthub/adapters';
import type { AgentId, EvaluatedFinding, InstallPlan, InstallResult, Scope } from '@agenthub/core';
import { AGENT_IDS } from '@agenthub/core';
import { clean, type Style } from './output';

export function shortDigest(digest: string | undefined): string {
  if (digest === undefined) return '';
  const match = /^sha256:([0-9a-f]+)$/.exec(digest);
  return match?.[1] === undefined ? clean(digest) : `sha256:${match[1].slice(0, 12)}`;
}

/** Shows paths under `home` as `~…`. */
export function displayPath(path: string, home: string): string {
  if (home === '') return clean(path);
  const win = process.platform === 'win32';
  const starts = win ? path.toLowerCase().startsWith(home.toLowerCase()) : path.startsWith(home);
  if (!starts) return clean(path);
  const rest = path.slice(home.length);
  if (rest === '') return '~';
  if (rest[0] === '/' || rest[0] === '\\') return clean(`~${rest}`);
  return clean(path);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function agentList(agents: readonly string[]): string {
  return agents.length === 0 ? '—' : agents.map(clean).join(', ');
}

/** Plain-text table with left-aligned columns. Cells are cleaned. */
export function table(headers: string[], rows: string[][], style: Style): string[] {
  const cleaned = rows.map((row) => row.map((cell) => clean(cell)));
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...cleaned.map((row) => (row[column] ?? '').length)),
  );
  const render = (cells: string[]): string =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
      )
      .join('  ')
      .trimEnd();
  return [style.bold(render(headers)), ...cleaned.map(render)];
}

export function scopeLabel(scope: Scope): string {
  return scope === 'user' ? 'user' : 'project';
}

function decisionLabel(decision: EvaluatedFinding['decision'], style: Style): string {
  switch (decision) {
    case 'BLOCK':
      return style.red('BLOCK');
    case 'WARN':
      return style.yellow('WARN ');
    default:
      return style.dim('INFO ');
  }
}

export function formatFinding(finding: EvaluatedFinding, style: Style): string {
  const where = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  const declared = finding.declared ? style.green('declared') : 'undeclared';
  const evidence = finding.evidence === '' ? clean(finding.message) : clean(finding.evidence);
  return `  ${decisionLabel(finding.decision, style)} ${clean(finding.ruleId)}  ${clean(where)}  ${evidence}  (${declared})`;
}

function sourceLabel(plan: InstallPlan, home: string): string {
  const source = plan.source;
  switch (source.kind) {
    case 'dir':
      return `folder ${displayPath(source.path, home)}`;
    case 'file':
      return `package ${displayPath(source.path, home)}`;
    default: {
      const range = source.range === undefined ? '' : `@${clean(source.range)}`;
      const registry = source.registry === undefined ? '' : ` from ${clean(source.registry)}`;
      return `registry ${clean(source.name)}${range}${registry}`;
    }
  }
}

const ACTION_MARK: Record<string, string> = { create: '+', replace: '~', unchanged: '=' };

/** The plan, in the order the user needs it: what, where, safety, requirements, blockers. */
export function formatPlan(
  plan: InstallPlan,
  style: Style,
  opts: { home: string; title?: string; defaultScope?: boolean },
): string[] {
  const lines: string[] = [];
  const skill = plan.skill;
  lines.push(style.bold(opts.title ?? 'Plan'));
  lines.push(
    `  skill    ${style.bold(clean(skill.name))} ${clean(skill.version)}  ${style.dim(shortDigest(skill.digest))}`,
  );
  if (plan.previous !== undefined) {
    lines.push(
      `  replaces ${clean(plan.previous.version)}  ${style.dim(shortDigest(plan.previous.digest))}`,
    );
  }
  lines.push(`  source   ${sourceLabel(plan, opts.home)}`);
  lines.push(`  scope    ${plan.scope}  ${displayPath(plan.scopeRoot, opts.home)}`);
  if (plan.scope === 'user' && opts.defaultScope === true) {
    lines.push(style.dim('           (not inside a project, so the user scope is used)'));
  }
  if (plan.agents.length > 0) {
    const agents = plan.agents.map((agent) =>
      agent.confidence === 'high' ? clean(agent.id) : `${clean(agent.id)} (${agent.confidence})`,
    );
    lines.push(`  agents   ${agents.join(', ')}`);
  }
  if (plan.dev)
    lines.push(style.yellow('  developer mode: policy blocks are overridden and logged'));

  lines.push('', style.bold('Targets'));
  if (plan.targets.length === 0) {
    lines.push(plan.blockers.length > 0 ? '  none' : '  none — no agent selected');
  }
  for (const target of plan.targets) {
    const mark = ACTION_MARK[target.action] ?? '?';
    const flags: string[] = [target.action];
    if (target.unmanaged) flags.push('unmanaged folder');
    // Every agent that loads skills from this folder, not only the ones selected.
    const others = readersOf(plan.scope, target.dir).filter((id) => !target.agents.includes(id));
    if (others.length > 0) flags.push(`also read by: ${agentList(others)}`);
    if (target.drift !== undefined && target.drift.length > 0) {
      flags.push(`modified: ${target.drift.map(clean).join(', ')}`);
    }
    lines.push(
      `  ${mark} ${clean(target.lockPath)}  →  ${agentList(target.agents)}  ${style.dim(`(${flags.join('; ')})`)}`,
    );
  }
  if (plan.duplicates.length > 0) {
    lines.push(
      style.dim(
        `  note: ${agentList(plan.duplicates)} read more than one of these folders and will list the skill twice`,
      ),
    );
  }

  lines.push('', style.bold('Safety'));
  if (plan.policy.findings.length === 0) {
    lines.push('  no findings (the scanner reports what it finds; it does not certify safety)');
  } else {
    for (const finding of plan.policy.findings) lines.push(formatFinding(finding, style));
  }

  if (plan.requirements.length > 0) {
    lines.push('', style.bold('Requirements'));
    for (const req of plan.requirements) {
      const mark = req.ok === true ? style.green('✔') : req.ok === false ? style.red('✘') : '?';
      const constraint = req.constraint ? ` ${clean(req.constraint)}` : '';
      const found =
        req.ok === null
          ? ' (cannot be checked locally)'
          : req.found === undefined
            ? ''
            : req.found === null
              ? ' (not found)'
              : ` (found ${clean(req.found)})`;
      lines.push(`  ${mark} ${req.kind} ${clean(req.name)}${constraint}${found}`);
    }
  }

  const warnings = plan.issues.filter((issue) => issue.level === 'warning');
  if (warnings.length > 0) {
    lines.push('', style.bold('Warnings'));
    for (const issue of warnings) {
      const where = issue.path ? ` (${clean(issue.path)})` : '';
      lines.push(`  ${style.yellow('!')} ${clean(issue.code)}: ${clean(issue.message)}${where}`);
    }
  }

  // Engine and CLI notes: --dev overrides, settings ignored or chosen by the project config,
  // requirements that cannot be checked, skipped agents.
  if (plan.hints.length > 0) {
    lines.push('', style.bold('Notes'));
    for (const hint of plan.hints) lines.push(`  - ${clean(hint)}`);
  }

  if (plan.blockers.length > 0) {
    lines.push('', style.bold(style.red('Blocked')));
    for (const blocker of plan.blockers) {
      lines.push(`  ${style.red('✘')} ${clean(blocker.message)} ${style.dim(`[${blocker.code}]`)}`);
    }
  }
  return lines;
}

export function uniqueAgents(targets: { agents: AgentId[] }[]): AgentId[] {
  const set = new Set<AgentId>();
  for (const target of targets) for (const agent of target.agents) set.add(agent);
  return AGENT_IDS.filter((id) => set.has(id));
}

export function formatInstalled(verb: string, result: InstallResult, style: Style): string[] {
  const agents = uniqueAgents(result.targets);
  const count = `${agents.length} agent${agents.length === 1 ? '' : 's'}`;
  const lines = [
    verb === 'Installed' || verb === 'Restored'
      ? `${style.green('✔')} ${verb} ${style.bold(clean(result.name))} ${clean(result.version)} into ${count} (${agentList(agents)})`
      : `${style.green('✔')} ${verb} ${style.bold(clean(result.name))} to ${clean(result.version)} for ${count} (${agentList(agents)})`,
  ];
  for (const target of result.targets) {
    lines.push(style.dim(`  ${clean(target.lockPath)}`));
  }
  for (const hint of result.hints) lines.push(`  → ${clean(hint)}`);
  return lines;
}
