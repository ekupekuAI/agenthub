import type { SkillInfo, SkillInfoVersion } from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { agentList, formatBytes, formatFinding, shortDigest, table } from '../format';
import { clean } from '../output';
import { requireRegistry } from './registry';
import { assertSkillName } from './shared';

function permissionLines(version: SkillInfoVersion): string[] {
  const p = version.permissions;
  if (p === undefined) return ['  none declared'];
  const lines: string[] = [];
  if (p.network !== undefined) {
    lines.push(
      `  network  ${Array.isArray(p.network) ? p.network.map(clean).join(', ') : String(p.network)}`,
    );
  }
  if (p.exec?.length) lines.push(`  exec     ${p.exec.map(clean).join(', ')}`);
  if (p.env?.length) lines.push(`  env      ${p.env.map(clean).join(', ')}`);
  if (p.secrets?.length) lines.push(`  secrets  ${p.secrets.map(clean).join(', ')}`);
  if (p.fs?.write?.length) lines.push(`  fs write ${p.fs.write.map(clean).join(', ')}`);
  return lines.length === 0 ? ['  none declared'] : lines;
}

export async function infoCommand(ctx: CommandContext, name: string): Promise<CommandResult> {
  assertSkillName(name);
  const registry = await requireRegistry(ctx);
  let info: SkillInfo;
  if (registry.info !== undefined) {
    info = await registry.info(name);
  } else {
    const versions = await registry.listVersions(name);
    info = { slug: name, name, summary: '', latest: versions[0] ?? null, versions };
  }

  const s = ctx.out.style;
  ctx.out.print(`${s.bold(clean(info.name))}${info.summary ? ` — ${clean(info.summary)}` : ''}`);
  if (info.publisher !== undefined) {
    ctx.out.print(
      `  publisher ${clean(info.publisher.name)}${info.publisher.verified ? ' (verified)' : ''}`,
    );
  }
  if (info.category) ctx.out.print(`  category  ${clean(info.category)}`);
  ctx.out.print(`  registry  ${clean(registry.id)}`);
  ctx.out.print();

  ctx.out.print(s.bold('Versions'));
  const rows = info.versions.map((version) => [
    version.version,
    version.status === 'active'
      ? 'active'
      : `${version.status}${version.revokedReason ? `: ${version.revokedReason}` : ''}`,
    version.channel ?? 'stable',
    shortDigest(version.digest),
    shortDigest(version.archiveDigest),
    version.sizeBytes === undefined ? '' : formatBytes(version.sizeBytes),
    version.agents === undefined ? '' : agentList(version.agents),
  ]);
  for (const line of table(
    ['VERSION', 'STATUS', 'CHANNEL', 'DIGEST', 'ARCHIVE', 'SIZE', 'AGENTS'],
    rows,
    s,
  )) {
    ctx.out.print(`  ${line}`);
  }

  const latest = info.latest;
  if (latest !== null) {
    ctx.out.print();
    ctx.out.print(s.bold(`Latest (${clean(latest.version)})`));
    ctx.out.print(`  digest          ${clean(latest.digest)}`);
    if (latest.archiveDigest) ctx.out.print(`  archive digest  ${clean(latest.archiveDigest)}`);
    ctx.out.print();
    ctx.out.print(s.bold('Permissions'));
    ctx.out.lines(permissionLines(latest));
    ctx.out.print();
    ctx.out.print(s.bold('Requirements'));
    if (!latest.requirements?.length) ctx.out.print('  none declared');
    for (const req of latest.requirements ?? []) {
      ctx.out.print(
        `  ${req.kind} ${clean(req.name)}${req.constraint ? ` ${clean(req.constraint)}` : ''}`,
      );
    }
    ctx.out.print();
    ctx.out.print(s.bold('Scan'));
    if (latest.scan === undefined) {
      ctx.out.print('  no scan published');
    } else {
      ctx.out.print(
        `  outcome ${latest.scan.outcome}  ${s.dim(`(scanner ${clean(latest.scan.scannerVersion)})`)}`,
      );
      if (latest.scan.findings.length === 0) ctx.out.print('  no findings');
      for (const finding of latest.scan.findings) ctx.out.print(formatFinding(finding, s));
    }
    if (latest.releaseNotes) {
      ctx.out.print();
      ctx.out.print(s.bold('Release notes'));
      for (const line of latest.releaseNotes.split(/\r?\n/).slice(0, 40))
        ctx.out.print(`  ${clean(line)}`);
    }
  }
  return { data: info };
}
