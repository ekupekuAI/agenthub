import { trustProxy } from '../config';

export type RateGroup = 'publish' | 'admin' | 'read';

export const RATE_LIMITS: Record<RateGroup, { limit: number; windowMs: number }> = {
  publish: { limit: 10, windowMs: 60_000 },
  admin: { limit: 30, windowMs: 60_000 },
  read: { limit: 120, windowMs: 60_000 },
};

export type RateDecision =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSeconds: number };

/** In-memory sliding-window limiter (per process). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateDecision {
    const now = this.now();
    this.sweep(now);
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
    this.hits.delete(key); // re-insert to keep Map order ≈ least recently used first
    this.hits.set(key, recent);
    return { ok: true, remaining: this.limit - recent.length };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs && this.hits.size < this.maxKeys) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if ((times[times.length - 1] ?? 0) <= cutoff) this.hits.delete(key);
    }
    // Still too many keys: drop the least recently used ones.
    for (const key of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(key);
    }
  }
}

const globalForLimits = globalThis as unknown as {
  __agenthubLimiters?: Record<RateGroup, SlidingWindowLimiter>;
};

function limiters(): Record<RateGroup, SlidingWindowLimiter> {
  globalForLimits.__agenthubLimiters ??= {
    publish: new SlidingWindowLimiter(RATE_LIMITS.publish.limit, RATE_LIMITS.publish.windowMs),
    admin: new SlidingWindowLimiter(RATE_LIMITS.admin.limit, RATE_LIMITS.admin.windowMs),
    read: new SlidingWindowLimiter(RATE_LIMITS.read.limit, RATE_LIMITS.read.windowMs),
  };
  return globalForLimits.__agenthubLimiters;
}

export function checkRateLimit(group: RateGroup, clientKey: string): RateDecision {
  return limiters()[group].check(`${group}:${clientKey}`);
}

const IP_RE = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * Client identity for rate limiting.
 * - AGENTHUB_TRUST_PROXY=1: first hop of X-Forwarded-For (set it only behind a proxy that
 *   overwrites the header).
 * - Otherwise: the socket address Next.js records in X-Forwarded-For when the client sent none.
 *   A single value is used as-is; anything else falls into the shared 'unknown' bucket.
 */
export function clientKeyFromHeaders(headers: Headers): string {
  const xff = headers.get('x-forwarded-for');
  if (!xff) return 'unknown';
  const hops = xff.split(',').map((h) => h.trim());
  if (trustProxy()) {
    const first = hops[0] ?? '';
    return IP_RE.test(first) ? first : 'unknown';
  }
  if (hops.length === 1 && IP_RE.test(hops[0] ?? '')) return hops[0] as string;
  return 'unknown';
}
