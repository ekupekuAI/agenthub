import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { dataDir } from '../config';
import { MIGRATION_SQL } from './migrate';
import { schema } from './schema';

export type Db = PgliteDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  client: PGlite;
  close(): Promise<void>;
}

async function openClient(dir?: string): Promise<PGlite> {
  if (dir) mkdirSync(dir, { recursive: true });
  const client = dir ? new PGlite(dir) : new PGlite();
  await client.exec(MIGRATION_SQL);
  return client;
}

function wrap(client: PGlite): DbHandle {
  return { db: drizzle({ client, schema }), client, close: () => client.close() };
}

/**
 * Open a database and apply the idempotent migration.
 * `dir` omitted → in-memory (tests); otherwise a PGlite data directory on disk.
 */
export async function openDatabase(dir?: string): Promise<DbHandle> {
  return wrap(await openClient(dir));
}

// Only the PGlite client is process-wide: one data directory must have exactly one owner.
// Next.js may load this module more than once (route handlers and pages are separate bundle
// layers), so each module instance wraps the shared client with its own Drizzle instance.
const globalForDb = globalThis as unknown as { __agenthubPglite?: Promise<PGlite> };
let local: { client: PGlite; handle: DbHandle } | undefined;

/** Process-wide database stored at `<dataDir>/pglite`. */
export async function getDatabase(): Promise<DbHandle> {
  if (!globalForDb.__agenthubPglite) {
    const opening = openClient(path.join(dataDir(), 'pglite'));
    // Do not cache a failed open; the next request retries.
    opening.catch(() => {
      if (globalForDb.__agenthubPglite === opening) globalForDb.__agenthubPglite = undefined;
    });
    globalForDb.__agenthubPglite = opening;
  }
  const client = await globalForDb.__agenthubPglite;
  if (local?.client !== client) local = { client, handle: wrap(client) };
  return local.handle;
}
