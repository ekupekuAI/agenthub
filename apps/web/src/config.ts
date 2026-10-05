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
