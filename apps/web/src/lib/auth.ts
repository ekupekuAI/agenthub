import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { adminToken } from '../config';
import { ApiError } from './errors';
import { checkIdentityLimit, enforceAuthFailureLimit, enforceDecision } from './rate-limit';

// ---------------------------------------------------------------------------
// Publisher tokens
// ---------------------------------------------------------------------------

export const PUBLISHER_TOKEN_PREFIX = 'ahp_';
const PUBLISHER_TOKEN_RE = /^ahp_[A-Za-z0-9_-]{43}$/;

/** A new publisher token (32 random bytes, base64url). Shown once; only its hash is stored. */
export function generatePublisherToken(): string {
  return PUBLISHER_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function isWellFormedPublisherToken(token: string): boolean {
  return PUBLISHER_TOKEN_RE.test(token);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex SHA-256 hashes. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== 32 || bb.length !== 32) return false;
  return timingSafeEqual(ba, bb);
}

/** Constant-time check of a presented token against a stored hash. */
export function verifyToken(token: string, storedHash: string): boolean {
  return hashesEqual(hashToken(token), storedHash);
}

/** Extracts the token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer[ ]+([^\s]+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export function adminEnabled(): boolean {
  return adminToken() !== null;
}

/** Constant-time check of a presented admin token. False when admin is disabled. */
export function verifyAdminToken(presented: string | null | undefined): boolean {
  const expected = adminToken();
  if (!expected || !presented) return false;
  return hashesEqual(hashToken(presented), hashToken(expected));
}

/**
 * Throws 503 when admin is disabled, 401 when the bearer token is wrong (charged to the
 * client's failed-credential bucket, 429 once that is exhausted) and 429 when the admin
 * credential itself is over its rate limit.
 */
export function requireAdminBearer(request: Request): void {
  if (!adminEnabled()) throw new ApiError('UNAVAILABLE', 'Admin is disabled on this registry.');
  if (!verifyAdminToken(bearerToken(request.headers.get('authorization')))) {
    enforceAuthFailureLimit(request.headers);
    throw new ApiError('UNAUTHORIZED', 'A valid admin token is required.', {
      headers: { 'WWW-Authenticate': 'Bearer' },
    });
  }
  enforceDecision(checkIdentityLimit('admin', 'admin-token'));
}

// ---------------------------------------------------------------------------
// Admin UI sessions (HMAC-signed cookie)
// ---------------------------------------------------------------------------

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Session signing key. Always bound to the current admin token: rotating or removing
 * AGENTHUB_ADMIN_TOKEN invalidates every existing session, also when AGENTHUB_SESSION_SECRET
 * pins the key material. Null when admin is disabled.
 */
function sessionKey(): Buffer | null {
  const token = adminToken();
  if (!token) return null;
  const secret = process.env.AGENTHUB_SESSION_SECRET;
  const material = secret && secret.length >= 32 ? secret : token;
  return Buffer.from(
    hkdfSync(
      'sha256',
      material,
      'agenthub/admin-session',
      `session-signing-key/v2/${hashToken(token)}`,
      32,
    ),
  );
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
}

/** Signed session value `v1.<expiresMs>.<nonce>.<hmac>`. Null when admin is disabled. */
export function createSession(now = Date.now()): { value: string; expires: Date } | null {
  const key = sessionKey();
  if (!key) return null;
  const expires = now + SESSION_TTL_MS;
  const payload = `v1.${expires}.${randomBytes(16).toString('base64url')}`;
  return { value: `${payload}.${sign(payload, key)}`, expires: new Date(expires) };
}

/** The verified session's nonce and expiry, or null when the value is not a valid session. */
export function readSession(
  value: string | null | undefined,
  now = Date.now(),
): { nonce: string; expires: Date } | null {
  const key = sessionKey();
  if (!key || !value || value.length > 256) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [version, expiresRaw, nonce, signature] = parts as [string, string, string, string];
  const expected = Buffer.from(sign(`${version}.${expiresRaw}.${nonce}`, key), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const expires = Number(expiresRaw);
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + SESSION_TTL_MS) {
    return null;
  }
  return { nonce, expires: new Date(expires) };
}

/** Signature and expiry check only; server-side sign-out is checked by hasAdminSession(). */
export function verifySession(value: string | null | undefined, now = Date.now()): boolean {
  return readSession(value, now) !== null;
}

export function sessionCookieName(): string {
  // The __Host- prefix requires Secure, which needs HTTPS (production only).
  return process.env.NODE_ENV === 'production' ? '__Host-agenthub_admin' : 'agenthub_admin';
}

/**
 * Cookie attributes for the admin session. Clearing must repeat them: browsers ignore a
 * deletion of a __Host- cookie that lacks Secure and Path=/.
 */
export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires,
  };
}
