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
