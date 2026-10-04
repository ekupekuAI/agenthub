import { type NextRequest, NextResponse } from 'next/server';
import { adminToken } from './src/config';

/**
 * Per-request nonce Content-Security-Policy for pages (Next.js CSP guide).
 * API routes get a static `default-src 'none'` policy from next.config.ts instead, and are
 * excluded here so large uploads are never buffered by the proxy.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if ((pathname === '/admin' || pathname.startsWith('/admin/')) && adminToken() === null) {
    return new NextResponse('Admin is disabled on this registry.\n', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
        'Cache-Control': 'no-store',
      },
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
    {
      source: '/((?!api/|_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
