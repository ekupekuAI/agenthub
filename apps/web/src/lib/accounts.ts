/**
 * Publisher accounts: GitHub sign-in, named publisher tokens and sign-in nonces.
 * Server-only. Accounts are matched on the numeric GitHub user id only: a login can be renamed
 * and later claimed by someone else, so it is stored for display and never used to find an
 * account.
 */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import { type DbHandle, getDatabase } from '../db/client';
import { authNonces, publishers, publisherTokens } from '../db/schema';
import { generatePublisherToken, hashesEqual, hashToken, isWellFormedPublisherToken } from './auth';
import { ApiError } from './errors';
import { cleanText } from './text';

type Db = DbHandle['db'];
/** A database or an open transaction on it. */
type Executor = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;
export type PublisherRow = typeof publishers.$inferSelect;

/** Active tokens one publisher may hold at a time. */
export const MAX_ACTIVE_TOKENS = 20;
/** last_used_at is written at most this often per token (it is shown at minute precision). */
const LAST_USED_GRANULARITY_MS = 60_000;

export const TOKEN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/;

export interface TokenSummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

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

/** Validates a token name; throws VALIDATION with a readable message. */
export function cleanTokenName(raw: unknown): string {
  const name = typeof raw === 'string' ? cleanText(raw, { singleLine: true }).trim() : '';
  if (!TOKEN_NAME_RE.test(name)) {
    throw new ApiError(
      'VALIDATION',
      'Name the token with 1 to 48 letters, digits, spaces, dots, dashes or underscores.',
    );
  }
  return name;
}

/** Store a new token for a publisher and return it. The token is shown once; only its hash stays. */
export async function insertPublisherToken(
  db: Executor,
  publisherId: string,
  name: string,
  now: Date,
): Promise<{ id: string; name: string; token: string; createdAt: Date }> {
  const token = generatePublisherToken();
  const id = randomUUID();
  await db.insert(publisherTokens).values({
    id,
    publisherId,
    name,
    tokenHash: hashToken(token),
    createdAt: now,
  });
  return { id, name, token, createdAt: now };
}

/** Revoke every active token of a publisher (an administrator rotated its credentials). */
export async function revokeAllPublisherTokens(
  db: Executor,
  publisherId: string,
  now: Date,
): Promise<void> {
  await db
    .update(publisherTokens)
    .set({ revokedAt: now })
    .where(and(eq(publisherTokens.publisherId, publisherId), isNull(publisherTokens.revokedAt)));
}

/**
 * Publisher for a presented token, or null (unknown, revoked, or the publisher is suspended).
 * Hash lookup plus constant-time confirmation.
 *
 * Tokens live in publisher_tokens. A token that exists only as publishers.token_hash (issued
 * by an older deployment of the registry) is accepted once and copied in, unless
 * publisher_tokens already knows that hash: a revoked token never comes back this way.
 */
export async function authenticatePublisherToken(
  db: Db,
  token: string | null | undefined,
  now: Date,
): Promise<PublisherRow | null> {
  if (!token || !isWellFormedPublisherToken(token)) return null;
  const presented = hashToken(token);
  const rows = await db
    .select({ token: publisherTokens, publisher: publishers })
    .from(publisherTokens)
    .innerJoin(publishers, eq(publishers.id, publisherTokens.publisherId))
    .where(eq(publisherTokens.tokenHash, presented))
    .limit(1);
  const found = rows[0];
  if (found) {
    if (!hashesEqual(presented, found.token.tokenHash)) return null;
    if (found.token.revokedAt !== null || found.publisher.disabledAt !== null) return null;
    const last = found.token.lastUsedAt?.getTime() ?? 0;
    if (now.getTime() - last >= LAST_USED_GRANULARITY_MS) {
      await db
        .update(publisherTokens)
        .set({ lastUsedAt: now })
        .where(eq(publisherTokens.id, found.token.id));
    }
    return found.publisher;
  }

  const legacy = await db
    .select()
    .from(publishers)
    .where(eq(publishers.tokenHash, presented))
    .limit(1);
  const row = legacy[0];
  if (!row?.tokenHash || !hashesEqual(presented, row.tokenHash)) return null;
  if (row.disabledAt !== null) return null;
  await db
    .insert(publisherTokens)
    .values({
      id: randomUUID(),
      publisherId: row.id,
      name: 'default',
      tokenHash: presented,
      createdAt: row.createdAt,
      lastUsedAt: now,
    })
    .onConflictDoNothing();
  return row;
}

/** Display names that GitHub sign-up never assigns (they read as the registry itself). */
const RESERVED_NAMES = new Set(['admin', 'administrator', 'agenthub', 'official', 'registry']);

export class Accounts {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(deps: { db: Db; now?: () => Date }) {
    this.db = deps.db;
    this.now = deps.now ?? (() => new Date());
  }

  async findPublisherById(id: string): Promise<PublisherRow | null> {
    const rows = await this.db.select().from(publishers).where(eq(publishers.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** A display name based on the login that no publisher uses yet (compared case-insensitively). */
  private async pickDisplayName(login: string, attempt: number): Promise<string> {
    const base = login.length >= 2 ? login : `${login}-gh`;
    const candidates =
      attempt === 0
        ? [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)]
        : [`${base}-${randomUUID().slice(0, 6)}`];
    for (const candidate of candidates) {
      if (RESERVED_NAMES.has(candidate.toLowerCase())) continue;
      const taken = await this.db
        .select({ id: publishers.id })
        .from(publishers)
        .where(sql`lower(${publishers.displayName}) = ${candidate.toLowerCase()}`)
        .limit(1);
      if (taken.length === 0) return candidate;
    }
    return `${base}-${randomUUID().slice(0, 6)}`;
  }

  /**
   * The publisher linked to this GitHub account, created on first sign-in as an unverified
   * publisher named after the login (with a suffix when that name is taken). Matching uses
   * the numeric id only; the stored login is refreshed on every sign-in.
   */
  async signInWithGitHub(user: {
    id: number;
    login: string;
  }): Promise<{ publisher: PublisherRow; created: boolean }> {
    if (!Number.isSafeInteger(user.id) || user.id <= 0) {
      throw new ApiError('VALIDATION', 'Invalid GitHub account.');
    }
    const now = this.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await this.db
        .select()
        .from(publishers)
        .where(eq(publishers.githubUserId, user.id))
        .limit(1);
      const row = existing[0];
      if (row) {
        const updated = await this.db
          .update(publishers)
          .set({ githubLogin: user.login, lastLoginAt: now })
          .where(eq(publishers.id, row.id))
          .returning();
        return { publisher: updated[0] ?? row, created: false };
      }
      const displayName = await this.pickDisplayName(user.login, attempt);
      try {
        const inserted = await this.db
          .insert(publishers)
          .values({
            id: randomUUID(),
            displayName,
            tokenHash: null,
            verifiedAt: null,
            githubUserId: user.id,
            githubLogin: user.login,
            lastLoginAt: now,
            createdAt: now,
          })
          .returning();
        const publisher = inserted[0];
        if (!publisher) throw new Error('insert returned no row');
        return { publisher, created: true };
      } catch (error) {
        // A concurrent first sign-in of the same account, or a name taken in the meantime:
        // look again (the next round finds the account, or picks another name).
        if (uniqueViolation(error) === null) throw error;
      }
    }
    throw new ApiError('CONFLICT', 'Could not create the publisher account. Try again.');
  }

  async listTokens(publisherId: string): Promise<TokenSummary[]> {
    const rows = await this.db
      .select({
        id: publisherTokens.id,
        name: publisherTokens.name,
        createdAt: publisherTokens.createdAt,
        lastUsedAt: publisherTokens.lastUsedAt,
      })
      .from(publisherTokens)
      .where(and(eq(publisherTokens.publisherId, publisherId), isNull(publisherTokens.revokedAt)))
      .orderBy(asc(publisherTokens.createdAt), asc(publisherTokens.id));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    }));
  }

  /** Create a named token. Returned once; only its hash is stored. */
  async createToken(
    publisherId: string,
    rawName: unknown,
  ): Promise<{ id: string; name: string; token: string; createdAt: string }> {
    const name = cleanTokenName(rawName);
    const active = await this.listTokens(publisherId);
    if (active.length >= MAX_ACTIVE_TOKENS) {
      throw new ApiError(
        'CONFLICT',
        `You can have at most ${MAX_ACTIVE_TOKENS} tokens. Revoke one you no longer use first.`,
      );
    }
    const created = await insertPublisherToken(this.db, publisherId, name, this.now());
    return { ...created, createdAt: created.createdAt.toISOString() };
  }

  /** Revoke one of the publisher's own tokens. False when it is not theirs or already revoked. */
  async revokeToken(publisherId: string, tokenId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/.test(tokenId)) return false;
    const revoked = await this.db
      .update(publisherTokens)
      .set({ revokedAt: this.now() })
      .where(
        and(
          eq(publisherTokens.id, tokenId),
          eq(publisherTokens.publisherId, publisherId),
          isNull(publisherTokens.revokedAt),
        ),
      )
      .returning({ tokenHash: publisherTokens.tokenHash });
    const hash = revoked[0]?.tokenHash;
    if (!hash) return false;
    // The admin-issued copy of the same token must not keep working through the legacy column.
    await this.db
      .update(publishers)
      .set({ tokenHash: null })
      .where(and(eq(publishers.id, publisherId), eq(publishers.tokenHash, hash)));
    return true;
  }

  // -------------------------------------------------------------------------
  // Nonces: signed-out sessions and consumed OAuth states
  // -------------------------------------------------------------------------

  private async prune(): Promise<void> {
    await this.db.delete(authNonces).where(lt(authNonces.expiresAt, this.now()));
  }

  async revokeSession(nonce: string, expiresAt: Date): Promise<void> {
    await this.prune();
    await this.db
      .insert(authNonces)
      .values({ nonce: `session:${nonce}`, expiresAt })
      .onConflictDoNothing();
  }

  async isSessionRevoked(nonce: string): Promise<boolean> {
    const rows = await this.db
      .select({ nonce: authNonces.nonce })
      .from(authNonces)
      .where(eq(authNonces.nonce, `session:${nonce}`))
      .limit(1);
    return rows.length > 0;
  }

  /** Mark an OAuth state as used. True only the first time: a replayed state is refused. */
  async consumeOAuthState(state: string, expiresAt: Date): Promise<boolean> {
    await this.prune();
    const key = `oauth:${createHash('sha256').update(state, 'utf8').digest('base64url')}`;
    const inserted = await this.db
      .insert(authNonces)
      .values({ nonce: key, expiresAt })
      .onConflictDoNothing()
      .returning({ nonce: authNonces.nonce });
    return inserted.length === 1;
  }
}

let cached: { db: Db; accounts: Accounts } | undefined;

/** Accounts on the process-wide database (see db/client.ts). */
export async function getAccounts(): Promise<Accounts> {
  const { db } = await getDatabase();
  if (cached?.db !== db) cached = { db, accounts: new Accounts({ db }) };
  return cached.accounts;
}
