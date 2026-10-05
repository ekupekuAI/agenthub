import { isIP } from 'node:net';
import { trustedProxyHops } from '../config';
import { ApiError } from './errors';

/**
 * Rate limiting.
 *
 * Who is the client? Next.js route handlers and server actions do not expose the socket
 * address, and Next.js keeps any X-Forwarded-For header the client sent (it only fills the
 * header when it is absent), so that header cannot identify anyone unless a trusted proxy
 * wrote it. Therefore:
 *
 * - AGENTHUB_TRUST_PROXY=N (N trusted proxies that append to X-Forwarded-For, usually 1):
 *   the client is the hop the outermost trusted proxy appended, i.e. the N-th entry from the
 *   right. Entries further left are client-supplied and ignored. IPv6 clients are grouped by
 *   /64. Buckets are per client.
 * - Otherwise (direct mode): there is no trustworthy client identity, so anonymous traffic of
 *   each group shares ONE bucket with a higher limit (SHARED_RATE_LIMITS). It caps total load
 *   but cannot single out one abuser; put the registry behind a proxy and set
 *   AGENTHUB_TRUST_PROXY for per-client limits.
 *
 * Authenticated work (publish, admin moderation) is limited per credential instead
 * ('identity' buckets), checked only after the credential verified, so nobody can exhaust a
 * publisher's or the administrator's quota without holding the credential. Failed credential
 * attempts are limited in the 'auth' group (per client, or shared in direct mode).
 */
export type RateGroup = 'publish' | 'admin' | 'read' | 'page' | 'auth';

export interface RateLimit {
  limit: number;
  windowMs: number;
}

/** Limits per client (trusted-proxy mode) and per authenticated identity. */
export const RATE_LIMITS: Record<RateGroup, RateLimit> = {
  publish: { limit: 10, windowMs: 60_000 },
  admin: { limit: 30, windowMs: 60_000 },
  read: { limit: 120, windowMs: 60_000 },
  page: { limit: 300, windowMs: 60_000 },
  auth: { limit: 20, windowMs: 60_000 },
};

/** Limits of the single shared bucket per group in direct mode (no trusted proxy). */
export const SHARED_RATE_LIMITS: Record<RateGroup, RateLimit> = {
  publish: { limit: 30, windowMs: 60_000 },
  admin: { limit: 60, windowMs: 60_000 },
  read: { limit: 1200, windowMs: 60_000 },
  page: { limit: 1200, windowMs: 60_000 },
  auth: { limit: 60, windowMs: 60_000 },
};

/** Key of the shared bucket used when no client identity is available. */
export const SHARED_CLIENT = 'shared';

export type RateDecision =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number };

/** In-memory sliding-window limiter (per process) with a bounded number of keys. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Number of tracked keys (never more than maxKeys after a check). */
  get size(): number {
    return this.hits.size;
  }

  check(key: string): RateDecision {
    const now = this.now();
    this.expire(now);
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const oldest = recent[0] ?? now;
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000)),
      };
    }
    recent.push(now);
    this.hits.delete(key); // re-insert so Map order is least recently used first
    this.hits.set(key, recent);
    // Over the cap: drop least recently used keys. O(1) per check (amortised).
    while (this.hits.size > this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey === undefined) break;
      this.hits.delete(oldestKey);
    }
    return { ok: true, remaining: this.limit - recent.length };
  }

  /** Drop expired keys, at most once per window (a full pass is O(keys)). */
  private expire(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if ((times[times.length - 1] ?? 0) <= cutoff) this.hits.delete(key);
    }
  }
}

type Scope = 'client' | 'shared' | 'identity';

const globalForLimits = globalThis as unknown as {
  __agenthubLimiters?: Map<string, SlidingWindowLimiter>;
};

function limiterFor(group: RateGroup, scope: Scope): SlidingWindowLimiter {
  globalForLimits.__agenthubLimiters ??= new Map();
  const id = `${group}:${scope}`;
  let limiter = globalForLimits.__agenthubLimiters.get(id);
  if (!limiter) {
    const { limit, windowMs } = scope === 'shared' ? SHARED_RATE_LIMITS[group] : RATE_LIMITS[group];
    limiter = new SlidingWindowLimiter(limit, windowMs);
    globalForLimits.__agenthubLimiters.set(id, limiter);
  }
  return limiter;
}

/** Forget every bucket (tests). */
export function resetRateLimits(): void {
  globalForLimits.__agenthubLimiters?.clear();
}

/** Charge one request of an anonymous client (see clientKeyFromHeaders). */
export function checkClientLimit(group: RateGroup, headers: Headers): RateDecision {
  const key = clientKeyFromHeaders(headers);
  const scope: Scope = key === SHARED_CLIENT ? 'shared' : 'client';
  return limiterFor(group, scope).check(key);
}

/** Charge one request of an authenticated identity (publisher id, admin, session). */
export function checkIdentityLimit(group: RateGroup, identity: string): RateDecision {
  return limiterFor(group, 'identity').check(identity);
}

export function rateLimitedError(decision: { retryAfterSeconds: number }): ApiError {
  return new ApiError('RATE_LIMITED', 'Too many requests. Try again later.', {
    headers: { 'Retry-After': String(decision.retryAfterSeconds) },
  });
}

/** Throws RATE_LIMITED when the decision refused the request. */
export function enforceDecision(decision: RateDecision): void {
  if (!decision.ok) throw rateLimitedError(decision);
}

/** Record a failed credential attempt; throws RATE_LIMITED once the client has too many. */
export function enforceAuthFailureLimit(headers: Headers): void {
  enforceDecision(checkClientLimit('auth', headers));
}

/** Expand an IPv6 address and keep its /64 prefix (one subscriber usually owns a /64). */
function ipv6Prefix(address: string): string {
  let addr = address.toLowerCase();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(addr);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number];
    addr = `${addr.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = addr.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g || '0', 16).toString(16))
    .join(':')}::/64`;
}

/** Normalise one X-Forwarded-For entry to a bucket key, or null when it is not an address. */
export function normalizeClientAddress(raw: string): string | null {
  let value = raw.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1] as string;
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value);
  if (v4WithPort) value = v4WithPort[1] as string;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1] as string;
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) return ipv6Prefix(value);
  return null;
}

/**
 * Bucket key for an anonymous client: the address the trusted proxy appended to
 * X-Forwarded-For, or SHARED_CLIENT in direct mode (and when that hop is missing/invalid).
 */
export function clientKeyFromHeaders(headers: Headers): string {
  const hops = trustedProxyHops();
  if (hops === 0) return SHARED_CLIENT;
  const xff = headers.get('x-forwarded-for');
  if (!xff) return SHARED_CLIENT;
  const entries = xff.split(',').map((h) => h.trim());
  const entry = entries[entries.length - hops];
  if (entry === undefined) return SHARED_CLIENT;
  return normalizeClientAddress(entry) ?? SHARED_CLIENT;
}
