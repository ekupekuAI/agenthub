/**
 * Registry service. Server-only: imported by route handlers, server components and server
 * actions — never by client components.
 *
 * Bounds: every read path selects only the columns it needs (never the README, file list,
 * frontmatter or manifest of a version list, and findings only for the version on display),
 * findings are capped per scan, the stored README is capped, and uploads are checked in a
 * worker thread with a time budget (scan-runner.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { EvaluatedFinding, SkillFrontmatter, SkillManifest } from '@agenthub/core';
import { and, count, desc, eq, gt, inArray, lt, ne, or, type SQL, sql } from 'drizzle-orm';
import semver from 'semver';
import {
  blobAccess,
  blobToken,
  dataDir,
  MAX_LISTED_VERSIONS,
  MAX_STORED_README_CHARS,
  MAX_UPLOAD_BYTES,
  MAX_VERSIONS_PER_PUBLISHER_PER_DAY,
  MAX_VERSIONS_PER_SKILL_PER_DAY,
  onVercel,
} from '../config';
import { type DbHandle, getDatabase } from '../db/client';
import {
  adminSessionRevocations,
  installCounts,
  publishers,
  requirements,
  revocations,
  securityScans,
  skills,
  skillTargets,
  skillVersions,
} from '../db/schema';
import { type ArtifactStore, LocalFsStore, StorageError, storageKeyFor } from '../storage';
import { VercelBlobStore } from '../storage-blob';
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
import { type AnalyzedFile, defaultScanRunner, type ScanRunner } from './scan-runner';
import { cleanText, hasControlChars, stripNulDeep } from './text';
import { AGENTS, type Agent, SLUG_RE } from './validation';

type Db = DbHandle['db'];
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
  /** At most MAX_STORED_FINDINGS findings, BLOCK first. */
  findings: EvaluatedFinding[];
  /** Findings the scan produced before the cap. */
  findingsTotal?: number;
  /** Why the version was quarantined, when it was. */
  statusReason?: string | null;
  warnings: { code: string; message: string; path?: string }[];
}

export type FileEntry = AnalyzedFile;

export interface SkillDetail {
  info: SkillInfo;
  /** The version shown on the detail page: latest active, else the newest version. */
  shown: SkillInfoVersion | null;
  /** README of the shown version; empty unless that version is active. */
  readme: string;
  /** True when the stored README was cut at MAX_STORED_README_CHARS. */
  readmeTruncated?: boolean;
  /** Files of the shown version; empty unless that version is active. */
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
    /** Content digest (`sha256:…`) of the version. */
    digest: string;
    outcome: ScanOutcome | null;
    counts: { INFO: number; WARN: number; BLOCK: number };
  }[];
}

export interface RegistryVersionStatus {
  slug: string;
  version: string;
  status: VersionStatus;
  reason: string;
}

const CATEGORY_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Files compared against revoked versions when a new version is published. */
const SCRIPT_RE = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php)$/i;
const README_TRUNCATED_NOTE =
  '\n\n---\n\n*This README is longer than the registry displays. Install the skill to read it all.*\n';

/** Columns of skill_versions every list/read path needs. No README, files, frontmatter. */
const versionColumns = {
  id: skillVersions.id,
  skillId: skillVersions.skillId,
  version: skillVersions.version,
  digest: skillVersions.digest,
  archiveDigest: skillVersions.archiveDigest,
  storageKey: skillVersions.storageKey,
  sizeBytes: skillVersions.sizeBytes,
  status: skillVersions.status,
  statusReason: skillVersions.statusReason,
  channel: skillVersions.channel,
  releaseNotes: skillVersions.releaseNotes,
  createdAt: skillVersions.createdAt,
  revokedAt: skillVersions.revokedAt,
  permissions: sql<
    SkillManifest['permissions'] | null
  >`${skillVersions.manifestJson} -> 'permissions'`.mapWith((v: unknown) =>
    typeof v === 'string' ? JSON.parse(v) : v,
  ),
};

const skillColumns = {
  id: skills.id,
  slug: skills.slug,
  name: skills.name,
  summary: skills.summary,
  category: skills.category,
  publisherId: skills.publisherId,
  createdAt: skills.createdAt,
  updatedAt: skills.updatedAt,
};

type VersionRow = {
  id: string;
  skillId: string;
  version: string;
  digest: string;
  archiveDigest: string;
  storageKey: string;
  sizeBytes: number;
  status: VersionStatus;
  statusReason: string | null;
  channel: 'stable' | 'beta';
  releaseNotes: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  permissions: SkillManifest['permissions'] | null;
};
type SkillRow = {
  id: string;
  slug: string;
  name: string;
  summary: string;
  category: string;
  publisherId: string;
  createdAt: Date;
  updatedAt: Date;
};

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Name of the unique constraint a Postgres error violated, or null for other errors. */
function uniqueViolation(error: unknown): string | null {
  let current: unknown = error;
  for (let i = 0; i < 5 && current; i++) {
    const e = current as { code?: string; constraint?: string; message?: string };
    if (e.code === '23505') {
      return e.constraint ?? /constraint "([^"]+)"/.exec(e.message ?? '')?.[1] ?? '';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function isStable(v: { channel: string; version: string }): boolean {
  return v.channel === 'stable' && semver.prerelease(v.version) === null;
}

function byVersionDesc(a: { version: string }, b: { version: string }): number {
  return semver.rcompare(a.version, b.version);
}

/** Latest active version: highest stable one, else the highest active prerelease. */
function pickLatest<T extends { status: string; version: string; channel: string }>(
  rows: T[],
): T | null {
  const active = rows.filter((v) => v.status === 'active').sort(byVersionDesc);
  return active.find(isStable) ?? active[0] ?? null;
}

function publisherRef(p: PublisherRow | undefined): PublisherRef | undefined {
  return p ? { name: p.displayName, verified: p.verifiedAt !== null } : undefined;
}

/** Listing fields (summary, category, tags) derived from a version's frontmatter. */
function listingFrom(frontmatter: SkillFrontmatter | Record<string, unknown>): {
  summary: string;
  category: string;
  tags: string;
} {
  const metadata = ((frontmatter as SkillFrontmatter).metadata ?? {}) as Record<string, unknown>;
  const rawCategory = typeof metadata.category === 'string' ? metadata.category.trim() : '';
  const description = (frontmatter as SkillFrontmatter).description;
  return {
    summary: cleanText(typeof description === 'string' ? description : '', {
      singleLine: true,
      max: 1024,
    }),
    category: rawCategory.length <= 32 && CATEGORY_RE.test(rawCategory) ? rawCategory : 'general',
    tags:
      typeof metadata.tags === 'string'
        ? cleanText(metadata.tags, { singleLine: true, max: 200 })
        : '',
  };
}

/** A moderation reason: trimmed, without control characters, at least 3 characters. */
function requireReason(reason: string): string {
  const cleaned = typeof reason === 'string' ? cleanText(reason, { singleLine: true }) : '';
  if (cleaned.length < 3) throw new ApiError('VALIDATION', 'A reason is required.');
  return cleaned.slice(0, 500);
}

function blockKeysOf(findings: EvaluatedFinding[]): Set<string> {
  return new Set(
    findings.filter((f) => f.decision === 'BLOCK').map((f) => `${f.ruleId}\u0000${f.file}`),
  );
}

export class Registry {
  private readonly db: Db;
  private readonly store: ArtifactStore;
  private readonly scanner: ScanRunner;
  private readonly now: () => Date;

  constructor(deps: { db: Db; store: ArtifactStore; scanner?: ScanRunner; now?: () => Date }) {
    this.db = deps.db;
    this.store = deps.store;
    this.scanner = deps.scanner ?? defaultScanRunner();
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
      if (uniqueViolation(error) !== null) {
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

  /**
   * Publisher for a presented token, or null (also for a suspended publisher). Hash lookup
   * plus constant-time confirmation.
   */
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
    if (row.disabledAt !== null) return null;
    return row;
  }

  /** Replace a publisher's token. The old token stops working immediately. */
  async rotatePublisherToken(displayName: string): Promise<{ displayName: string; token: string }> {
    const token = generatePublisherToken();
    const updated = await this.db
      .update(publishers)
      .set({ tokenHash: hashToken(token) })
      .where(eq(publishers.displayName, displayName))
      .returning({ displayName: publishers.displayName });
    if (updated.length === 0) {
      throw new ApiError('NOT_FOUND', `Publisher "${displayName}" was not found.`);
    }
    return { displayName, token };
  }

  /** Suspend (or reinstate) a publisher: a suspended publisher's token is refused. */
  async setPublisherDisabled(
    displayName: string,
    disabled: boolean,
  ): Promise<{ displayName: string; disabled: boolean }> {
    const updated = await this.db
      .update(publishers)
      .set({ disabledAt: disabled ? this.now() : null })
      .where(eq(publishers.displayName, displayName))
      .returning({ displayName: publishers.displayName });
    if (updated.length === 0) {
      throw new ApiError('NOT_FOUND', `Publisher "${displayName}" was not found.`);
    }
    return { displayName, disabled };
  }

  // -------------------------------------------------------------------------
  // Admin sessions (server-side sign-out)
  // -------------------------------------------------------------------------

  async revokeAdminSession(nonce: string, expiresAt: Date): Promise<void> {
    await this.db
      .delete(adminSessionRevocations)
      .where(lt(adminSessionRevocations.expiresAt, this.now()));
    await this.db
      .insert(adminSessionRevocations)
      .values({ nonce, expiresAt })
      .onConflictDoNothing();
  }

  async isAdminSessionRevoked(nonce: string): Promise<boolean> {
    const rows = await this.db
      .select({ nonce: adminSessionRevocations.nonce })
      .from(adminSessionRevocations)
      .where(eq(adminSessionRevocations.nonce, nonce))
      .limit(1);
    return rows.length > 0;
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
    if (opts.releaseNotes !== undefined) {
      if (opts.releaseNotes.length > 5000) {
        throw new ApiError('VALIDATION', 'Release notes are limited to 5,000 characters.');
      }
      if (hasControlChars(opts.releaseNotes)) {
        throw new ApiError('VALIDATION', 'Release notes must not contain control characters.');
      }
    }
    const archiveDigest = `sha256:${sha256Hex(bytes)}`;

    // Unpack, validate and scan in a worker thread with a time budget.
    const analysis = await this.scanner.analyze(bytes);
    const pkg = analysis.pkg;

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

    // Ownership, immutability and quota checks before anything is written.
    const now = this.now();
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
    await this.enforcePublishQuota(publisherId, existing?.id ?? null, now);

    let status: VersionStatus = analysis.outcome === 'block' ? 'quarantined' : 'active';
    let statusReason: string | null =
      status === 'quarantined' ? `Blocked by scanner: ${analysis.blockRuleIds.join(', ')}` : null;
    if (status === 'active') {
      // Revocation and quarantine must not be undone by re-uploading the same content under
      // another version (or another name).
      const held = await this.db
        .select({ slug: skills.slug, version: skillVersions.version, status: skillVersions.status })
        .from(skillVersions)
        .innerJoin(skills, eq(skills.id, skillVersions.skillId))
        .where(
          and(
            or(
              eq(skillVersions.digest, pkg.digest),
              eq(skillVersions.archiveDigest, archiveDigest),
            ),
            ne(skillVersions.status, 'active'),
          ),
        )
        .limit(1);
      const match = held[0];
      if (match) {
        status = 'quarantined';
        statusReason = `Same content as ${match.slug}@${match.version}, which is ${match.status}; held for review.`;
      } else {
        // A version bump in agenthub.yaml changes the digest; the instructions and scripts of
        // a revoked version must still not come back without review.
        const reused = await this.revokedFileMatch(pkg.files);
        if (reused) {
          status = 'quarantined';
          statusReason = `Reuses ${reused.path} from revoked ${reused.slug}@${reused.version}; held for review.`;
        }
      }
    }

    const manifest = pkg.manifest ? stripNulDeep(pkg.manifest) : null;
    const frontmatter = stripNulDeep(pkg.frontmatter);
    const listing = listingFrom(frontmatter);
    const channel = manifest?.channel ?? (semver.prerelease(version) === null ? 'stable' : 'beta');
    const targets: Agent[] = [
      ...new Set((manifest?.targets?.length ? manifest.targets : [...AGENTS]) as string[]),
    ].filter((a): a is Agent => (AGENTS as readonly string[]).includes(a));
    let readme = stripNulDeep(pkg.body);
    if (readme.length > MAX_STORED_README_CHARS) {
      readme = readme.slice(0, MAX_STORED_README_CHARS) + README_TRUNCATED_NOTE;
    }
    const releaseNotes = opts.releaseNotes ? cleanText(opts.releaseNotes).trim() || null : null;
    const versionId = randomUUID();

    const storageKey = storageKeyFor(archiveDigest);
    try {
      await this.store.put(storageKey, bytes);
    } catch (error) {
      if (error instanceof StorageError) {
        console.error('[agenthub] artifact store:', error.message);
        throw new ApiError('INTERNAL', 'The package could not be stored. Try again later.');
      }
      throw error;
    }

    try {
      await this.db.transaction(async (tx) => {
        let skillId = existing?.id;
        if (!skillId) {
          skillId = randomUUID();
          await tx.insert(skills).values({
            id: skillId,
            slug,
            name: pkg.name,
            ...listing,
            publisherId,
            createdAt: now,
            updatedAt: now,
          });
        } else if (status === 'active') {
          // Only an active version may change what search and the skill page show.
          const current = await tx
            .select({ version: skillVersions.version })
            .from(skillVersions)
            .where(and(eq(skillVersions.skillId, skillId), eq(skillVersions.status, 'active')));
          const isNewest = current.every((v) => semver.gt(version, v.version));
          await tx
            .update(skills)
            .set(isNewest ? { ...listing, updatedAt: now } : { updatedAt: now })
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
          frontmatterJson: frontmatter,
          readme,
          filesJson: stripNulDeep(pkg.files),
          releaseNotes,
          createdAt: now,
        });
        if (targets.length > 0) {
          await tx
            .insert(skillTargets)
            .values(
              targets.map((agentId) => ({ skillVersionId: versionId, agentId, mode: 'native' })),
            );
        }
        const reqs = requirementRows(manifest, versionId);
        if (reqs.length > 0) await tx.insert(requirements).values(reqs);
        await tx.insert(securityScans).values({
          id: randomUUID(),
          skillVersionId: versionId,
          scannerVersion: analysis.scannerVersion,
          outcome: analysis.outcome,
          findingsJson: stripNulDeep(analysis.findings),
          findingsTotal: analysis.findingsTotal,
          blockCount: analysis.counts.BLOCK,
          warnCount: analysis.counts.WARN,
          infoCount: analysis.counts.INFO,
          createdAt: now,
        });
      });
    } catch (error) {
      await this.dropUnreferencedArtifact(storageKey);
      const constraint = uniqueViolation(error);
      if (constraint === 'skill_versions_skill_version_unique') {
        throw new ApiError(
          'CONFLICT',
          `${slug}@${version} already exists. Versions are immutable; publish a new version.`,
        );
      }
      if (constraint === 'skills_slug_key' || constraint === 'skills_slug_unique') {
        throw new ApiError('CONFLICT', `The name "${slug}" is taken.`);
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
      outcome: analysis.outcome,
      scannerVersion: analysis.scannerVersion,
      findings: analysis.findings,
      findingsTotal: analysis.findingsTotal,
      statusReason,
      warnings: pkg.issues,
    };
  }

  private async enforcePublishQuota(
    publisherId: string,
    skillId: string | null,
    now: Date,
  ): Promise<void> {
    const since = new Date(now.getTime() - DAY_MS);
    if (skillId) {
      const [row] = await this.db
        .select({ n: count() })
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, skillId), gt(skillVersions.createdAt, since)));
      if ((row?.n ?? 0) >= MAX_VERSIONS_PER_SKILL_PER_DAY) {
        throw new ApiError(
          'RATE_LIMITED',
          `A skill can receive at most ${MAX_VERSIONS_PER_SKILL_PER_DAY} new versions per day.`,
          { headers: { 'Retry-After': '3600' } },
        );
      }
    }
    const [row] = await this.db
      .select({ n: count() })
      .from(skillVersions)
      .innerJoin(skills, eq(skills.id, skillVersions.skillId))
      .where(and(eq(skills.publisherId, publisherId), gt(skillVersions.createdAt, since)));
    if ((row?.n ?? 0) >= MAX_VERSIONS_PER_PUBLISHER_PER_DAY) {
      throw new ApiError(
        'RATE_LIMITED',
        `A publisher can publish at most ${MAX_VERSIONS_PER_PUBLISHER_PER_DAY} versions per day.`,
        { headers: { 'Retry-After': '3600' } },
      );
    }
  }

  /** A revoked version containing one of these instruction/script files, byte for byte. */
  private async revokedFileMatch(
    files: AnalyzedFile[],
  ): Promise<{ slug: string; version: string; path: string } | null> {
    const watched = files
      .filter((f) => f.path === 'SKILL.md' || f.executable || SCRIPT_RE.test(f.path))
      .filter((f) => f.sha256)
      .slice(0, 100);
    if (watched.length === 0) return null;
    const hashes = sql.join(
      watched.map((f) => sql`${f.sha256}`),
      sql`, `,
    );
    const [hit] = await this.db
      .select({
        slug: skills.slug,
        version: skillVersions.version,
        sha256: sql<string>`(select f->>'sha256' from jsonb_array_elements(${skillVersions.filesJson}) f where f->>'sha256' in (${hashes}) limit 1)`,
      })
      .from(skillVersions)
      .innerJoin(skills, eq(skills.id, skillVersions.skillId))
      .where(
        and(
          eq(skillVersions.status, 'revoked'),
          sql`exists (select 1 from jsonb_array_elements(${skillVersions.filesJson}) f where f->>'sha256' in (${hashes}))`,
        ),
      )
      .limit(1);
    if (!hit) return null;
    const file = watched.find((f) => f.sha256 === hit.sha256);
    return { slug: hit.slug, version: hit.version, path: file?.path ?? 'a file' };
  }

  /** Roll back an artifact written for a publish whose database transaction failed. */
  private async dropUnreferencedArtifact(storageKey: string): Promise<void> {
    try {
      const refs = await this.db
        .select({ id: skillVersions.id })
        .from(skillVersions)
        .where(eq(skillVersions.storageKey, storageKey))
        .limit(1);
      if (refs.length === 0) await this.store.delete(storageKey);
    } catch (error) {
      console.error(
        '[agenthub] could not remove an orphaned artifact:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  private async skillBySlug(slug: string): Promise<SkillRow | null> {
    const rows = await this.db
      .select(skillColumns)
      .from(skills)
      .where(eq(skills.slug, slug))
      .limit(1);
    return rows[0] ?? null;
  }

  private async requireSkill(slug: string): Promise<SkillRow> {
    const skill = await this.skillBySlug(slug);
    if (!skill) throw new ApiError('NOT_FOUND', `Skill "${slug}" was not found.`);
    return skill;
  }

  private async versionRows(
    skillIds: string[],
    opts: { activeOnly?: boolean } = {},
  ): Promise<VersionRow[]> {
    if (skillIds.length === 0) return [];
    const where = opts.activeOnly
      ? and(inArray(skillVersions.skillId, skillIds), eq(skillVersions.status, 'active'))
      : inArray(skillVersions.skillId, skillIds);
    return (await this.db.select(versionColumns).from(skillVersions).where(where)) as VersionRow[];
  }

  private async publishersById(ids: string[]): Promise<Map<string, PublisherRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.select().from(publishers).where(inArray(publishers.id, ids));
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async targetsFor(versionIds: string[]): Promise<Map<string, Agent[]>> {
    const out = new Map<string, Agent[]>();
    if (versionIds.length === 0) return out;
    const rows = await this.db
      .select({ skillVersionId: skillTargets.skillVersionId, agentId: skillTargets.agentId })
      .from(skillTargets)
      .where(inArray(skillTargets.skillVersionId, versionIds));
    for (const row of rows) {
      const list = out.get(row.skillVersionId) ?? [];
      list.push(row.agentId as Agent);
      out.set(row.skillVersionId, list);
    }
    for (const list of out.values()) list.sort((a, b) => AGENTS.indexOf(a) - AGENTS.indexOf(b));
    return out;
  }

  /** The latest scan of each version, without its findings. */
  private async latestScans(versionIds: string[]) {
    if (versionIds.length === 0) return [];
    const findings = securityScans.findingsJson;
    const countOf = (decision: string) =>
      sql`(select count(*) from jsonb_array_elements(${findings}) f where f->>'decision' = ${decision})`;
    return this.db
      .selectDistinctOn([securityScans.skillVersionId], {
        id: securityScans.id,
        skillVersionId: securityScans.skillVersionId,
        scannerVersion: securityScans.scannerVersion,
        outcome: securityScans.outcome,
        createdAt: securityScans.createdAt,
        total:
          sql<number>`coalesce(${securityScans.findingsTotal}, jsonb_array_length(${findings}))`.mapWith(
            Number,
          ),
        block: sql<number>`coalesce(${securityScans.blockCount}, ${countOf('BLOCK')})`.mapWith(
          Number,
        ),
        warn: sql<number>`coalesce(${securityScans.warnCount}, ${countOf('WARN')})`.mapWith(Number),
        info: sql<number>`coalesce(${securityScans.infoCount}, ${countOf('INFO')})`.mapWith(Number),
      })
      .from(securityScans)
      .where(inArray(securityScans.skillVersionId, versionIds))
      .orderBy(securityScans.skillVersionId, desc(securityScans.createdAt));
  }

  /**
   * Expand version rows into SkillInfoVersion objects (targets, requirements, latest scan).
   * Findings are loaded only for the versions in `withFindings`; the others carry counts.
   */
  private async describeVersions(
    rows: VersionRow[],
    withFindings: ReadonlySet<string> | 'all' = new Set(),
  ): Promise<Map<string, SkillInfoVersion>> {
    const ids = rows.map((r) => r.id);
    const out = new Map<string, SkillInfoVersion>();
    if (ids.length === 0) return out;
    const [targets, reqs, scans, revs] = await Promise.all([
      this.targetsFor(ids),
      this.db
        .select({
          skillVersionId: requirements.skillVersionId,
          kind: requirements.kind,
          name: requirements.name,
          constraint: requirements.constraint,
        })
        .from(requirements)
        .where(inArray(requirements.skillVersionId, ids)),
      this.latestScans(ids),
      this.db
        .select({ skillVersionId: revocations.skillVersionId, reason: revocations.reason })
        .from(revocations)
        .where(inArray(revocations.skillVersionId, ids)),
    ]);
    const scanByVersion = new Map(scans.map((s) => [s.skillVersionId, s]));
    const findingScanIds = scans
      .filter((s) => withFindings === 'all' || withFindings.has(s.skillVersionId))
      .map((s) => s.id);
    const findingsByScan = new Map<string, EvaluatedFinding[]>();
    if (findingScanIds.length > 0) {
      const loaded = await this.db
        .select({ id: securityScans.id, findings: securityScans.findingsJson })
        .from(securityScans)
        .where(inArray(securityScans.id, findingScanIds));
      for (const row of loaded) findingsByScan.set(row.id, row.findings as EvaluatedFinding[]);
    }
    const reasonByVersion = new Map(revs.map((r) => [r.skillVersionId, r.reason]));
    for (const row of rows) {
      const scan = scanByVersion.get(row.id);
      const revoked = reasonByVersion.get(row.id);
      const findings = scan ? (findingsByScan.get(scan.id) ?? []) : [];
      const v: SkillInfoVersion = {
        version: row.version,
        digest: row.digest,
        archiveDigest: row.archiveDigest,
        status: row.status,
        channel: row.channel,
        agents: targets.get(row.id) ?? [],
        createdAt: row.createdAt.toISOString(),
        sizeBytes: row.sizeBytes,
        requirements: reqs
          .filter((r) => r.skillVersionId === row.id)
          .map((r) => ({ kind: r.kind, name: r.name, constraint: r.constraint })),
        permissions: row.permissions ?? {},
        scan: scan
          ? {
              scannerVersion: scan.scannerVersion,
              outcome: scan.outcome,
              findings,
              scannedAt: scan.createdAt.toISOString(),
              findingsTotal: scan.total,
              findingsTruncated: findings.length < scan.total,
              counts: { INFO: scan.info, WARN: scan.warn, BLOCK: scan.block },
            }
          : undefined,
        releaseNotes: row.releaseNotes,
      };
      if (revoked !== undefined) v.revokedReason = revoked;
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
        sql`${skills.slug} ilike ${pattern}`,
        sql`${skills.name} ilike ${pattern}`,
        sql`${skills.summary} ilike ${pattern}`,
        sql`${skills.category} ilike ${pattern}`,
        sql`${skills.tags} ilike ${pattern}`,
      );
      if (match) conditions.push(match);
    }
    if (opts.category) conditions.push(eq(skills.category, opts.category));

    // Rank before LIMIT, so newer look-alikes cannot push an exact match out of the page.
    const first = terms[0]?.toLowerCase();
    const rank = first
      ? sql`case
          when ${skills.slug} = ${first} then 0
          when ${skills.slug} like ${`${escapeLike(first)}%`} then 1
          when ${skills.slug} ilike ${`%${escapeLike(first)}%`} or ${skills.name} ilike ${`%${escapeLike(first)}%`} then 2
          else 3 end`
      : null;

    const rows = await this.db
      .select(skillColumns)
      .from(skills)
      .where(and(...conditions))
      .orderBy(...(rank ? [rank] : []), desc(skills.updatedAt))
      .limit(limit);

    const versions = await this.versionRows(
      rows.map((r) => r.id),
      { activeOnly: true },
    );
    let eligible = versions;
    if (opts.agent) {
      const targets = await this.targetsFor(versions.map((v) => v.id));
      const agent = opts.agent;
      eligible = versions.filter((v) => (targets.get(v.id) ?? []).includes(agent));
    }
    const latestRows = new Map<string, VersionRow>();
    for (const skill of rows) {
      // With an agent filter, report the newest version that agent can install (as resolve does).
      const latest = pickLatest(eligible.filter((v) => v.skillId === skill.id));
      if (latest) latestRows.set(skill.id, latest);
    }
    const [described, pubs] = await Promise.all([
      this.describeVersions([...latestRows.values()]),
      this.publishersById([...new Set(rows.map((r) => r.publisherId))]),
    ]);

    const results: SearchResult[] = [];
    for (const skill of rows) {
      const latest = latestRows.get(skill.id);
      if (!latest) continue;
      const info = described.get(latest.id);
      results.push({
        slug: skill.slug,
        name: skill.name,
        summary: skill.summary,
        category: skill.category,
        latestVersion: latest.version,
        publisher: publisherRef(pubs.get(skill.publisherId)),
        agents: info?.agents ?? [],
        scanOutcome: info?.scan?.outcome,
        updatedAt: skill.updatedAt.toISOString(),
      });
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
    return (await this.loadSkill(slug, false)).info;
  }

  async getSkill(slug: string): Promise<SkillDetail> {
    return this.loadSkill(slug, true);
  }

  private async loadSkill(slug: string, withDetail: boolean): Promise<SkillDetail> {
    const skill = await this.requireSkill(slug);
    const all = (await this.versionRows([skill.id])).sort(byVersionDesc);
    const rows = all.slice(0, MAX_LISTED_VERSIONS);
    const latestRow = pickLatest(all);
    if (latestRow && !rows.includes(latestRow)) rows.push(latestRow);
    const shownRow = latestRow ?? rows[0] ?? null;
    const withFindings = new Set(
      [latestRow?.id, shownRow?.id].filter((id): id is string => id !== undefined),
    );
    const [described, pubs] = await Promise.all([
      this.describeVersions(rows, withFindings),
      this.publishersById([skill.publisherId]),
    ]);
    const info: SkillInfo = {
      slug: skill.slug,
      name: skill.name,
      summary: skill.summary,
      category: skill.category,
      publisher: publisherRef(pubs.get(skill.publisherId)),
      latest: latestRow ? (described.get(latestRow.id) ?? null) : null,
      versions: rows.map((r) => described.get(r.id) as SkillInfoVersion),
    };

    let readme = '';
    let files: FileEntry[] = [];
    let frontmatter: Record<string, unknown> = {};
    if (withDetail && shownRow) {
      const [meta] = await this.db
        .select({ frontmatter: skillVersions.frontmatterJson })
        .from(skillVersions)
        .where(eq(skillVersions.id, shownRow.id))
        .limit(1);
      frontmatter = (meta?.frontmatter ?? {}) as Record<string, unknown>;
      // Only an active version's README and file list are published on the site: a
      // quarantined or revoked version may hold exactly what got it pulled (a leaked secret,
      // malicious instructions).
      if (shownRow.status === 'active') {
        const [detail] = await this.db
          .select({ readme: skillVersions.readme, files: skillVersions.filesJson })
          .from(skillVersions)
          .where(eq(skillVersions.id, shownRow.id))
          .limit(1);
        readme = detail?.readme ?? '';
        files = (detail?.files ?? []) as FileEntry[];
      }
    }
    return {
      info,
      shown: shownRow ? (described.get(shownRow.id) ?? null) : null,
      readme,
      readmeTruncated: readme.endsWith(README_TRUNCATED_NOTE),
      files,
      license: typeof frontmatter.license === 'string' ? frontmatter.license : undefined,
      compatibility:
        typeof frontmatter.compatibility === 'string' ? frontmatter.compatibility : undefined,
      statusReason: shownRow?.statusReason ?? null,
      createdAt: skill.createdAt.toISOString(),
      updatedAt: skill.updatedAt.toISOString(),
    };
  }

  /**
   * Versions, including quarantined and revoked ones, newest first (at most
   * MAX_LISTED_VERSIONS per page). Scans carry outcome and counts, not findings.
   */
  async listVersions(
    slug: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<SkillInfoVersion[]> {
    const skill = await this.requireSkill(slug);
    const limit = Math.min(Math.max(opts.limit ?? MAX_LISTED_VERSIONS, 1), MAX_LISTED_VERSIONS);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = (await this.versionRows([skill.id]))
      .sort(byVersionDesc)
      .slice(offset, offset + limit);
    const described = await this.describeVersions(rows);
    return rows.map((r) => described.get(r.id) as SkillInfoVersion);
  }

  async resolve(
    slug: string,
    opts: { agent?: Agent; range?: string; channel?: 'stable' | 'beta' } = {},
  ): Promise<ResolveResult> {
    const skill = await this.requireSkill(slug);
    const rows = await this.versionRows([skill.id]);
    const beta = opts.channel === 'beta';
    const range = opts.range && opts.range !== 'latest' ? opts.range.trim() : undefined;
    if (range && semver.validRange(range) === null) {
      throw new ApiError('VALIDATION', `"${range}" is not a valid version range.`);
    }
    const targets = await this.targetsFor(
      rows.filter((v) => v.status === 'active').map((v) => v.id),
    );
    const supports = (v: VersionRow) =>
      !opts.agent || (targets.get(v.id) ?? []).includes(opts.agent);
    const found = (v: VersionRow): ResolveResult => ({
      slug,
      version: v.version,
      digest: v.digest,
      archiveDigest: v.archiveDigest,
      downloadUrl: `/api/v1/skills/${slug}/download/${v.version}`,
    });

    // An exact version ('1.2.0', '=1.2.0', 'v1.2.0') is a pin: it ignores the channel, like the
    // CLI resolver, and reports a revoked or quarantined version as such.
    const pin = range ? semver.clean(range) : null;
    if (pin) {
      const exact = rows.find((v) => semver.eq(v.version, pin));
      if (exact?.status === 'revoked') {
        throw new ApiError('GONE', `${slug}@${exact.version} has been revoked.`);
      }
      if (exact?.status === 'quarantined') {
        throw new ApiError('FORBIDDEN', `${slug}@${exact.version} is quarantined.`);
      }
      if (exact && supports(exact)) return found(exact);
      throw new ApiError(
        'NOT_FOUND',
        `No active version of ${slug} matching "${range}"${opts.agent ? ` for ${opts.agent}` : ''}.`,
      );
    }

    const chosen = rows
      .filter((v) => v.status === 'active')
      .filter((v) => beta || isStable(v))
      .filter((v) => !range || semver.satisfies(v.version, range, { includePrerelease: beta }))
      .filter(supports)
      .sort(byVersionDesc)[0];
    if (!chosen) {
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
    return found(chosen);
  }

  private async requireVersion(slug: string, version: string): Promise<VersionRow> {
    const skill = await this.requireSkill(slug);
    const rows = (await this.db
      .select(versionColumns)
      .from(skillVersions)
      .where(and(eq(skillVersions.skillId, skill.id), eq(skillVersions.version, version)))
      .limit(1)) as VersionRow[];
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
      // One counter row per version, agent and day: bounded growth, one small write.
      await this.db
        .insert(installCounts)
        .values({
          skillVersionId: row.id,
          agent: opts.agent ?? '',
          day: this.now().toISOString().slice(0, 10),
          count: 1,
        })
        .onConflictDoUpdate({
          target: [installCounts.skillVersionId, installCounts.agent, installCounts.day],
          set: { count: sql`${installCounts.count} + 1` },
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

  /** Downloads per day for a version (newest first). */
  async downloadCounts(
    slug: string,
    version: string,
  ): Promise<{ day: string; agent: string | null; count: number }[]> {
    const row = await this.requireVersion(slug, version);
    const rows = await this.db
      .select({ day: installCounts.day, agent: installCounts.agent, count: installCounts.count })
      .from(installCounts)
      .where(eq(installCounts.skillVersionId, row.id))
      .orderBy(desc(installCounts.day));
    return rows.map((r) => ({ day: r.day, agent: r.agent || null, count: r.count }));
  }

  // -------------------------------------------------------------------------
  // Moderation
  // -------------------------------------------------------------------------

  /** Revoke a version. Final: nothing can make a revoked version active again. */
  async revoke(slug: string, version: string, reason: string): Promise<RegistryVersionStatus> {
    const why = requireReason(reason);
    const row = await this.requireVersion(slug, version);
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(skillVersions)
        .set({
          status: 'revoked',
          statusReason: why,
          revokedAt: sql`coalesce(${skillVersions.revokedAt}, ${now.toISOString()}::timestamptz)`,
        })
        .where(eq(skillVersions.id, row.id));
      await tx
        .insert(revocations)
        .values({ skillVersionId: row.id, reason: why, createdAt: now })
        .onConflictDoUpdate({ target: revocations.skillVersionId, set: { reason: why } });
    });
    return { slug, version, status: 'revoked', reason: why };
  }

  /**
   * Admin approve (active) / quarantine / revoke, with a required reason. Revocation is
   * final: the change is a single conditional UPDATE, so a concurrent revoke can never be
   * overwritten by an approve or a quarantine.
   */
  async setStatus(
    slug: string,
    version: string,
    status: VersionStatus,
    reason: string,
  ): Promise<RegistryVersionStatus> {
    if (status === 'revoked') return this.revoke(slug, version, reason);
    const why = requireReason(reason);
    const row = await this.requireVersion(slug, version);
    const updated = await this.db
      .update(skillVersions)
      .set({ status, statusReason: why })
      .where(
        and(
          eq(skillVersions.id, row.id),
          ne(skillVersions.status, 'revoked'),
          sql`not exists (select 1 from revocations r where r.skill_version_id = ${skillVersions.id})`,
        ),
      )
      .returning({ id: skillVersions.id });
    if (updated.length === 0) {
      throw new ApiError('CONFLICT', `${slug}@${version} is revoked; revocation is final.`);
    }
    if (status === 'active') await this.refreshListing(row.skillId);
    return { slug, version, status, reason: why };
  }

  /** Recompute a skill's summary/category/tags from its newest active version. */
  private async refreshListing(skillId: string): Promise<void> {
    const latest = pickLatest(await this.versionRows([skillId], { activeOnly: true }));
    if (!latest) return;
    const [row] = await this.db
      .select({ frontmatter: skillVersions.frontmatterJson })
      .from(skillVersions)
      .where(eq(skillVersions.id, latest.id))
      .limit(1);
    if (!row) return;
    await this.db
      .update(skills)
      .set({ ...listingFrom(row.frontmatter as SkillFrontmatter), updatedAt: this.now() })
      .where(eq(skills.id, skillId));
  }

  /**
   * Re-scan a stored version with the current scanner. A BLOCK finding that the previous scan
   * did not have quarantines an active version (an earlier approval of the same findings is
   * respected).
   */
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
    const analysis = await this.scanner.analyze(bytes);
    if (analysis.pkg.digest !== row.digest) {
      throw new ApiError('INTEGRITY', 'Content digest mismatch.');
    }

    const [previous] = await this.db
      .select({ findings: securityScans.findingsJson })
      .from(securityScans)
      .where(eq(securityScans.skillVersionId, row.id))
      .orderBy(desc(securityScans.createdAt))
      .limit(1);
    const known = blockKeysOf((previous?.findings ?? []) as EvaluatedFinding[]);
    const newBlocks = analysis.blockKeys.filter((k) => !known.has(k));
    const now = this.now();

    await this.db.transaction(async (tx) => {
      await tx.insert(securityScans).values({
        id: randomUUID(),
        skillVersionId: row.id,
        scannerVersion: analysis.scannerVersion,
        outcome: analysis.outcome,
        findingsJson: stripNulDeep(analysis.findings),
        findingsTotal: analysis.findingsTotal,
        blockCount: analysis.counts.BLOCK,
        warnCount: analysis.counts.WARN,
        infoCount: analysis.counts.INFO,
        createdAt: now,
      });
      if (analysis.outcome === 'block' && newBlocks.length > 0) {
        const rules = [...new Set(newBlocks.map((k) => k.split('\u0000')[0]))].join(', ');
        // Conditional: never touches a version that was revoked meanwhile.
        await tx
          .update(skillVersions)
          .set({ status: 'quarantined', statusReason: `Blocked by rescan: ${rules}` })
          .where(and(eq(skillVersions.id, row.id), eq(skillVersions.status, 'active')));
      }
    });
    const [current] = await this.db
      .select({ status: skillVersions.status })
      .from(skillVersions)
      .where(eq(skillVersions.id, row.id))
      .limit(1);
    return {
      slug,
      version,
      status: current?.status ?? row.status,
      scannerVersion: analysis.scannerVersion,
      outcome: analysis.outcome,
      findings: analysis.findings,
      scannedAt: now.toISOString(),
      findingsTotal: analysis.findingsTotal,
      findingsTruncated: analysis.findings.length < analysis.findingsTotal,
      counts: analysis.counts,
    };
  }

  /** Versions in a given state, newest first (admin queue). */
  async listByStatus(status: VersionStatus | 'any', limit = 50): Promise<QueueItem[]> {
    const rows = (await this.db
      .select(versionColumns)
      .from(skillVersions)
      .where(status === 'any' ? undefined : eq(skillVersions.status, status))
      .orderBy(desc(skillVersions.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200))) as VersionRow[];
    if (rows.length === 0) return [];
    const skillRows = await this.db
      .select(skillColumns)
      .from(skills)
      .where(inArray(skills.id, [...new Set(rows.map((r) => r.skillId))]));
    const skillMap = new Map(skillRows.map((s) => [s.id, s]));
    const [pubs, described] = await Promise.all([
      this.publishersById([...new Set(skillRows.map((s) => s.publisherId))]),
      this.describeVersions(rows, 'all'),
    ]);
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
      .select(skillColumns)
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
          return {
            version: r.version,
            status: r.status,
            statusReason: r.statusReason,
            createdAt: r.createdAt.toISOString(),
            digest: r.digest,
            outcome: scan?.outcome ?? null,
            counts: scan?.counts ?? { INFO: 0, WARN: 0, BLOCK: 0 },
          };
        }),
    }));
  }
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
  for (const name of new Set(req?.commands ?? [])) {
    rows.push({ skillVersionId, kind: 'command', name, constraint: null });
  }
  for (const name of new Set(req?.mcp ?? [])) {
    rows.push({ skillVersionId, kind: 'mcp', name, constraint: null });
  }
  return rows;
}

let cached: { db: Db; registry: Registry } | undefined;

/**
 * Artifact store for this deployment: Vercel Blob when BLOB_READ_WRITE_TOKEN is set,
 * otherwise the local folder `<dataDir>/artifacts`.
 */
export function createArtifactStore(): ArtifactStore {
  const token = blobToken();
  if (token) return new VercelBlobStore({ token, access: blobAccess() });
  if (onVercel()) {
    throw new Error(
      'BLOB_READ_WRITE_TOKEN is not set. On Vercel the registry stores packages in Vercel ' +
        'Blob (see docs/deploy-vercel.md); the local artifact folder cannot be written there.',
    );
  }
  return new LocalFsStore(path.join(dataDir(), 'artifacts'));
}

/**
 * Registry backed by the configured database (db/client.ts) and artifact store. The database
 * client is process-wide; the Registry object is per module instance, because Next.js may
 * bundle this module once for pages and once for route handlers.
 */
export async function getRegistry(): Promise<Registry> {
  const { db } = await getDatabase();
  if (cached?.db !== db) {
    cached = { db, registry: new Registry({ db, store: createArtifactStore() }) };
  }
  return cached.registry;
}
