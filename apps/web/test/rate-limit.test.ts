import { afterEach, describe, expect, it } from 'vitest';
import { apiRoute, jsonOk } from '../src/lib/http';
import { clientKeyFromHeaders, RATE_LIMITS, SlidingWindowLimiter } from '../src/lib/rate-limit';

afterEach(() => {
  delete process.env.AGENTHUB_TRUST_PROXY;
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

  it('evicts old keys so memory stays bounded', () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(1, 1000, 10, () => now);
    for (let i = 0; i < 50; i++) limiter.check(`k${i}`);
    now = 5000;
    limiter.check('fresh');
    expect(limiter.check('k0').ok).toBe(true);
  });
});

describe('client identity', () => {
  const h = (xff?: string) => new Headers(xff ? { 'x-forwarded-for': xff } : {});

  it('uses only the first X-Forwarded-For hop when the proxy is trusted', () => {
    process.env.AGENTHUB_TRUST_PROXY = '1';
    expect(clientKeyFromHeaders(h('203.0.113.7, 10.0.0.1'))).toBe('203.0.113.7');
    expect(clientKeyFromHeaders(h('not-an-ip'))).toBe('unknown');
  });

  it('does not trust a forwarded chain without AGENTHUB_TRUST_PROXY', () => {
    expect(clientKeyFromHeaders(h('203.0.113.7, 10.0.0.1'))).toBe('unknown');
    expect(clientKeyFromHeaders(h('127.0.0.1'))).toBe('127.0.0.1');
    expect(clientKeyFromHeaders(h())).toBe('unknown');
  });
});

describe('apiRoute rate limiting', () => {
  it('returns 429 with Retry-After and the JSON error envelope after the read limit', async () => {
    const handler = apiRoute('read', async () => jsonOk({ fine: true }));
    const ctx = { params: Promise.resolve({}) };
    const request = () =>
      new Request('http://localhost/api/v1/skills', {
        headers: { 'x-forwarded-for': '198.51.100.23' },
      });
    for (let i = 0; i < RATE_LIMITS.read.limit; i++) {
      expect((await handler(request(), ctx)).status).toBe(200);
    }
    const limited = await handler(request(), ctx);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED', message: expect.any(String) },
    });
  });

  it('rejects cross-origin POSTs', async () => {
    const handler = apiRoute('admin', async () => jsonOk({}));
    const res = await handler(
      new Request('http://localhost/api/v1/admin/publishers', {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          host: 'localhost',
          'x-forwarded-for': '192.0.2.9',
        },
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });
});
