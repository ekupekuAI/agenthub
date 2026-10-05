import path from 'node:path';

/** Hard cap for an uploaded .skillpkg (design §5.3 limits the unpacked size to 10 MiB too). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Findings stored (and served) per scan; the total is kept separately. BLOCK findings first. */
export const MAX_STORED_FINDINGS = 500;

/** SKILL.md body stored for display, in characters. The full text stays in the package. */
export const MAX_STORED_README_CHARS = 256 * 1024;

/** Versions returned by the version list and the skill detail, newest first. */
export const MAX_LISTED_VERSIONS = 1000;

/** New versions per skill, and per publisher, in any rolling 24 hours. */
export const MAX_VERSIONS_PER_SKILL_PER_DAY = 50;
export const MAX_VERSIONS_PER_PUBLISHER_PER_DAY = 200;

export function dataDir(): string {
  return process.env.AGENTHUB_DATA_DIR ?? path.join(process.cwd(), '.data');
}

/** True inside a Vercel deployment (build or function), where the filesystem is read-only. */
export function onVercel(): boolean {
  return process.env.VERCEL === '1';
}

/**
 * Hosted Postgres (Neon) connection string, or null for the embedded database. Without it the
 * registry uses PGlite in `<dataDir>/pglite`.
 */
export function databaseUrl(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : null;
}

/** Vercel Blob read-write token, or null for the local artifact folder `<dataDir>/artifacts`. */
export function blobToken(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  return token ? token : null;
}

/**
 * Access mode of the Vercel Blob store (AGENTHUB_BLOB_ACCESS): 'private' (default) or
 * 'public'. It must match how the store was created.
 */
export function blobAccess(): 'private' | 'public' {
  return process.env.AGENTHUB_BLOB_ACCESS?.trim().toLowerCase() === 'public' ? 'public' : 'private';
}

/** The admin token, or null when admin is disabled (unset or shorter than 32 characters). */
export function adminToken(): string | null {
  const token = process.env.AGENTHUB_ADMIN_TOKEN;
  if (!token || token.length < 32) return null;
  return token;
}

export function securityContact(): string | null {
  const contact = process.env.AGENTHUB_SECURITY_CONTACT?.trim();
  return contact ? contact : null;
}

/**
 * Number of trusted reverse proxies in front of the registry (AGENTHUB_TRUST_PROXY).
 * '1' (or 'true') means one proxy; '2'..'10' for a chain. Anything else: 0 (direct mode).
 */
export function trustedProxyHops(): number {
  const raw = process.env.AGENTHUB_TRUST_PROXY?.trim().toLowerCase();
  if (!raw) return 0;
  if (raw === 'true') return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 0;
}

export function trustProxy(): boolean {
  return trustedProxyHops() > 0;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** Wall-clock budget for unpacking, validating and scanning one upload (worker thread). */
export function scanTimeoutMs(): number {
  return intFromEnv('AGENTHUB_SCAN_TIMEOUT_MS', 15_000, 100, 300_000);
}

/** Uploads scanned at the same time; further uploads wait in a short queue. */
export function scanConcurrency(): number {
  return intFromEnv('AGENTHUB_SCAN_CONCURRENCY', 2, 1, 16);
}

/**
 * GitHub OAuth app credentials (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET), or null when GitHub
 * sign-in is not configured. Both are required.
 */
export function githubOAuth(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId) || clientSecret.length < 20) return null;
  return { clientId, clientSecret };
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/**
 * The registry's public origin from AGENTHUB_PUBLIC_URL (for example
 * https://agenthub-registry.vercel.app), or null when unset or invalid. Only an origin is
 * accepted (no path, query or credentials), and plain http only for a loopback host.
 */
export function publicUrl(): URL | null {
  const raw = process.env.AGENTHUB_PUBLIC_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url;
  return null;
}

/**
 * Origin used to build OAuth callback URLs. AGENTHUB_PUBLIC_URL when set; otherwise the
 * request's own origin only when its host is a loopback address (local development). Any other
 * host is never trusted, so a forged Host header cannot change where GitHub sends the code.
 */
export function oauthBaseUrl(request: { url: string }): URL | null {
  const configured = publicUrl();
  if (configured) return configured;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (!isLoopbackHost(url.hostname)) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return new URL(url.origin);
}
