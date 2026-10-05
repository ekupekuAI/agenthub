import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { githubOAuth } from '../config';

/*
 * Publisher sign-in state, kept in two HMAC-signed HttpOnly cookies:
 *
 * - the session cookie (7 days): `s1.<publisherId>.<expiresMs>.<nonce>.<hmac>`. Signing out
 *   records the nonce server-side (auth_nonces), so a copied cookie stops working.
 * - the OAuth cookie (10 minutes, one sign-in attempt):
 *   `o1.<expiresMs>.<state>.<pkceVerifier>.<next>.<hmac>`. The callback compares the state
 *   GitHub returns with this one and consumes it server-side, so each state works once.
 *
 * Both are SameSite=Lax (the OAuth callback is a top-level navigation from github.com),
 * HttpOnly, and in production Secure with the __Host- prefix. Keys are derived with HKDF from
 * AGENTHUB_SESSION_SECRET (when at least 32 characters) or the GitHub client secret, with a
 * label per purpose, so they never equal the admin session key. Publisher sessions exist only
 * while GitHub sign-in is configured.
 */

export const PUBLISHER_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Where a successful sign-in lands. Fixed paths only: never taken from a URL. */
export const SIGN_IN_TARGETS = { dashboard: '/dashboard', publish: '/publish' } as const;
export type SignInTarget = keyof typeof SIGN_IN_TARGETS;

export function parseSignInTarget(value: string | null | undefined): SignInTarget {
  return value === 'publish' ? 'publish' : 'dashboard';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;

type Purpose = 'session' | 'oauth-state';

function keyFor(purpose: Purpose): Buffer | null {
  const oauth = githubOAuth();
  if (!oauth) return null;
  const secret = process.env.AGENTHUB_SESSION_SECRET;
  const material = secret && secret.length >= 32 ? secret : oauth.clientSecret;
  return Buffer.from(hkdfSync('sha256', material, 'agenthub/publisher-auth', `${purpose}/v1`, 32));
}

function sign(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
}

/** Constant-time check of `<payload>.<signature>`; returns the payload parts or null. */
function verified(value: string, key: Buffer, parts: number): string[] | null {
  const split = value.split('.');
  if (split.length !== parts) return null;
  const signature = split[parts - 1] as string;
  const payload = split.slice(0, -1).join('.');
  const expected = Buffer.from(sign(payload, key), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return split.slice(0, -1);
}

function validExpiry(raw: string, now: number, ttl: number): number | null {
  if (!/^\d{1,16}$/.test(raw)) return null;
  const expires = Number(raw);
  if (!Number.isSafeInteger(expires) || expires <= now || expires > now + ttl) return null;
  return expires;
}

/** Constant-time string equality (for values of public length, such as the OAuth state). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface PublisherSession {
  publisherId: string;
  nonce: string;
  expires: Date;
}

/** A new signed session for the publisher, or null when GitHub sign-in is not configured. */
export function createPublisherSession(
  publisherId: string,
  now = Date.now(),
): { value: string; expires: Date; nonce: string } | null {
  const key = keyFor('session');
  if (!key || !UUID_RE.test(publisherId)) return null;
  const expires = now + PUBLISHER_SESSION_TTL_MS;
  const nonce = randomBytes(16).toString('base64url');
  const payload = `s1.${publisherId}.${expires}.${nonce}`;
  return { value: `${payload}.${sign(payload, key)}`, expires: new Date(expires), nonce };
}

/** The verified session, or null (bad signature, expired, malformed or sign-in disabled). */
export function readPublisherSession(
  value: string | null | undefined,
  now = Date.now(),
): PublisherSession | null {
  const key = keyFor('session');
  if (!key || !value || value.length > 256) return null;
  const parts = verified(value, key, 5);
  if (!parts) return null;
  const [version, publisherId, expiresRaw, nonce] = parts as [string, string, string, string];
  if (version !== 's1' || !UUID_RE.test(publisherId) || !NONCE_RE.test(nonce)) return null;
  const expires = validExpiry(expiresRaw, now, PUBLISHER_SESSION_TTL_MS);
  if (expires === null) return null;
  return { publisherId, nonce, expires: new Date(expires) };
}

export function publisherSessionCookieName(): string {
  // The __Host- prefix requires Secure, which needs HTTPS (production only).
  return process.env.NODE_ENV === 'production' ? '__Host-agenthub_session' : 'agenthub_session';
}

/**
 * Attributes of both sign-in cookies. Lax, not Strict: the browser must send the cookies on
 * the top-level redirect back from github.com. Clearing must repeat them (a __Host- cookie is
 * only deleted with Secure and Path=/).
 */
export function signInCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires,
  };
}

// ---------------------------------------------------------------------------
// OAuth state (one sign-in attempt)
// ---------------------------------------------------------------------------

export interface OAuthAttempt {
  state: string;
  verifier: string;
  next: SignInTarget;
  expires: Date;
}

export function oauthCookieName(): string {
  return process.env.NODE_ENV === 'production' ? '__Host-agenthub_oauth' : 'agenthub_oauth';
}

/** S256 PKCE challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A fresh state and PKCE verifier, signed into the cookie value. Null when not configured. */
export function createOAuthAttempt(
  next: SignInTarget,
  now = Date.now(),
): { value: string; attempt: OAuthAttempt } | null {
  const key = keyFor('oauth-state');
  if (!key) return null;
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const expires = now + OAUTH_STATE_TTL_MS;
  const payload = `o1.${expires}.${state}.${verifier}.${next}`;
  return {
    value: `${payload}.${sign(payload, key)}`,
    attempt: { state, verifier, next, expires: new Date(expires) },
  };
}

export function readOAuthAttempt(
  value: string | null | undefined,
  now = Date.now(),
): OAuthAttempt | null {
  const key = keyFor('oauth-state');
  if (!key || !value || value.length > 256) return null;
  const parts = verified(value, key, 6);
  if (!parts) return null;
  const [version, expiresRaw, state, verifier, next] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== 'o1' || !B64URL_43.test(state) || !B64URL_43.test(verifier)) return null;
  if (next !== 'dashboard' && next !== 'publish') return null;
  const expires = validExpiry(expiresRaw, now, OAUTH_STATE_TTL_MS);
  if (expires === null) return null;
  return { state, verifier, next, expires: new Date(expires) };
}

// ---------------------------------------------------------------------------
// Cookies on plain Request / Response objects (route handlers)
// ---------------------------------------------------------------------------

/** The value of one cookie from a Cookie header, or null. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** A Set-Cookie header value. Values here are base64url and dots only, so no escaping. */
export function serializeCookie(
  name: string,
  value: string,
  options: ReturnType<typeof signInCookieOptions> & { maxAge?: number },
): string {
  const parts = [`${name}=${value}`, `Path=${options.path}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite === 'lax' ? 'Lax' : 'Strict'}`);
  return parts.join('; ');
}

/** Set-Cookie value that deletes a sign-in cookie. */
export function clearCookie(name: string): string {
  return serializeCookie(name, '', { ...signInCookieOptions(new Date(0)), maxAge: 0 });
}
