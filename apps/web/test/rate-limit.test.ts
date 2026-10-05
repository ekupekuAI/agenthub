import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireAdminBearer } from '../src/lib/auth';
import type { ApiError } from '../src/lib/errors';
import { apiRoute, jsonOk } from '../src/lib/http';
import {
  clientKeyFromHeaders,
  normalizeClientAddress,
  RATE_LIMITS,
  resetRateLimits,
  SHARED_CLIENT,
  SHARED_RATE_LIMITS,
  SlidingWindowLimiter,
} from '../src/lib/rate-limit';

const ADMIN = 'r'.repeat(40);

beforeEach(() => {
  resetRateLimits();
});
afterEach(() => {
  delete process.env.AGENTHUB_TRUST_PROXY;
  delete process.env.AGENTHUB_ADMIN_TOKEN;
  resetRateLimits();
});

describe('SlidingWindowLimiter', () => {
  it('allows N requests in the window, then refuses with a retry delay', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(3, 60_000, 1000, () => now);
    expect(limiter.check('a').ok).toBe(true);
    now = 10_000;
    expect(limiter.check('a').ok).toBe(true);
    now = 20_000;
    expect(limiter.check('a').ok).toBe(true);
    const refused = limiter.check('a');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterSeconds).toBe(40);
    // Other clients are unaffected.
    expect(limiter.check('b').ok).toBe(true);
    // The window slides: after the first hit expires, one more is allowed.
    now = 60_001;
    expect(limiter.check('a').ok).toBe(true);
    expect(limiter.check('a').ok).toBe(false);
  });

  it('evicts least recently used keys so memory stays bounded (clock not advanced)', () => {
    const now = 0;
    const limiter = new SlidingWindowLimiter(1, 60_000, 10, () => now);
    for (let i = 0; i < 50; i++) {
      limiter.check(`k${i}`);
      expect(limiter.size).toBeLessThanOrEqual(10);
    }
    // k49 is still tracked (refused); k0 was evicted (allowed again within the same window).
    expect(limiter.check('k49').ok).toBe(false);
    expect(limiter.check('k0').ok).toBe(true);
  });

  it('stays cheap with a full key table', () => {
    const limiter = new SlidingWindowLimiter(5, 60_000, 1000);
    for (let i = 0; i < 1000; i++) limiter.check(`fill${i}`);
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) limiter.check(`spoof${i}`);
    expect(limiter.size).toBeLessThanOrEqual(1000);
    // Amortised O(1): well under a second for 20k checks at the cap.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('client identity', () => {
  const h = (xff?: string) => new Headers(xff ? { 'x-forwarded-for': xff } : {});

  it('ignores X-Forwarded-For without AGENTHUB_TRUST_PROXY (one shared bucket)', () => {
    expect(clientKeyFromHeaders(h('127.0.0.1'))).toBe(SHARED_CLIENT);
    expect(clientKeyFromHeaders(h('10.0.0.1'))).toBe(SHARED_CLIENT);
    expect(clientKeyFromHeaders(h('203.0.113.7, 10.0.0.1'))).toBe(SHARED_CLIENT);
    expect(clientKeyFromHeaders(h())).toBe(SHARED_CLIENT);
  });

  it('uses the hop the trusted proxy appended, not client-supplied entries', () => {
    process.env.AGENTHUB_TRUST_PROXY = '1';
    expect(clientKeyFromHeaders(h('203.0.113.7, 198.51.100.4'))).toBe('198.51.100.4');
    expect(clientKeyFromHeaders(h('198.51.100.4'))).toBe('198.51.100.4');
    expect(clientKeyFromHeaders(h('1.1.1.1, not-an-ip'))).toBe(SHARED_CLIENT);
    process.env.AGENTHUB_TRUST_PROXY = '2';
    expect(clientKeyFromHeaders(h('6.6.6.6, 198.51.100.4, 10.0.0.2'))).toBe('198.51.100.4');
    expect(clientKeyFromHeaders(h('10.0.0.2'))).toBe(SHARED_CLIENT);
  });

  it('normalises addresses and groups IPv6 clients by /64', () => {
    expect(normalizeClientAddress('198.51.100.4:5678')).toBe('198.51.100.4');
    expect(normalizeClientAddress('::ffff:198.51.100.4')).toBe('198.51.100.4');
    expect(normalizeClientAddress('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(normalizeClientAddress('[2001:db8:1:2::ffff]:443')).toBe('2001:db8:1:2::/64');
    expect(normalizeClientAddress('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeClientAddress('ab')).toBeNull();
    expect(normalizeClientAddress('dead:beef')).toBeNull();
  });
});

describe('apiRoute rate limiting', () => {
  const handler = apiRoute('read', async () => jsonOk({ fine: true }));
  const ctx = { params: Promise.resolve({}) };
  const request = (ip: string) =>
    new Request('http://localhost/api/v1/skills', { headers: { 'x-forwarded-for': ip } });

  it('cannot be bypassed with a fresh X-Forwarded-For per request (direct mode)', async () => {
    let i = 0;
    for (; i < SHARED_RATE_LIMITS.read.limit; i++) {
      const res = await handler(request(`10.0.${(i >> 8) & 255}.${i & 255}`), ctx);
      expect(res.status).toBe(200);
    }
    const limited = await handler(request('10.9.9.9'), ctx);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: expect.any(String) },
    });
  });

  it('limits each client separately behind a trusted proxy', async () => {
    process.env.AGENTHUB_TRUST_PROXY = '1';
    for (let i = 0; i < RATE_LIMITS.read.limit; i++) {
      expect((await handler(request(`spoof-${i}, 198.51.100.23`), ctx)).status).toBe(200);
    }
    expect((await handler(request('198.51.100.23'), ctx)).status).toBe(429);
    expect((await handler(request('198.51.100.24'), ctx)).status).toBe(200);
  });

  it('rejects cross-origin POSTs', async () => {
    const admin = apiRoute('admin', async () => jsonOk({}));
    const res = await admin(
      new Request('http://localhost/api/v1/admin/publishers', {
        method: 'POST',
        headers: { origin: 'https://evil.example', host: 'localhost' },
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });
});

describe('credential limits', () => {
  const adminRequest = (token: string) =>
    new Request('http://localhost/api/v1/skills/x/revoke', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  const codeOf = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (error) {
      return (error as ApiError).code;
    }
  };

  it('limits failed admin tokens without locking out the real admin token', () => {
    process.env.AGENTHUB_ADMIN_TOKEN = ADMIN;
    for (let i = 0; i < SHARED_RATE_LIMITS.auth.limit; i++) {
      expect(codeOf(() => requireAdminBearer(adminRequest(`wrong-${i}`)))).toBe('UNAUTHORIZED');
    }
    expect(codeOf(() => requireAdminBearer(adminRequest('wrong-again')))).toBe('RATE_LIMITED');
    // The genuine credential has its own bucket.
    expect(codeOf(() => requireAdminBearer(adminRequest(ADMIN)))).toBeNull();
  });

  it('limits the admin credential itself', () => {
    process.env.AGENTHUB_ADMIN_TOKEN = ADMIN;
    for (let i = 0; i < RATE_LIMITS.admin.limit; i++) {
      expect(codeOf(() => requireAdminBearer(adminRequest(ADMIN)))).toBeNull();
    }
    const error = (() => {
      try {
        requireAdminBearer(adminRequest(ADMIN));
        return null;
      } catch (e) {
        return e as ApiError;
      }
    })();
    expect(error?.code).toBe('RATE_LIMITED');
    expect(error?.headers?.['Retry-After']).toBeDefined();
  });
});
