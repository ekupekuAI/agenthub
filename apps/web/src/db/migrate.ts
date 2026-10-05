import { createHash } from 'node:crypto';

/**
 * Idempotent schema migration, applied on first use. Mirrors ./schema.ts.
 * Every statement is safe to run again on an existing database.
 */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'publisher' CHECK (role IN ('publisher', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS publishers (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  display_name text NOT NULL UNIQUE,
  token_hash text NOT NULL UNIQUE,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  detector_version text NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  summary text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  tags text NOT NULL DEFAULT '',
  publisher_id uuid NOT NULL REFERENCES publishers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id uuid PRIMARY KEY,
  skill_id uuid NOT NULL REFERENCES skills(id),
  version text NOT NULL,
  digest text NOT NULL,
  archive_digest text NOT NULL,
  storage_key text NOT NULL,
  size_bytes integer NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'quarantined', 'revoked')),
  status_reason text,
  channel text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta')),
  manifest_json jsonb,
  frontmatter_json jsonb NOT NULL,
  readme text NOT NULL,
  files_json jsonb NOT NULL,
  release_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT skill_versions_skill_version_unique UNIQUE (skill_id, version)
);
CREATE INDEX IF NOT EXISTS skill_versions_status_idx ON skill_versions (status);

CREATE TABLE IF NOT EXISTS skill_targets (
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id),
  agent_id text NOT NULL REFERENCES agents(id),
  mode text NOT NULL DEFAULT 'native',
  min_version text,
  max_version text,
  PRIMARY KEY (skill_version_id, agent_id)
);
CREATE INDEX IF NOT EXISTS skill_targets_agent_idx ON skill_targets (agent_id);

CREATE TABLE IF NOT EXISTS requirements (
  id serial PRIMARY KEY,
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id),
  kind text NOT NULL CHECK (kind IN ('runtime', 'command', 'mcp')),
  name text NOT NULL,
  "constraint" text
);
CREATE INDEX IF NOT EXISTS requirements_version_idx ON requirements (skill_version_id);

CREATE TABLE IF NOT EXISTS security_scans (
  id uuid PRIMARY KEY,
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id),
  scanner_version text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allow', 'confirm', 'block')),
  findings_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_scans_version_idx ON security_scans (skill_version_id, created_at);

CREATE TABLE IF NOT EXISTS install_events (
  id uuid PRIMARY KEY,
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id),
  agent text,
  action text NOT NULL,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS revocations (
  skill_version_id uuid PRIMARY KEY REFERENCES skill_versions(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Hardening (additive; safe to run again on an existing database).
ALTER TABLE publishers ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS findings_total integer;
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS block_count integer;
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS warn_count integer;
ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS info_count integer;

CREATE INDEX IF NOT EXISTS skill_versions_skill_idx ON skill_versions (skill_id);
CREATE INDEX IF NOT EXISTS skill_versions_digest_idx ON skill_versions (digest);
CREATE INDEX IF NOT EXISTS skill_versions_created_idx ON skill_versions (created_at);

-- Download counters: one row per version, agent and day (install_events is no longer written).
CREATE TABLE IF NOT EXISTS install_counts (
  skill_version_id uuid NOT NULL REFERENCES skill_versions(id),
  agent text NOT NULL DEFAULT '',
  day date NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (skill_version_id, agent, day)
);

-- Admin sessions signed out before they expire.
CREATE TABLE IF NOT EXISTS admin_session_revocations (
  nonce text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

INSERT INTO agents (id, display_name, detector_version) VALUES
  ('claude-code', 'Claude Code', '1'),
  ('codex', 'Codex', '1'),
  ('cursor', 'Cursor', '1'),
  ('vscode', 'VS Code / Copilot', '1')
ON CONFLICT (id) DO NOTHING;
`;

/** Identifies this version of MIGRATION_SQL in the `agenthub_migrations` table. */
export const MIGRATION_ID = `schema-${createHash('sha256').update(MIGRATION_SQL).digest('hex').slice(0, 16)}`;

/** Advisory lock key serializing migrations across processes ("agenthub" in ASCII). */
export const MIGRATION_LOCK_KEY = 0x61676e74;

/** The slice of a node-postgres compatible client the migration needs. */
export interface MigrationClient {
  query(text: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
  release(): void;
}

function pgCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/**
 * Apply MIGRATION_SQL to a shared Postgres database, once per schema version, safely under
 * concurrent cold starts: the work runs in one transaction holding a transaction-scoped
 * advisory lock (compatible with PgBouncer transaction pooling), and the applied version is
 * recorded in `agenthub_migrations`. A process that finds its version recorded skips all of
 * it without taking the lock. Every statement is idempotent anyway, so a partial history or a
 * concurrent older deployment cannot break it.
 */
export async function migrateSharedDatabase(
  connect: () => Promise<MigrationClient>,
): Promise<'applied' | 'current'> {
  const client = await connect();
  try {
    try {
      const done = await client.query('SELECT 1 FROM agenthub_migrations WHERE id = $1', [
        MIGRATION_ID,
      ]);
      if (done.rowCount) return 'current';
    } catch (error) {
      // 42P01: the table does not exist yet (first start).
      if (pgCode(error) !== '42P01') throw error;
    }
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS agenthub_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const done = await client.query('SELECT 1 FROM agenthub_migrations WHERE id = $1', [
        MIGRATION_ID,
      ]);
      if (done.rowCount) {
        await client.query('COMMIT');
        return 'current';
      }
      await client.query(MIGRATION_SQL);
      await client.query(
        'INSERT INTO agenthub_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [MIGRATION_ID],
      );
      await client.query('COMMIT');
      return 'applied';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}
