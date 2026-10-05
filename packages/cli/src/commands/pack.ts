import { randomBytes } from 'node:crypto';
import { lstat, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
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

/**
 * The output must be a new file, or (with -o or --force) an existing regular file. A symbolic
 * link or anything else at that path is refused: its name comes from the package being packed,
 * and a planted link must never redirect the write.
 */
async function checkOutputPath(
  file: string,
  opts: { explicit: boolean; force: boolean },
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw new AgentHubError('IO', `cannot check ${file}: ${code ?? String(error)}`, { path: file });
  }
  if (info.isSymbolicLink()) {
    throw new AgentHubError(
      'CONFLICT',
      `${file} is a symbolic link; agenthub never writes through one — remove it or pass another -o`,
      { path: file },
    );
  }
  if (!info.isFile()) {
    throw new AgentHubError('CONFLICT', `${file} exists and is not a regular file`, { path: file });
  }
  if (!opts.explicit && !opts.force) {
    throw new AgentHubError(
      'USAGE',
      `${file} already exists — pass --force to replace it, or choose another file with -o`,
      { path: file },
    );
  }
}

/** Writes a fresh temporary file next to the output and renames it into place. */
async function writeOutput(file: string, bytes: Uint8Array): Promise<void> {
  const temp = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    throw new AgentHubError('IO', `cannot write ${file}: ${code}`, { path: file });
  }
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
  await checkOutputPath(file, { explicit: opts.output !== undefined, force: ctx.opts.force });
  if (!ctx.opts.dryRun) await writeOutput(file, bytes);

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
