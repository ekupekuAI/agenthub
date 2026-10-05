import type { NextConfig } from 'next';

const isProd = process.env.NODE_ENV === 'production';

/** Headers for every response. The page CSP (with a per-request nonce) is set in proxy.ts. */
const baseHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isProd
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]
    : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // Keep `next dev` from writing generated instruction files into the app directory.
  agentRules: false,
  transpilePackages: ['@agenthub/core', '@agenthub/scanner'],
  serverExternalPackages: ['@electric-sql/pglite'],
  experimental: {
    // Publish uploads go through a server action; packages are capped at 10 MiB.
    serverActions: { bodySizeLimit: '11mb' },
    proxyClientMaxBodySize: '12mb',
  },
  async headers() {
    return [
      { source: '/:path*', headers: baseHeaders },
      {
        // JSON API: nothing to render, nothing to frame.
        source: '/api/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'" },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default nextConfig;
