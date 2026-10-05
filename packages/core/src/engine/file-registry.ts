/**
 * Local folder registry (design §8.1, FR-12): a directory of `.skillpkg` files plus an optional
 * `revocations.json` listing revoked `name@version` with a reason.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import { readSkillArchive } from '../archive';
import { AgentHubError } from '../errors';
import { archiveDigest } from '../hash';
import type { SkillPackage } from '../types';
import type {
  RegistrySource,
  RegistryVersion,
  SearchResult,
  SkillInfo,
  SkillInfoVersion,
} from './api';
import { errnoCode, isNetworkPath } from './fsutil';
import { latestVersion } from './resolve';

const revocationsSchema = z.array(
  z.object({ name: z.string().min(1), version: z.string().min(1), reason: z.string().optional() }),
);

interface IndexedVersion {
  file: string;
  record: SkillInfoVersion;
  description: string;
}

interface RegistryIndex {
  skills: Map<string, IndexedVersion[]>;
  /** Archives that could not be read, with the reason. */
  invalid: { file: string; reason: string }[];
}

function summarize(pkg: SkillPackage): string {
  return pkg.frontmatter.description;
}

function requirementsOf(pkg: SkillPackage): SkillInfoVersion['requirements'] {
  const req = pkg.manifest?.requires;
  if (!req) return [];
  return [
    ...Object.entries(req.runtimes ?? {}).map(([name, constraint]) => ({
      kind: 'runtime' as const,
      name,
      constraint,
    })),
    ...(req.commands ?? []).map((name) => ({ kind: 'command' as const, name, constraint: null })),
    ...(req.mcp ?? []).map((name) => ({ kind: 'mcp' as const, name, constraint: null })),
  ];
}

export function createFileRegistry(dir: string): RegistrySource {
  // Reading a UNC/device path makes Windows authenticate to the host it names.
  if (isNetworkPath(dir) || isNetworkPath(path.resolve(dir))) {
    throw new AgentHubError(
      'VALIDATION',
      `the registry folder ${dir} is a network path; file: registries must be local folders`,
      { path: dir },
    );
  }
  const root = path.resolve(dir);
  let cached: Promise<RegistryIndex> | null = null;

  const buildIndex = async (): Promise<RegistryIndex> => {
    let names: string[];
    try {
      names = (await fs.readdir(root)).sort();
    } catch (error) {
      throw new AgentHubError(
        'REGISTRY',
        `cannot read registry folder ${root}: ${errnoCode(error) ?? error}`,
        {
          path: root,
        },
      );
    }
    const revoked = new Map<string, string>();
    if (names.includes('revocations.json')) {
      const file = path.join(root, 'revocations.json');
      let parsed: z.infer<typeof revocationsSchema>;
      try {
        parsed = revocationsSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
      } catch (error) {
        throw new AgentHubError(
          'REGISTRY',
          `invalid ${file}: ${error instanceof Error ? error.message : String(error)}`,
          { path: file },
        );
      }
      for (const entry of parsed)
        revoked.set(`${entry.name}@${entry.version}`, entry.reason ?? 'revoked');
    }

    const skills = new Map<string, IndexedVersion[]>();
    const invalid: RegistryIndex['invalid'] = [];
    for (const name of names) {
      if (!name.endsWith('.skillpkg')) continue;
      const file = path.join(root, name);
      try {
        const st = await fs.lstat(file);
        if (!st.isFile()) continue;
        const bytes = new Uint8Array(await fs.readFile(file));
        const pkg = readSkillArchive(bytes);
        const list = skills.get(pkg.name) ?? [];
        if (list.some((v) => v.record.version === pkg.version)) {
          invalid.push({ file, reason: `duplicate ${pkg.name}@${pkg.version}` });
          continue;
        }
        const reason = revoked.get(`${pkg.name}@${pkg.version}`);
        const record: SkillInfoVersion = {
          version: pkg.version,
          digest: pkg.digest,
          archiveDigest: archiveDigest(bytes),
          status: reason === undefined ? 'active' : 'revoked',
          channel: pkg.manifest?.channel ?? (semver.prerelease(pkg.version) ? 'beta' : 'stable'),
          createdAt: st.mtime.toISOString(),
          sizeBytes: bytes.length,
          requirements: requirementsOf(pkg),
          releaseNotes: null,
        };
        if (pkg.manifest?.targets) record.agents = [...pkg.manifest.targets];
        if (pkg.manifest?.permissions) record.permissions = pkg.manifest.permissions;
        if (reason !== undefined) record.revokedReason = reason;
        list.push({ file, record, description: summarize(pkg) });
        skills.set(pkg.name, list);
      } catch (error) {
        invalid.push({ file, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const list of skills.values()) {
      list.sort((a, b) => semver.rcompare(a.record.version, b.record.version));
    }
    return { skills, invalid };
  };

  const index = (): Promise<RegistryIndex> => {
    cached ??= buildIndex().catch((error: unknown) => {
      cached = null;
      throw error;
    });
    return cached;
  };

  const versionsOf = async (name: string): Promise<IndexedVersion[]> => {
    const list = (await index()).skills.get(name);
    if (!list)
      throw new AgentHubError('NOT_FOUND', `skill "${name}" is not in the registry ${root}`);
    return list;
  };

  const toInfo = (name: string, list: IndexedVersion[]): SkillInfo => {
    const versions = list.map((v) => v.record);
    const latest = latestVersion(versions, 'stable');
    const latestRecord = versions.find((v) => v.version === latest) ?? null;
    const describe = list.find((v) => v.record.version === latest) ?? list[0];
    return {
      slug: name,
      name,
      summary: describe?.description ?? '',
      latest: latestRecord,
      versions,
    };
  };

  return {
    id: `file:${root}`,

    async listVersions(name: string): Promise<RegistryVersion[]> {
      return (await versionsOf(name)).map((v) => ({ ...v.record }));
    },

    async download(name: string, version: string) {
      const entry = (await versionsOf(name)).find((v) => v.record.version === version);
      if (!entry)
        throw new AgentHubError('NOT_FOUND', `${name}@${version} is not in the registry ${root}`);
      const bytes = new Uint8Array(await fs.readFile(entry.file));
      const actual = archiveDigest(bytes);
      if (actual !== entry.record.archiveDigest) {
        throw new AgentHubError(
          'INTEGRITY',
          `archive digest mismatch for ${name}@${version} (${entry.file}): expected ${entry.record.archiveDigest}, got ${actual}`,
          { expected: entry.record.archiveDigest, actual, path: entry.file },
        );
      }
      return { bytes, archiveDigest: actual, digest: entry.record.digest };
    },

    async search(
      query: string,
      opts?: { agent?: SearchResult['agents'][number]; category?: string },
    ) {
      const needle = query.trim().toLowerCase();
      const out: SearchResult[] = [];
      for (const [name, list] of (await index()).skills) {
        const info = toInfo(name, list);
        const haystack = `${name}\n${info.summary}`.toLowerCase();
        if (needle !== '' && !haystack.includes(needle)) continue;
        const agents = [...new Set(list.flatMap((v) => v.record.agents ?? []))];
        if (opts?.agent && agents.length > 0 && !agents.includes(opts.agent)) continue;
        out.push({
          slug: name,
          name,
          summary: info.summary,
          latestVersion: info.latest?.version ?? null,
          agents,
          ...(info.latest?.createdAt ? { updatedAt: info.latest.createdAt } : {}),
        });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },

    async info(name: string): Promise<SkillInfo> {
      return toInfo(name, await versionsOf(name));
    },
  };
}
