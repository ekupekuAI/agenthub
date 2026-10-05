import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from '@neondatabase/serverless';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type DbHandle, getDatabase, openPostgresDatabase } from '../src/db/client';
import {
  allMigrations,
  MIGRATION_ID,
  type MigrationClient,
  migrateSharedDatabase,
} from '../src/db/migrate';
import { publishers } from '../src/db/schema';
import { ApiError } from '../src/lib/errors';
import { createArtifactStore, Registry } from '../src/lib/registry';
import { LocalFsStore } from '../src/storage';
import { VercelBlobStore } from '../src/storage-blob';
import { DOWNLOAD_EXEC_SCRIPT, packTestSkill } from './helpers';
import { type FakeNeon, startFakeNeon } from './pg-wire';

/**
 * The hosted-database path (DATABASE_URL → @neondatabase/serverless Pool +
 * drizzle-orm/neon-serverless) against PGlite served over the Postgres wire protocol.
 */
let neon: FakeNeon;
let root: string;
const handles: DbHandle[] = [];

async function open(max = 3): Promise<DbHandle> {
  const handle = await openPostgresDatabase(neon.url, { max });
  handles.push(handle);
  return handle;
}

beforeAll(async () => {
  neon = await startFakeNeon();
  root = await mkdtemp(path.join(tmpdir(), 'agenthub-pg-'));
}, 60_000);

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close().catch(() => {})));
  await neon?.close();
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}

describe('hosted Postgres (Neon driver)', () => {
  it('migrates exactly once when several instances cold-start at the same time', async () => {
    const opened = await Promise.all([open(), open(), open(), open()]);
    expect(opened.every((h) => h.kind === 'postgres')).toBe(true);
    const applied = await neon.pglite.query<{ id: string }>('SELECT id FROM agenthub_migrations');
    // MIGRATION_SQL plus each separately versioned step, recorded exactly once.
    expect(applied.rows.map((r) => r.id).sort()).toEqual(
      allMigrations()
        .map((step) => step.id)
        .sort(),
    );
    expect(applied.rows.map((r) => r.id)).toContain(MIGRATION_ID);
    const tables = await neon.pglite.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('skills', 'skill_versions', 'publishers', 'install_counts')",
    );
    expect(tables.rows[0]?.n).toBe(4);
    const agents = await neon.pglite.query<{ n: number }>('SELECT count(*)::int AS n FROM agents');
    expect(agents.rows[0]?.n).toBe(4);
  });

  it('skips the migration once its version is recorded', async () => {
    const pool = new Pool({ connectionString: neon.url, max: 1 });
    pool.on('error', () => {});
    try {
      const result = await migrateSharedDatabase(
        () => pool.connect() as unknown as Promise<MigrationClient>,
      );
      expect(result).toBe('current');
    } finally {
      await pool.end();
    }
  });

  it('rolls back a failed transaction', async () => {
    const { db } = await open();
    const error = await rejection(
      db.transaction(async (tx) => {
        await tx.insert(publishers).values({
          id: '00000000-0000-4000-8000-000000000001',
          displayName: 'rolled-back',
          tokenHash: 'x'.repeat(64),
        });
        throw new Error('abort');
      }),
    );
    expect((error as Error).message).toBe('abort');
    const rows = await neon.pglite.query(
      "SELECT 1 FROM publishers WHERE display_name = 'rolled-back'",
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('publishes, quarantines, moderates and downloads through the registry', async () => {
    const { db } = await open();
    const registry = new Registry({ db, store: new LocalFsStore(path.join(root, 'artifacts')) });
    const alice = await registry.createPublisher('pg-alice', true);
    expect((await registry.authenticatePublisher(alice.token))?.id).toBe(alice.id);

    const clean = await registry.publish(await packTestSkill(root, 'pg-clean'), alice.id);
    expect(clean.status).toBe('active');

    // Two publishes of one version race: the transaction plus the unique constraint let
    // exactly one through, and the loser gets a clean CONFLICT.
    const v2 = await packTestSkill(root, 'pg-clean', { version: '2.0.0' });
    const raced = await Promise.allSettled([
      registry.publish(v2, alice.id),
      registry.publish(v2, alice.id),
    ]);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = raced.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ApiError);
    expect((lost.reason as ApiError).code).toBe('CONFLICT');

    const bad = await registry.publish(
      await packTestSkill(root, 'pg-bad', { files: { 'go.sh': DOWNLOAD_EXEC_SCRIPT } }),
      alice.id,
    );
    expect(bad.status).toBe('quarantined');
    expect(bad.outcome).toBe('block');
    expect(((await rejection(registry.download('pg-bad', '1.0.0'))) as ApiError).code).toBe(
      'FORBIDDEN',
    );

    const info = await registry.getSkillInfo('pg-clean');
    expect(info.latest?.version).toBe('2.0.0');
    expect(info.latest?.agents).toEqual(['claude-code', 'codex', 'cursor', 'vscode']);
    const found = await registry.search({ q: 'pg-clean' });
    expect(found.map((r) => r.slug)).toContain('pg-clean');

    const pkg = await registry.download('pg-clean', '2.0.0', { agent: 'codex' });
    expect(pkg.bytes.byteLength).toBe(v2.byteLength);
    const counts = await registry.downloadCounts('pg-clean', '2.0.0');
    expect(counts).toEqual([
      { day: new Date().toISOString().slice(0, 10), agent: 'codex', count: 1 },
    ]);

    await registry.setStatus('pg-bad', '1.0.0', 'active', 'Reviewed by hand.');
    await registry.revoke('pg-clean', '1.0.0', 'Superseded and unsafe.');
    const after = await rejection(registry.setStatus('pg-clean', '1.0.0', 'active', 'Undo it.'));
    expect((after as ApiError).code).toBe('CONFLICT');
    const versions = await registry.listVersions('pg-clean');
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      ['2.0.0', 'active'],
      ['1.0.0', 'revoked'],
    ]);
  }, 60_000);
});

describe('backend selection', () => {
  it('uses the hosted database when DATABASE_URL is set', async () => {
    vi.stubEnv('DATABASE_URL', neon.url);
    vi.stubEnv('AGENTHUB_DB_WS_PROXY', neon.wsProxy);
    const handle = await getDatabase();
    try {
      expect(handle.kind).toBe('postgres');
    } finally {
      await handle.close();
    }
  });

  it('refuses the embedded database on Vercel', async () => {
    vi.stubEnv('DATABASE_URL', '');
    vi.stubEnv('VERCEL', '1');
    const error = await rejection(getDatabase());
    expect((error as Error).message).toMatch(/DATABASE_URL is not set/);
  });

  it('picks Vercel Blob only with a token, and refuses the local folder on Vercel', () => {
    vi.stubEnv('AGENTHUB_DATA_DIR', root);
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
    vi.stubEnv('VERCEL', '');
    expect(createArtifactStore()).toBeInstanceOf(LocalFsStore);
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_test_token');
    expect(createArtifactStore()).toBeInstanceOf(VercelBlobStore);
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
    vi.stubEnv('VERCEL', '1');
    expect(() => createArtifactStore()).toThrow(/BLOB_READ_WRITE_TOKEN is not set/);
  });
});
