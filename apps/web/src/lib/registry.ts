/**
 * Registry service. Server-only: imported by route handlers, server components and server
 * actions — never by client components.
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  type AgentHubError,
  archiveDigest as computeArchiveDigest,
  type EvaluatedFinding,
  isAgentHubError,
  readSkillArchive,
  type SkillManifest,
  type SkillPackage,
} from '@agenthub/core';
import { evaluatePolicy, SCANNER_VERSION, scanPackage } from '@agenthub/scanner';
import { and, desc, eq, ilike, inArray, or, type SQL, sql } from 'drizzle-orm';
import semver from 'semver';
import { dataDir, MAX_UPLOAD_BYTES } from '../config';
import { type DbHandle, getDatabase } from '../db/client';
import {
  installEvents,
  publishers,
  requirements,
  revocations,
  securityScans,
  skills,
  skillTargets,
  skillVersions,
} from '../db/schema';
import { type ArtifactStore, LocalFsStore, storageKeyFor } from '../storage';
import type {
  PublisherRef,
  ResolveResult,
  ScanOutcome,
  SearchResult,
  SkillInfo,
  SkillInfoVersion,
  VersionStatus,
} from './api-types';
import { generatePublisherToken, hashesEqual, hashToken, isWellFormedPublisherToken } from './auth';
import { ApiError } from './errors';
import { AGENTS, type Agent, SLUG_RE } from './validation';

type Db = DbHandle['db'];
type VersionRow = typeof skillVersions.$inferSelect;
type SkillRow = typeof skills.$inferSelect;
type PublisherRow = typeof publishers.$inferSelect;

export interface PublishSummary {
  slug: string;
  name: string;
  version: string;
  digest: string;
  archiveDigest: string;
  sizeBytes: number;
  status: VersionStatus;
  outcome: ScanOutcome;
  scannerVersion: string;
  findings: EvaluatedFinding[];
  warnings: { code: string; message: string; path?: string }[];
}

export interface FileEntry {
  path: string;
  size: number;
  sha256: string;
  kind: 'text' | 'binary';
  executable: boolean;
}

export interface SkillDetail {
  info: SkillInfo;
  /** The version shown on the detail page: latest active, else the newest version. */
  shown: SkillInfoVersion | null;
  readme: string;
  files: FileEntry[];
  license?: string;
  compatibility?: string;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QueueItem {
  slug: string;
  name: string;
  version: string;
  status: VersionStatus;
  statusReason: string | null;
  publisher: PublisherRef;
  createdAt: string;
  digest: string;
  scan: SkillInfoVersion['scan'] | null;
}

export interface PublisherSkillSummary {
  slug: string;
  name: string;
  versions: {
    version: string;
    status: VersionStatus;
    statusReason: string | null;
    createdAt: string;
    outcome: ScanOutcome | null;
    counts: { INFO: number; WARN: number; BLOCK: number };
  }[];
}

const CATEGORY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let i = 0; i < 4 && current; i++) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function mapCoreError(error: unknown): never {
  if (isAgentHubError(error)) {
    const e = error as AgentHubError;
    if (e.code === 'INTEGRITY') throw new ApiError('INTEGRITY', e.message);
    throw new ApiError('VALIDATION', e.message);
  }
  throw new ApiError('VALIDATION', 'The upload is not a valid .skillpkg archive.');
}

function isStable(v: VersionRow): boolean {
  return v.channel === 'stable' && semver.prerelease(v.version) === null;
}

function byVersionDesc(a: { version: string }, b: { version: string }): number {
  return semver.rcompare(a.version, b.version);
}

/** Latest active version: highest stable one, else the highest active prerelease. */
function pickLatest(rows: VersionRow[]): VersionRow | null {
  const active = rows.filter((v) => v.status === 'active').sort(byVersionDesc);
  return active.find(isStable) ?? active[0] ?? null;
}

function publisherRef(p: PublisherRow | undefined): PublisherRef | undefined {
  return p ? { name: p.displayName, verified: p.verifiedAt !== null } : undefined;
}

export class Registry {
  private readonly db: Db;
  private readonly store: ArtifactStore;
  private readonly now: () => Date;

  constructor(deps: { db: Db; store: ArtifactStore; now?: () => Date }) {
    this.db = deps.db;
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------
  // Publishers
  // -------------------------------------------------------------------------

  async createPublisher(
    displayName: string,
    verified: boolean,
  ): Promise<{ id: string; displayName: string; verified: boolean; token: string }> {
    const token = generatePublisherToken();
    const id = randomUUID();
    try {
      await this.db.insert(publishers).values({
        id,
        displayName,
        tokenHash: hashToken(token),
        verifiedAt: verified ? this.now() : null,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('CONFLICT', `A publisher named "${displayName}" already exists.`);
      }
      throw error;
    }
    return { id, displayName, verified, token };
  }

  async findPublisherByName(displayName: string): Promise<PublisherRow | null> {
    const rows = await this.db
      .select()
      .from(publishers)
      .where(eq(publishers.displayName, displayName))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Publisher for a presented token, or null. Hash lookup plus constant-time confirmation. */
  async authenticatePublisher(token: string | null | undefined): Promise<PublisherRow | null> {
    if (!token || !isWellFormedPublisherToken(token)) return null;
    const presented = hashToken(token);
    const rows = await this.db
      .select()
      .from(publishers)
      .where(eq(publishers.tokenHash, presented))
      .limit(1);
    const row = rows[0];
    if (!row || !hashesEqual(presented, row.tokenHash)) return null;
    return row;
  }

  // -------------------------------------------------------------------------
  // Publish
  // -------------------------------------------------------------------------

  async publish(
    bytes: Uint8Array,
    publisherId: string,
    opts: {
      releaseNotes?: string;
      /** Version for a package without agenthub.yaml (like `agenthub pack --version`). */
      version?: string;
    } = {},
  ): Promise<PublishSummary> {
    if (bytes.byteLength === 0) throw new ApiError('VALIDATION', 'The upload is empty.');
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new ApiError('VALIDATION', 'Packages are limited to 10 MiB.', { status: 413 });
    }

    let pkg: SkillPackage;
    try {
      pkg = readSkillArchive(bytes);
    } catch (error) {
      mapCoreError(error);
    }
    const archiveDigest = computeArchiveDigest(bytes);
    if (archiveDigest !== `sha256:${sha256Hex(bytes)}`) {
      throw new ApiError('INTEGRITY', 'Archive digest mismatch.');
    }

    const slug = pkg.name;
    if (!SLUG_RE.test(slug) || slug.length > 64) {
      throw new ApiError('VALIDATION', `Invalid skill name "${slug}".`);
    }
    if (opts.version !== undefined && pkg.manifest && pkg.manifest.version !== opts.version) {
      throw new ApiError(
        'VALIDATION',
        `The version ${opts.version} conflicts with agenthub.yaml (${pkg.manifest.version}).`,
      );
    }
    const version = opts.version ?? pkg.version;
    if (semver.valid(version) !== version || version.includes('+')) {
      throw new ApiError(
        'VALIDATION',
        'A semver version is required to publish: set `version` in agenthub.yaml.',
      );
    }

    const scan = scanPackage(
      pkg.files.map((f) => ({ path: f.path, content: f.content, kind: f.kind })),
    );
    const policy = evaluatePolicy(scan.findings, pkg.manifest);
    const status: VersionStatus = policy.outcome === 'block' ? 'quarantined' : 'active';
    const statusReason =
      status === 'quarantined'
        ? `Blocked by scanner: ${[
            ...new Set(policy.findings.filter((f) => f.decision === 'BLOCK').map((f) => f.ruleId)),
          ].join(', ')}`
        : null;

    // Ownership and immutability checks before anything is written.
    const existing = await this.skillBySlug(slug);
    if (existing && existing.publisherId !== publisherId) {
      throw new ApiError('CONFLICT', `The name "${slug}" belongs to another publisher.`);
    }
    if (existing) {
      const dup = await this.db
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, existing.id), eq(skillVersions.version, version)))
        .limit(1);
      if (dup.length > 0) {
        throw new ApiError(
          'CONFLICT',
          `${slug}@${version} already exists. Versions are immutable; publish a new version.`,
        );
      }
    }

    const storageKey = storageKeyFor(archiveDigest);
    await this.store.put(storageKey, bytes);

    const manifest = pkg.manifest;
    const metadata = (pkg.frontmatter.metadata ?? {}) as Record<string, unknown>;
    const rawCategory = typeof metadata.category === 'string' ? metadata.category.trim() : '';
    const category =
      rawCategory.length <= 32 && CATEGORY_RE.test(rawCategory) ? rawCategory : 'general';
    const tags = typeof metadata.tags === 'string' ? metadata.tags.slice(0, 200) : '';
    const channel = manifest?.channel ?? (semver.prerelease(version) === null ? 'stable' : 'beta');
    const targets: Agent[] = (manifest?.targets?.length ? manifest.targets : [...AGENTS]).filter(
      (a): a is Agent => (AGENTS as readonly string[]).includes(a),
    );
    const files = pkg.files.map((f) => ({
      path: f.path,
      size: f.content.byteLength,
      sha256: pkg.fileHashes[f.path] ?? '',
      kind: f.kind,
      executable: f.executable,
    }));
    const now = this.now();
    const versionId = randomUUID();

    try {
      await this.db.transaction(async (tx) => {
        let skillId = existing?.id;
        if (!skillId) {
          skillId = randomUUID();
          await tx.insert(skills).values({
            id: skillId,
            slug,
            name: pkg.name,
            summary: pkg.frontmatter.description,
            category,
            tags,
            publisherId,
            createdAt: now,
            updatedAt: now,
          });
        } else {
          const current = await tx
            .select({ version: skillVersions.version })
            .from(skillVersions)
            .where(eq(skillVersions.skillId, skillId));
          const isNewest = current.every((v) => semver.gt(version, v.version));
          await tx
            .update(skills)
            .set(
              isNewest
                ? { summary: pkg.frontmatter.description, category, tags, updatedAt: now }
                : { updatedAt: now },
            )
            .where(eq(skills.id, skillId));
        }
        await tx.insert(skillVersions).values({
          id: versionId,
          skillId,
          version,
          digest: pkg.digest,
          archiveDigest,
          storageKey,
          sizeBytes: bytes.byteLength,
          status,
          statusReason,
          channel,
          manifestJson: manifest,
          frontmatterJson: pkg.frontmatter,
          readme: pkg.body,
          filesJson: files,
          releaseNotes: opts.releaseNotes?.trim() || null,
          createdAt: now,
        });
        await tx
          .insert(skillTargets)
          .values(
            targets.map((agentId) => ({ skillVersionId: versionId, agentId, mode: 'native' })),
          );
        const reqs = requirementRows(manifest, versionId);
        if (reqs.length > 0) await tx.insert(requirements).values(reqs);
        await tx.insert(securityScans).values({
          id: randomUUID(),
          skillVersionId: versionId,
          scannerVersion: scan.scannerVersion ?? SCANNER_VERSION,
          outcome: policy.outcome,
          findingsJson: policy.findings,
          createdAt: now,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError('CONFLICT', `${slug}@${version} already exists or the name is taken.`);
      }
      throw error;
    }

    return {
      slug,
      name: pkg.name,
      version,
      digest: pkg.digest,
      archiveDigest,
      sizeBytes: bytes.byteLength,
      status,
      outcome: policy.outcome,
      scannerVersion: scan.scannerVersion ?? SCANNER_VERSION,
      findings: policy.findings,
      warnings: pkg.issues.map((i) => ({ code: i.code, message: i.message, path: i.path })),
    };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private async skillBySlug(slug: string): Promise<SkillRow | null> {
    const rows = await this.db.select().from(skills).where(eq(skills.slug, slug)).limit(1);
    return rows[0] ?? null;
  }

  private async requireSkill(slug: string): Promise<SkillRow> {
    const skill = await this.skillBySlug(slug);
    if (!skill) throw new ApiError('NOT_FOUND', `Skill "${slug}" was not found.`);
    return skill;
  }

  private async versionRows(skillIds: string[]): Promise<VersionRow[]> {
    if (skillIds.length === 0) return [];
    return this.db.select().from(skillVersions).where(inArray(skillVersions.skillId, skillIds));
  }

  private async publishersById(ids: string[]): Promise<Map<string, PublisherRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.select().from(publishers).where(inArray(publishers.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Expand version rows into SkillInfoVersion objects (targets, requirements, latest scan). */
  private async describeVersions(rows: VersionRow[]): Promise<Map<string, SkillInfoVersion>> {
    const ids = rows.map((r) => r.id);
    const out = new Map<string, SkillInfoVersion>();
    if (ids.length === 0) return out;
    const [targets, reqs, scans, revs] = await Promise.all([
      this.db.select().from(skillTargets).where(inArray(skillTargets.skillVersionId, ids)),
      this.db.select().from(requirements).where(inArray(requirements.skillVersionId, ids)),
      this.db
        .select()
        .from(securityScans)
        .where(inArray(securityScans.skillVersionId, ids))
        .orderBy(desc(securityScans.createdAt)),
      this.db.select().from(revocations).where(inArray(revocations.skillVersionId, ids)),
    ]);
    for (const row of rows) {
      const scan = scans.find((s) => s.skillVersionId === row.id);
      const manifest = row.manifestJson as SkillManifest | null;
      const revoked = revs.find((r) => r.skillVersionId === row.id);
      const v: SkillInfoVersion = {
        version: row.version,
        digest: row.digest,
        archiveDigest: row.archiveDigest,
        status: row.status,
        channel: row.channel,
        agents: targets
          .filter((t) => t.skillVersionId === row.id)
          .map((t) => t.agentId as Agent)
          .sort((a, b) => AGENTS.indexOf(a) - AGENTS.indexOf(b)),
        createdAt: row.createdAt.toISOString(),
        sizeBytes: row.sizeBytes,
        requirements: reqs
          .filter((r) => r.skillVersionId === row.id)
          .map((r) => ({ kind: r.kind, name: r.name, constraint: r.constraint })),
        permissions: manifest?.permissions ?? {},
        scan: scan
          ? {
              scannerVersion: scan.scannerVersion,
              outcome: scan.outcome,
              findings: scan.findingsJson as EvaluatedFinding[],
              scannedAt: scan.createdAt.toISOString(),
            }
          : undefined,
        releaseNotes: row.releaseNotes,
      };
      if (revoked) v.revokedReason = revoked.reason;
      out.set(row.id, v);
    }
    return out;
  }

  async search(
    opts: { q?: string; agent?: Agent; category?: string; limit?: number } = {},
  ): Promise<SearchResult[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const agentFilter = opts.agent
      ? sql`and exists (select 1 from skill_targets t where t.skill_version_id = v.id and t.agent_id = ${opts.agent})`
      : sql``;
    const conditions: SQL[] = [
      sql`exists (select 1 from skill_versions v where v.skill_id = ${skills.id} and v.status = 'active' ${agentFilter})`,
    ];
    const terms = (opts.q ?? '').split(/\s+/).filter(Boolean).slice(0, 8);
    for (const term of terms) {
      const pattern = `%${escapeLike(term)}%`;
      const match = or(
        ilike(skills.slug, pattern),
        ilike(skills.name, pattern),
        ilike(skills.summary, pattern),
        ilike(skills.category, pattern),
        ilike(skills.tags, pattern),
      );
      if (match) conditions.push(match);
    }
    if (opts.category) conditions.push(eq(skills.category, opts.category));

    const rows = await this.db
      .select()
      .from(skills)
      .where(and(...conditions))
      .orderBy(desc(skills.updatedAt))
      .limit(limit);

    const versions = await this.versionRows(rows.map((r) => r.id));
    const pubs = await this.publishersById([...new Set(rows.map((r) => r.publisherId))]);
    const latestRows = new Map<string, VersionRow>();
    for (const skill of rows) {
      const latest = pickLatest(versions.filter((v) => v.skillId === skill.id));
      if (latest) latestRows.set(skill.id, latest);
    }
    const described = await this.describeVersions([...latestRows.values()]);

    const results: SearchResult[] = [];
    for (const skill of rows) {
      const latest = latestRows.get(skill.id);
      const info = latest ? described.get(latest.id) : undefined;
      const agents = info?.agents ?? [];
      if (opts.agent && !agents.includes(opts.agent)) continue;
      results.push({
        slug: skill.slug,
        name: skill.name,
        summary: skill.summary,
        category: skill.category,
        latestVersion: latest?.version ?? null,
        publisher: publisherRef(pubs.get(skill.publisherId)),
        agents,
        scanOutcome: info?.scan?.outcome,
        updatedAt: skill.updatedAt.toISOString(),
      });
    }
    const first = terms[0]?.toLowerCase();
    if (first) {
      const rank = (r: SearchResult) =>
        r.slug === first ? 0 : r.slug.includes(first) || r.name.includes(first) ? 1 : 2;
      results.sort((a, b) => rank(a) - rank(b));
    }
    return results;
  }

  async categories(): Promise<{ category: string; count: number }[]> {
    const rows = await this.db
      .select({ category: skills.category, count: sql<number>`count(*)::int` })
      .from(skills)
      .where(
        sql`exists (select 1 from skill_versions v where v.skill_id = ${skills.id} and v.status = 'active')`,
      )
      .groupBy(skills.category)
      .orderBy(skills.category);
    return rows;
  }

  async getSkillInfo(slug: string): Promise<SkillInfo> {
    return (await this.getSkill(slug)).info;
  }

  async getSkill(slug: string): Promise<SkillDetail> {
    const skill = await this.requireSkill(slug);
    const rows = (await this.versionRows([skill.id])).sort(byVersionDesc);
    const described = await this.describeVersions(rows);
    const pubs = await this.publishersById([skill.publisherId]);
    const latestRow = pickLatest(rows);
    const versions = rows.map((r) => described.get(r.id) as SkillInfoVersion);
    const info: SkillInfo = {
      slug: skill.slug,
      name: skill.name,
      summary: skill.summary,
      category: skill.category,
      publisher: publisherRef(pubs.get(skill.publisherId)),
      latest: latestRow ? (described.get(latestRow.id) ?? null) : null,
      versions,
    };
    const shownRow = latestRow ?? rows[0] ?? null;
    const frontmatter = (shownRow?.frontmatterJson ?? {}) as Record<string, unknown>;
    return {
      info,
      shown: shownRow ? (described.get(shownRow.id) ?? null) : null,
      readme: shownRow?.readme ?? '',
      files: (shownRow?.filesJson as FileEntry[] | undefined) ?? [],
      license: typeof frontmatter.license === 'string' ? frontmatter.license : undefined,
      compatibility:
        typeof frontmatter.compatibility === 'string' ? frontmatter.compatibility : undefined,
      statusReason: shownRow?.statusReason ?? null,
      createdAt: skill.createdAt.toISOString(),
      updatedAt: skill.updatedAt.toISOString(),
    };
  }

  /** Every version, including quarantined and revoked ones, newest first. */
  async listVersions(slug: string): Promise<SkillInfoVersion[]> {
    return (await this.getSkill(slug)).info.versions;
  }

  async resolve(
    slug: string,
    opts: { agent?: Agent; range?: string; channel?: 'stable' | 'beta' } = {},
  ): Promise<ResolveResult> {
    const skill = await this.requireSkill(slug);
    const rows = await this.versionRows([skill.id]);
    const beta = opts.channel === 'beta';
    const range = opts.range && opts.range !== 'latest' ? opts.range : undefined;
    if (range && semver.validRange(range) === null) {
      throw new ApiError('VALIDATION', `"${range}" is not a valid version range.`);
    }
    const described = await this.describeVersions(rows);
    const candidates = rows
      .filter((v) => v.status === 'active')
      .filter((v) => beta || isStable(v))
      .filter((v) => !range || semver.satisfies(v.version, range, { includePrerelease: beta }))
      .filter((v) => !opts.agent || (described.get(v.id)?.agents ?? []).includes(opts.agent))
      .sort(byVersionDesc);
    const chosen = candidates[0];
    if (!chosen) {
      const exact = range ? rows.find((v) => v.version === range) : undefined;
      if (exact?.status === 'revoked') {
        throw new ApiError('GONE', `${slug}@${exact.version} has been revoked.`);
      }
      if (exact?.status === 'quarantined') {
        throw new ApiError('FORBIDDEN', `${slug}@${exact.version} is quarantined.`);
      }
      const parts = [
        range ? `matching "${range}"` : null,
        opts.agent ? `for ${opts.agent}` : null,
        beta ? null : 'on the stable channel',
      ].filter(Boolean);
      throw new ApiError(
        'NOT_FOUND',
        `No active version of ${slug}${parts.length ? ` ${parts.join(' ')}` : ''}.`,
      );
    }
    return {
      slug,
      version: chosen.version,
      digest: chosen.digest,
      archiveDigest: chosen.archiveDigest,
      downloadUrl: `/api/v1/skills/${slug}/download/${chosen.version}`,
    };
  }

  private async requireVersion(slug: string, version: string): Promise<VersionRow> {
    const skill = await this.requireSkill(slug);
    const rows = await this.db
      .select()
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skill.id), eq(skillVersions.version, version)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ApiError('NOT_FOUND', `${slug}@${version} was not found.`);
    return row;
  }

  async download(
    slug: string,
    version: string,
    opts: { agent?: Agent } = {},
  ): Promise<{ bytes: Uint8Array; digest: string; archiveDigest: string; filename: string }> {
    const row = await this.requireVersion(slug, version);
    if (row.status === 'revoked') {
      throw new ApiError('GONE', `${slug}@${version} has been revoked and cannot be downloaded.`);
    }
    if (row.status === 'quarantined') {
      throw new ApiError('FORBIDDEN', `${slug}@${version} is quarantined pending review.`);
    }
    const bytes = await this.store.get(row.storageKey);
    if (!bytes) throw new ApiError('INTERNAL', 'The package artifact is missing.');
    if (`sha256:${sha256Hex(bytes)}` !== row.archiveDigest) {
      throw new ApiError('INTEGRITY', 'The stored artifact failed its integrity check.', {
        status: 500,
      });
    }
    try {
      await this.db.insert(installEvents).values({
        id: randomUUID(),
        skillVersionId: row.id,
        agent: opts.agent ?? null,
        action: 'download',
        result: 'ok',
      });
    } catch {
      // Usage counters must never break a download.
    }
    return {
      bytes,
      digest: row.digest,
      archiveDigest: row.archiveDigest,
      filename: `${slug}-${version}.skillpkg`,
    };
  }

  // -------------------------------------------------------------------------
  // Moderation
  // -------------------------------------------------------------------------

  async revoke(slug: string, version: string, reason: string): Promise<RegistryVersionStatus> {
    const row = await this.requireVersion(slug, version);
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(skillVersions)
        .set({ status: 'revoked', statusReason: reason, revokedAt: row.revokedAt ?? now })
        .where(eq(skillVersions.id, row.id));
      await tx
        .insert(revocations)
        .values({ skillVersionId: row.id, reason, createdAt: now })
        .onConflictDoUpdate({ target: revocations.skillVersionId, set: { reason } });
    });
    return { slug, version, status: 'revoked', reason };
  }

  /** Admin approve (active) / quarantine / revoke. Revocation is final. */
  async setStatus(
    slug: string,
    version: string,
    status: VersionStatus,
    reason: string,
  ): Promise<RegistryVersionStatus> {
    if (status === 'revoked') return this.revoke(slug, version, reason);
    const row = await this.requireVersion(slug, version);
    if (row.status === 'revoked') {
      throw new ApiError('CONFLICT', `${slug}@${version} is revoked; revocation is final.`);
    }
    await this.db
      .update(skillVersions)
      .set({ status, statusReason: reason })
      .where(eq(skillVersions.id, row.id));
    return { slug, version, status, reason };
  }

  /** Re-scan a stored version with the current scanner. A new BLOCK quarantines an active version. */
  async rescan(
    slug: string,
    version: string,
  ): Promise<
    { slug: string; version: string; status: VersionStatus } & NonNullable<SkillInfoVersion['scan']>
  > {
    const row = await this.requireVersion(slug, version);
    const bytes = await this.store.get(row.storageKey);
    if (!bytes) throw new ApiError('INTERNAL', 'The package artifact is missing.');
    if (`sha256:${sha256Hex(bytes)}` !== row.archiveDigest) {
      throw new ApiError('INTEGRITY', 'The stored artifact failed its integrity check.', {
        status: 500,
      });
    }
    let pkg: SkillPackage;
    try {
      pkg = readSkillArchive(bytes);
    } catch (error) {
      mapCoreError(error);
    }
    if (pkg.digest !== row.digest) throw new ApiError('INTEGRITY', 'Content digest mismatch.');
    const scan = scanPackage(
      pkg.files.map((f) => ({ path: f.path, content: f.content, kind: f.kind })),
    );
    const policy = evaluatePolicy(scan.findings, pkg.manifest);
    let status = row.status;
    await this.db.transaction(async (tx) => {
      await tx.insert(securityScans).values({
        id: randomUUID(),
        skillVersionId: row.id,
        scannerVersion: scan.scannerVersion ?? SCANNER_VERSION,
        outcome: policy.outcome,
        findingsJson: policy.findings,
        createdAt: this.now(),
      });
      if (policy.outcome === 'block' && row.status === 'active') {
        status = 'quarantined';
        await tx
          .update(skillVersions)
          .set({ status, statusReason: 'Blocked by rescan' })
          .where(eq(skillVersions.id, row.id));
      }
    });
    return {
      slug,
      version,
      status,
      scannerVersion: scan.scannerVersion ?? SCANNER_VERSION,
      outcome: policy.outcome,
      findings: policy.findings,
    };
  }

  /** Versions in a given state, newest first (admin queue). */
  async listByStatus(status: VersionStatus | 'any', limit = 50): Promise<QueueItem[]> {
    const rows = await this.db
      .select()
      .from(skillVersions)
      .where(status === 'any' ? undefined : eq(skillVersions.status, status))
      .orderBy(desc(skillVersions.createdAt))
      .limit(limit);
    if (rows.length === 0) return [];
    const skillRows = await this.db
      .select()
      .from(skills)
      .where(inArray(skills.id, [...new Set(rows.map((r) => r.skillId))]));
    const skillMap = new Map(skillRows.map((s) => [s.id, s]));
    const pubs = await this.publishersById([...new Set(skillRows.map((s) => s.publisherId))]);
    const described = await this.describeVersions(rows);
    return rows.map((r) => {
      const skill = skillMap.get(r.skillId) as SkillRow;
      return {
        slug: skill.slug,
        name: skill.name,
        version: r.version,
        status: r.status,
        statusReason: r.statusReason,
        publisher: publisherRef(pubs.get(skill.publisherId)) ?? {
          name: 'unknown',
          verified: false,
        },
        createdAt: r.createdAt.toISOString(),
        digest: r.digest,
        scan: described.get(r.id)?.scan ?? null,
      };
    });
  }

  async listPublisherSkills(publisherId: string): Promise<PublisherSkillSummary[]> {
    const skillRows = await this.db
      .select()
      .from(skills)
      .where(eq(skills.publisherId, publisherId))
      .orderBy(skills.slug);
    const rows = await this.versionRows(skillRows.map((s) => s.id));
    const described = await this.describeVersions(rows);
    return skillRows.map((s) => ({
      slug: s.slug,
      name: s.name,
      versions: rows
        .filter((r) => r.skillId === s.id)
        .sort(byVersionDesc)
        .map((r) => {
          const scan = described.get(r.id)?.scan;
          const counts = { INFO: 0, WARN: 0, BLOCK: 0 };
          for (const f of scan?.findings ?? []) counts[f.decision] += 1;
          return {
            version: r.version,
            status: r.status,
            statusReason: r.statusReason,
            createdAt: r.createdAt.toISOString(),
            outcome: scan?.outcome ?? null,
            counts,
          };
        }),
    }));
  }
}

export interface RegistryVersionStatus {
  slug: string;
  version: string;
  status: VersionStatus;
  reason: string;
}

function requirementRows(manifest: SkillManifest | null, skillVersionId: string) {
  const rows: {
    skillVersionId: string;
    kind: 'runtime' | 'command' | 'mcp';
    name: string;
    constraint: string | null;
  }[] = [];
  const req = manifest?.requires;
  for (const [name, constraint] of Object.entries(req?.runtimes ?? {})) {
    rows.push({ skillVersionId, kind: 'runtime', name, constraint });
  }
  for (const name of req?.commands ?? []) {
    rows.push({ skillVersionId, kind: 'command', name, constraint: null });
  }
  for (const name of req?.mcp ?? [])
    rows.push({ skillVersionId, kind: 'mcp', name, constraint: null });
  return rows;
}

let cached: { db: Db; registry: Registry } | undefined;

/**
 * Registry backed by `<dataDir>/pglite` and `<dataDir>/artifacts`. The database client is
 * process-wide; the Registry object is per module instance, because Next.js may bundle this
 * module once for pages and once for route handlers.
 */
export async function getRegistry(): Promise<Registry> {
  const { db } = await getDatabase();
  if (cached?.db !== db) {
    const store = new LocalFsStore(path.join(dataDir(), 'artifacts'));
    cached = { db, registry: new Registry({ db, store }) };
  }
  return cached.registry;
}
