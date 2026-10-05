import { cookies, headers } from 'next/headers';
import { adminEnabled, readSession, sessionCookieName } from './auth';
import { isSameOriginStrict } from './http';
import {
  checkClientLimit,
  checkIdentityLimit,
  type RateDecision,
  type RateGroup,
} from './rate-limit';
import { getRegistry } from './registry';

function tooMany(decision: RateDecision): string | null {
  return decision.ok
    ? null
    : `Too many attempts. Try again in ${decision.retryAfterSeconds} seconds.`;
}

/**
 * Check every server action runs first: the Origin header must be present and match the host
 * (Next.js also checks, but lets a missing Origin through). Returns an error message, or null
 * when the action may proceed. Rate limits are charged after the credential check, see
 * limitFailedAttempt and limitIdentity.
 */
export async function guardOrigin(): Promise<string | null> {
  const h = await headers();
  if (!isSameOriginStrict(h)) return 'This form must be submitted from the agenthub site.';
  return null;
}

/**
 * Origin check plus one charge to the client's anonymous bucket of `group`. In direct mode
 * (no trusted proxy) that bucket is shared by every client, see rate-limit.ts.
 */
export async function guardAction(group: RateGroup): Promise<string | null> {
  const blocked = await guardOrigin();
  if (blocked) return blocked;
  return tooMany(checkClientLimit(group, await headers()));
}

/** Record a failed credential; returns a message once the client made too many. */
export async function limitFailedAttempt(): Promise<string | null> {
  return tooMany(checkClientLimit('auth', await headers()));
}

/** Charge one request to an authenticated identity's bucket. */
export function limitIdentity(group: RateGroup, identity: string): string | null {
  return tooMany(checkIdentityLimit(group, identity));
}

/**
 * The current admin session: admin enabled, cookie signed with the current admin token, not
 * expired and not signed out. Null otherwise.
 */
export async function currentAdminSession(): Promise<{ nonce: string; expires: Date } | null> {
  if (!adminEnabled()) return null;
  const jar = await cookies();
  const session = readSession(jar.get(sessionCookieName())?.value);
  if (!session) return null;
  const registry = await getRegistry();
  if (await registry.isAdminSessionRevoked(session.nonce)) return null;
  return session;
}

export async function hasAdminSession(): Promise<boolean> {
  return (await currentAdminSession()) !== null;
}
