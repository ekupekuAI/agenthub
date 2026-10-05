/**
 * Human rendering of capability inventories, deltas and file summaries (trust features §6).
 * Every value comes from a package, a lock or a registry and goes through `clean`.
 *
 * Wording rule: this is a capability inventory from static analysis. It never says a skill is
 * safe, and a prose-only change cannot show up here (the SKILL.md line delta is the only hint).
 */
import {
  CAPABILITY_KEYS,
  type CapabilityDelta,
  type CapabilityKey,
  type CapabilityReport,
  type CapabilitySet,
  type ExternalRef,
  type FileChangeSummary,
  type PlanCapabilities,
  pinLabel,
} from '@agenthub/core';
import { clean, type Style } from './output';

export const INVENTORY_CAPTION = 'capability inventory from static analysis — not a safety verdict';

const LABELS: Record<CapabilityKey, string> = {
  binaries: 'binary',
  dynamic: 'dynamic',
  env: 'env',
  exec: 'exec',
  fsWrite: 'fs write',
  installers: 'installs',
  markers: 'marker',
  network: 'network',
  prompt: 'prompt',
  secrets: 'secrets',
};

const WIDTH = 9;

function label(text: string): string {
  return text.padEnd(WIDTH);
}

function roleLabel(role: ExternalRef['role']): string {
  return role === 'instructions' ? 'remote instructions' : role;
}

/** 'https://x/y.md' for URLs, 'npm:playwright' for the rest. */
export function externalName(ref: ExternalRef): string {
  return clean(ref.kind === 'url' ? ref.id : `${ref.kind}:${ref.id}`);
}

export function externalDetail(ref: ExternalRef): string {
  return `${clean(pinLabel(ref))}, ${roleLabel(ref.role)}`;
}

/** The full inventory of a set, one row per token; undeclared tokens are marked. */
export function inventoryLines(report: CapabilityReport, style: Style, indent = '  '): string[] {
  const lines: string[] = [];
  const undeclared = new Set(report.undeclared);
  for (const key of CAPABILITY_KEYS) {
    for (const token of report.set[key]) {
      const mark = undeclared.has(`${key}:${token}`)
        ? style.yellow('  (observed, undeclared)')
        : '';
      const value = key === 'markers' ? style.red(clean(token)) : clean(token);
      lines.push(`${indent}${label(LABELS[key])}${value}${mark}`);
    }
  }
  for (const ref of report.set.externals) {
    lines.push(
      `${indent}${label('external')}${externalName(ref)}  ${style.dim(`(${externalDetail(ref)})`)}`,
    );
  }
  if (lines.length === 0) lines.push(`${indent}nothing found by static analysis`);
  return lines;
}

/** '+', '-' and '~' rows of a delta. */
export function deltaLines(delta: CapabilityDelta, style: Style, indent = '  '): string[] {
  const lines: string[] = [];
  for (const key of CAPABILITY_KEYS) {
    for (const token of delta.added[key]) {
      lines.push(`${indent}${style.yellow('+')} ${label(LABELS[key])}${clean(token)}`);
    }
  }
  for (const ref of delta.externals.added) {
    lines.push(
      `${indent}${style.yellow('+')} ${label('external')}${externalName(ref)} (${externalDetail(ref)})`,
    );
  }
  for (const change of delta.externals.changed) {
    const detail =
      change.change === 'role-escalated'
        ? `${change.from.role} → ${roleLabel(change.to.role)}`
        : `${clean(pinLabel(change.from))} → ${clean(pinLabel(change.to))}`;
    lines.push(
      `${indent}${style.yellow('~')} ${label('external')}${externalName(change.to)} ${detail} (${change.change.replace('-', ' ')})`,
    );
  }
  for (const key of CAPABILITY_KEYS) {
    for (const token of delta.removed[key]) {
      lines.push(`${indent}${style.dim('-')} ${label(LABELS[key])}${clean(token)}`);
    }
  }
  for (const ref of delta.externals.removed) {
    lines.push(`${indent}${style.dim('-')} ${label('external')}${externalName(ref)}`);
  }
  for (const { to } of delta.externals.tightened) {
    lines.push(
      `${indent}${style.green('=')} ${label('external')}${externalName(to)} now pinned (${clean(pinLabel(to))})`,
    );
  }
  return lines;
}

/** Number of things a delta adds (tokens, new externals, loosened or escalated externals). */
export function expansionCount(delta: CapabilityDelta): number {
  let count = delta.externals.added.length + delta.externals.changed.length;
  for (const key of CAPABILITY_KEYS) count += delta.added[key].length;
  return count;
}

export function fileSummaryLine(files: FileChangeSummary): string {
  const parts: string[] = [];
  if (files.modified.length > 0) parts.push(`${files.modified.length} modified`);
  if (files.added.length > 0) parts.push(`${files.added.length} added`);
  if (files.removed.length > 0) parts.push(`${files.removed.length} removed`);
  if (parts.length === 0) parts.push('no file changes');
  const md = files.skillMd;
  const skill =
    md.before === null || md.delta === null
      ? `SKILL.md ${md.after} lines`
      : `SKILL.md ${md.before} → ${md.after} lines (${md.delta >= 0 ? '+' : ''}${md.delta})`;
  return `files  ${parts.join(', ')} · ${skill}`;
}

const STATE_TEXT: Record<PlanCapabilities['state'], string> = {
  approved: 'approved',
  'approved-carried': 'approved (carried forward to the current scanner rules)',
  unapproved: 'not approved',
  stale: 'approved, but the current scanner rules see more',
  'not-approvable': 'not approvable (blocked by policy)',
  fresh: 'new install',
  'same-digest': 'unchanged',
  unavailable: 'unknown (no intact installed copy to rescan)',
};

export function approvalStateText(state: PlanCapabilities['state']): string {
  return STATE_TEXT[state];
}

/** The Capabilities block of an install, update, restore or rollback plan. */
export function planCapabilityLines(
  caps: PlanCapabilities,
  style: Style,
  ctx: { name: string; version: string; previousVersion?: string; sameDigest: boolean },
): string[] {
  const lines: string[] = [];
  const title = style.bold('Capabilities');
  if (caps.delta === null) {
    lines.push(
      `${title}  ${clean(ctx.name)} ${clean(ctx.version)}  ${style.dim(`(${INVENTORY_CAPTION})`)}`,
    );
    lines.push(...inventoryLines(caps.candidate, style));
    if (!caps.approvable) {
      lines.push(style.yellow('  no approval is recorded while the policy outcome is block'));
    }
    return lines;
  }
  if (ctx.sameDigest) {
    lines.push(
      `${title}  unchanged (the same files as installed) — approval: ${approvalStateText(caps.state)}`,
    );
    if (caps.stale.length > 0) {
      lines.push(
        style.yellow(`  the current scanner rules also see: ${caps.stale.map(clean).join(', ')}`),
      );
    }
    return lines;
  }
  const from = ctx.previousVersion === undefined ? '' : `${clean(ctx.previousVersion)} → `;
  lines.push(
    `${title}  ${clean(ctx.name)} ${from}${clean(ctx.version)}  ${style.dim(`(${INVENTORY_CAPTION})`)}`,
  );
  const rows = deltaLines(caps.delta, style);
  lines.push(...(rows.length > 0 ? rows : ['  no capability changes found by static analysis']));
  if (caps.files !== null) lines.push(`  ${fileSummaryLine(caps.files)}`);
  if (caps.approvalRequired) {
    const shown = new Set(caps.delta.reasons);
    const extra = caps.unapproved.reasons.filter((reason) => !shown.has(reason));
    if (extra.length > 0) {
      lines.push(`  not approved before: ${extra.map(clean).join(', ')}`);
    }
    lines.push(
      style.yellow(
        caps.state === 'approved' || caps.state === 'approved-carried' || caps.state === 'stale'
          ? 'This update can do more than the version you approved.'
          : `The installed version has no capability approval (${approvalStateText(caps.state)}), so this inventory needs one.`,
      ),
    );
  } else if (caps.state !== 'fresh') {
    lines.push(style.dim(`  approval: ${approvalStateText(caps.state)}; nothing new to approve`));
  }
  return lines;
}

/** Tokens of a set as a short comma list (for one-line summaries). */
export function setSummary(set: CapabilitySet): string {
  const parts: string[] = [];
  for (const key of CAPABILITY_KEYS) {
    if (set[key].length > 0) parts.push(`${LABELS[key]} ${set[key].length}`);
  }
  if (set.externals.length > 0) parts.push(`external ${set.externals.length}`);
  return parts.length === 0 ? 'nothing found' : parts.join(', ');
}
