import { type NextRequest, NextResponse } from 'next/server';
import { adminToken } from './src/config';
import { checkClientLimit } from './src/lib/rate-limit';

const PLAIN_HEADERS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cache-Control': 'no-store',
};

/**
 * Per-request nonce Content-Security-Policy for pages (Next.js CSP guide), the page rate limit
 * and the admin-disabled gate.
 * API routes get a static `default-src 'none'` policy from next.config.ts instead, are rate
 * limited by their handlers, and are excluded here so large uploads are never buffered by the
 * proxy.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Pages run the same registry queries as the API (search, skill detail), so they are limited
  // too: per client behind a trusted proxy, one shared bucket otherwise (see rate-limit.ts).
  const decision = checkClientLimit('page', request.headers);
  if (!decision.ok) {
    return new NextResponse('Too many requests. Try again later.\n', {
      status: 429,
      headers: { ...PLAIN_HEADERS, 'Retry-After': String(decision.retryAfterSeconds) },
    });
  }
  if ((pathname === '/admin' || pathname.startsWith('/admin/')) && adminToken() === null) {
    return new NextResponse('Admin is disabled on this registry.\n', {
      status: 503,
      headers: PLAIN_HEADERS,
    });
  }

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    // Admin pages always pass through the proxy (prefetch requests included), so the
    // admin-disabled gate cannot be skipped with a prefetch header. Admin actions re-check it.
    '/admin',
    '/admin/:path*',
    {
      source: '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
