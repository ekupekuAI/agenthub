/**
 * Registry schema (MVP §5). The SQL in ./migrate.ts creates the same tables; keep both in sync.
 */
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  role: text('role', { enum: ['publisher', 'admin'] })
    .notNull()
    .default('publisher'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const publishers = pgTable('publishers', {
  id: uuid('id').primaryKey(),
  userId: uuid('user_id').references(() => users.id),
  displayName: text('display_name').notNull().unique(),
  /** SHA-256 (hex) of the publisher token. The token itself is never stored. */
  tokenHash: text('token_hash').notNull().unique(),
  verifiedAt: ts('verified_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  detectorVersion: text('detector_version').notNull(),
});

export const skills = pgTable('skills', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  summary: text('summary').notNull(),
  category: text('category').notNull().default('general'),
  /** Space-separated search tags (from SKILL.md metadata.tags). */
  tags: text('tags').notNull().default(''),
  publisherId: uuid('publisher_id')
    .notNull()
    .references(() => publishers.id),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export type VersionStatus = 'active' | 'quarantined' | 'revoked';

export const skillVersions = pgTable(
  'skill_versions',
  {
    id: uuid('id').primaryKey(),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id),
    version: text('version').notNull(),
    /** Content digest 'sha256:<hex>' — the identity of the version. */
    digest: text('digest').notNull(),
    /** 'sha256:<hex>' of the .skillpkg bytes. */
    archiveDigest: text('archive_digest').notNull(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status', { enum: ['active', 'quarantined', 'revoked'] })
      .notNull()
      .$type<VersionStatus>(),
    statusReason: text('status_reason'),
    channel: text('channel', { enum: ['stable', 'beta'] })
      .notNull()
      .default('stable'),
    manifestJson: jsonb('manifest_json'),
    frontmatterJson: jsonb('frontmatter_json').notNull(),
    readme: text('readme').notNull(),
    filesJson: jsonb('files_json').notNull(),
    releaseNotes: text('release_notes'),
    createdAt: ts('created_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    unique('skill_versions_skill_version_unique').on(t.skillId, t.version),
    index('skill_versions_status_idx').on(t.status),
  ],
);

export const skillTargets = pgTable(
  'skill_targets',
  {
    skillVersionId: uuid('skill_version_id')
      .notNull()
      .references(() => skillVersions.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    mode: text('mode').notNull().default('native'),
    minVersion: text('min_version'),
    maxVersion: text('max_version'),
  },
  (t) => [
    primaryKey({ columns: [t.skillVersionId, t.agentId] }),
    index('skill_targets_agent_idx').on(t.agentId),
  ],
);

export const requirements = pgTable(
  'requirements',
  {
    id: serial('id').primaryKey(),
    skillVersionId: uuid('skill_version_id')
      .notNull()
      .references(() => skillVersions.id),
    kind: text('kind', { enum: ['runtime', 'command', 'mcp'] }).notNull(),
    name: text('name').notNull(),
    constraint: text('constraint'),
  },
  (t) => [index('requirements_version_idx').on(t.skillVersionId)],
);

export const securityScans = pgTable(
  'security_scans',
  {
    id: uuid('id').primaryKey(),
    skillVersionId: uuid('skill_version_id')
      .notNull()
      .references(() => skillVersions.id),
    scannerVersion: text('scanner_version').notNull(),
    outcome: text('outcome', { enum: ['allow', 'confirm', 'block'] }).notNull(),
    findingsJson: jsonb('findings_json').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('security_scans_version_idx').on(t.skillVersionId, t.createdAt)],
);

export const installEvents = pgTable('install_events', {
  id: uuid('id').primaryKey(),
  skillVersionId: uuid('skill_version_id')
    .notNull()
    .references(() => skillVersions.id),
  agent: text('agent'),
  action: text('action').notNull(),
  result: text('result').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const revocations = pgTable('revocations', {
  skillVersionId: uuid('skill_version_id')
    .primaryKey()
    .references(() => skillVersions.id),
  reason: text('reason').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const schema = {
  users,
  publishers,
  agents,
  skills,
  skillVersions,
  skillTargets,
  requirements,
  securityScans,
  installEvents,
  revocations,
};
