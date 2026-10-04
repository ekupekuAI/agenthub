import path from 'node:path';

/** Hard cap for an uploaded .skillpkg (design §5.3 limits the unpacked size to 10 MiB too). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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

export function trustProxy(): boolean {
  return process.env.AGENTHUB_TRUST_PROXY === '1';
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
