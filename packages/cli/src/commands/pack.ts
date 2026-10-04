import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { SkillPackage } from '@agenthub/core';
import {
  AgentHubError,
  archiveDigest,
  buildSkillPackage,
  loadSkillFromDir,
  packSkill,
  readSkillArchive,
} from '@agenthub/core';
import type { CommandContext, CommandResult } from '../context';
import { formatBytes } from '../format';
import { assertVersion } from '../http-registry';
import { clean } from '../output';

export interface PackOptions {
  output?: string;
  version?: string;
}

const MANIFEST = 'agenthub.yaml';
const TOP_LEVEL_VERSION = /^version[ \t]*:.*$/m;

/**
 * Writes `version` into agenthub.yaml (creating a minimal one if needed), so the version
 * travels inside the archive. `version` has already been validated as semver.
 */
export function stampVersion(pkg: SkillPackage, version: string): SkillPackage {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const raw = pkg.files.map((file) => ({ path: file.path, content: file.content }));
  const manifest = raw.find((file) => file.path === MANIFEST);
  if (manifest === undefined) {
    raw.push({ path: MANIFEST, content: encoder.encode(`schema: 1\nversion: ${version}\n`) });
  } else {
    const text = decoder.decode(manifest.content);
    manifest.content = encoder.encode(
      TOP_LEVEL_VERSION.test(text)
        ? text.replace(TOP_LEVEL_VERSION, `version: ${version}`)
        : `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}version: ${version}\n`,
    );
  }
  return buildSkillPackage(raw, { folderName: pkg.name, version });
}

/** Packs and reads the archive back, so what is written is exactly what installs will see. */
function packVerified(
  pkg: SkillPackage,
  version: string | undefined,
): {
  pkg: SkillPackage;
  bytes: Uint8Array;
} {
  let current = pkg;
  let bytes = packSkill(current);
  let readBack = readSkillArchive(bytes);
  if (version !== undefined && readBack.version !== version) {
    current = stampVersion(current, version);
    bytes = packSkill(current);
    readBack = readSkillArchive(bytes);
  }
  if (
    readBack.digest !== current.digest ||
    (version !== undefined && readBack.version !== version)
  ) {
    throw new AgentHubError(
      'INTERNAL',
      `packed archive does not read back as ${current.name}@${version ?? current.version}`,
    );
  }
  return { pkg: current, bytes };
}

export async function packCommand(
  ctx: CommandContext,
  dir: string,
  opts: PackOptions,
): Promise<CommandResult> {
  if (opts.version !== undefined) assertVersion(opts.version);
  const source = resolve(ctx.cwd, dir);
  const loaded = await loadSkillFromDir(
    source,
    opts.version === undefined ? {} : { version: opts.version },
  );
  for (const issue of loaded.issues) {
    ctx.out.warn(
      `${clean(issue.code)}: ${clean(issue.message)}${issue.path ? ` (${clean(issue.path)})` : ''}`,
    );
  }
  const { pkg, bytes } = packVerified(loaded, opts.version);
  const archive = archiveDigest(bytes);
  const file = resolve(ctx.cwd, opts.output ?? `${pkg.name}-${pkg.version}.skillpkg`);
  if (!ctx.opts.dryRun) {
    try {
      await writeFile(file, bytes);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? String(error);
      throw new AgentHubError('IO', `cannot write ${file}: ${code}`, { path: file });
    }
  }

  const s = ctx.out.style;
  ctx.out.print(
    `${s.green('✔')} ${ctx.opts.dryRun ? 'Would pack' : 'Packed'} ${s.bold(clean(pkg.name))} ${clean(pkg.version)}`,
  );
  ctx.out.print(`  file            ${clean(file)}`);
  ctx.out.print(`  content digest  ${pkg.digest}`);
  ctx.out.print(`  archive digest  ${archive}`);
  ctx.out.print(`  size            ${formatBytes(bytes.byteLength)} (${pkg.files.length} files)`);
  return {
    data: {
      name: pkg.name,
      version: pkg.version,
      file,
      digest: pkg.digest,
      archiveDigest: archive,
      sizeBytes: bytes.byteLength,
      files: pkg.files.length,
      issues: pkg.issues,
      dryRun: ctx.opts.dryRun,
    },
  };
}
