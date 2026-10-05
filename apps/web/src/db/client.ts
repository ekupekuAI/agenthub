import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { Pool } from '@neondatabase/serverless';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { databaseUrl, dataDir, onVercel } from '../config';
import { allMigrations, type MigrationClient, migrateSharedDatabase } from './migrate';
import { schema } from './schema';

/**
 * Two backends behind one Drizzle type:
 *
 * - PGlite (default): embedded Postgres in `<dataDir>/pglite`, zero configuration, one process.
 * - Hosted Postgres (DATABASE_URL set, e.g. Neon): `@neondatabase/serverless` Pool over
 *   WebSockets with drizzle-orm/neon-serverless. Interactive transactions work (publish and
 *   status changes rely on them), connections are short-lived and port 443 only, which suits
 *   serverless functions. The schema is migrated once per version under an advisory lock.
 *
 * Driver modules are imported lazily, so a deployment only loads the one it uses.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  /** Which backend this handle talks to. */
  kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

/** An embedded database handle; tests use `client` for raw SQL. */
export interface PgliteHandle extends DbHandle {
  kind: 'pglite';
  client: PGlite;
}

async function openPgliteClient(dir?: string): Promise<PGlite> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir) mkdirSync(dir, { recursive: true });
  const client = dir ? new PGlite(dir) : new PGlite();
  for (const step of allMigrations()) await client.exec(step.sql);
  return client;
}

async function wrapPglite(client: PGlite): Promise<PgliteHandle> {
  const { drizzle } = await import('drizzle-orm/pglite');
  return {
    db: drizzle({ client, schema }) as unknown as Db,
    kind: 'pglite',
    client,
    close: () => client.close(),
  };
}

/**
 * Open an embedded database and apply the idempotent migration.
 * `dir` omitted → in-memory (tests); otherwise a PGlite data directory on disk.
 */
export async function openDatabase(dir?: string): Promise<PgliteHandle> {
  return wrapPglite(await openPgliteClient(dir));
}

export interface PostgresOptions {
  /** Connections per process (default 5). */
  max?: number;
}

/** Connection string without credentials, for logs. */
export function describeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

/**
 * AGENTHUB_DB_WS_PROXY (local development only): route the Neon driver through a plain-ws
 * WebSocket-to-Postgres proxy such as Neon's local proxy, e.g. `localhost:5488/v2`. Disables
 * TLS on that hop, so it is ignored on Vercel.
 */
function configureLocalProxy(neonConfig: typeof import('@neondatabase/serverless').neonConfig) {
  const proxy = process.env.AGENTHUB_DB_WS_PROXY?.trim();
  if (!proxy) return;
  if (onVercel()) {
    console.warn('[agenthub] AGENTHUB_DB_WS_PROXY is ignored on Vercel.');
    return;
  }
  neonConfig.wsProxy = (host, port) => `${proxy}?address=${host}:${port}`;
  neonConfig.useSecureWebSocket = false;
  neonConfig.forceDisablePgSSL = true;
  neonConfig.pipelineConnect = false;
  neonConfig.pipelineTLS = false;
}

async function openPool(url: string, opts: PostgresOptions = {}): Promise<Pool> {
  const { Pool, neonConfig } = await import('@neondatabase/serverless');
  if (!neonConfig.webSocketConstructor && typeof globalThis.WebSocket !== 'function') {
    throw new Error('A hosted database needs Node.js 22 or newer (global WebSocket).');
  }
  configureLocalProxy(neonConfig);
  const pool = new Pool({
    connectionString: url,
    max: opts.max ?? 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
  });
  // An idle connection dropped by the server must not crash the process.
  pool.on('error', (error: Error) => {
    console.error('[agenthub] database connection error:', error.message);
  });
  try {
    await migrateSharedDatabase(() => pool.connect() as unknown as Promise<MigrationClient>);
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  return pool;
}

async function wrapPool(pool: Pool): Promise<DbHandle> {
  const { drizzle } = await import('drizzle-orm/neon-serverless');
  return {
    db: drizzle({ client: pool, schema }) as unknown as Db,
    kind: 'postgres',
    close: () => pool.end(),
  };
}

/** Open a hosted Postgres database (Neon) and apply the migration if needed. */
export async function openPostgresDatabase(
  url: string,
  opts: PostgresOptions = {},
): Promise<DbHandle> {
  return wrapPool(await openPool(url, opts));
}

type SharedClient = { kind: 'pglite'; client: PGlite } | { kind: 'postgres'; client: Pool };

// Only the client is process-wide: a PGlite data directory must have exactly one owner, and a
// pool should be shared. Next.js may load this module more than once (route handlers and pages
// are separate bundle layers), so each module instance wraps the shared client itself.
const globalForDb = globalThis as unknown as { __agenthubDbClient?: Promise<SharedClient> };
let local: { client: SharedClient; handle: DbHandle } | undefined;

async function openShared(): Promise<SharedClient> {
  const url = databaseUrl();
  if (url) return { kind: 'postgres', client: await openPool(url) };
  if (onVercel()) {
    throw new Error(
      'DATABASE_URL is not set. On Vercel the registry needs a hosted Postgres database ' +
        '(see docs/deploy-vercel.md); the embedded database cannot write there.',
    );
  }
  return { kind: 'pglite', client: await openPgliteClient(path.join(dataDir(), 'pglite')) };
}

/**
 * Process-wide database: hosted Postgres when DATABASE_URL is set, otherwise PGlite stored at
 * `<dataDir>/pglite`.
 */
export async function getDatabase(): Promise<DbHandle> {
  if (!globalForDb.__agenthubDbClient) {
    const opening = openShared();
    // Do not cache a failed open; the next request retries.
    opening.catch(() => {
      if (globalForDb.__agenthubDbClient === opening) globalForDb.__agenthubDbClient = undefined;
    });
    globalForDb.__agenthubDbClient = opening;
  }
  const shared = await globalForDb.__agenthubDbClient;
  if (local?.client !== shared) {
    const handle =
      shared.kind === 'pglite' ? await wrapPglite(shared.client) : await wrapPool(shared.client);
    const close = handle.close;
    handle.close = async () => {
      if (globalForDb.__agenthubDbClient && (await globalForDb.__agenthubDbClient) === shared) {
        globalForDb.__agenthubDbClient = undefined;
      }
      await close();
    };
    local = { client: shared, handle };
  }
  return local.handle;
}
