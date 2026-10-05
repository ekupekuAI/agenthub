import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { config, proxy } from '../proxy';
import { resetRateLimits, SHARED_RATE_LIMITS } from '../src/lib/rate-limit';

afterEach(() => {
  delete process.env.AGENTHUB_ADMIN_TOKEN;
  resetRateLimits();
});

const page = (url: string, ip: string) =>
  new NextRequest(url, { headers: { 'x-forwarded-for': ip } });

describe('proxy', () => {
  it('rate limits page requests (forged X-Forwarded-For does not help)', () => {
    resetRateLimits();
    for (let i = 0; i < SHARED_RATE_LIMITS.page.limit; i++) {
      const res = proxy(page('http://localhost/?q=a%20e%20i', `10.2.${i >> 8}.${i & 255}`));
      expect(res.status).not.toBe(429);
    }
    const limited = proxy(page('http://localhost/skills/x', '10.3.0.1'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
  });

  it('runs on admin pages even for prefetch requests, so the disabled gate holds', () => {
    expect(config.matcher).toEqual(expect.arrayContaining(['/admin', '/admin/:path*']));
    const res = proxy(
      new NextRequest('http://localhost/admin', { headers: { 'next-router-prefetch': '1' } }),
    );
    expect(res.status).toBe(503);
  });

  it('sets a nonce CSP on pages', () => {
    const res = proxy(page('http://localhost/', '10.4.0.1'));
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'self' 'nonce-/);
  });
});
