import { cookies, headers } from 'next/headers';
import { sessionCookieName, verifySession } from './auth';
import { isSameOriginStrict } from './http';
import { checkRateLimit, clientKeyFromHeaders, type RateGroup } from './rate-limit';

/**
 * Checks every server action runs first: the Origin header must be present and match the host
 * (Next.js also checks, but lets a missing Origin through), and the client must be under its
 * rate limit. Returns an error message, or null when the action may proceed.
 */
export async function guardAction(group: RateGroup): Promise<string | null> {
  const h = await headers();
  if (!isSameOriginStrict(h)) return 'This form must be submitted from the agenthub site.';
  const decision = checkRateLimit(group, clientKeyFromHeaders(h));
  if (!decision.ok) {
    return `Too many attempts. Try again in ${decision.retryAfterSeconds} seconds.`;
  }
  return null;
}

export async function hasAdminSession(): Promise<boolean> {
  const jar = await cookies();
  return verifySession(jar.get(sessionCookieName())?.value);
}
