import { afterEach, describe, expect, it } from 'vitest';
import {
  bearerToken,
  createSession,
  generatePublisherToken,
  hashesEqual,
  hashToken,
  isWellFormedPublisherToken,
  SESSION_TTL_MS,
  verifyAdminToken,
  verifySession,
  verifyToken,
} from '../src/lib/auth';

const ADMIN = 'x'.repeat(40);
const original = { ...process.env };

afterEach(() => {
  process.env.AGENTHUB_ADMIN_TOKEN = original.AGENTHUB_ADMIN_TOKEN;
  process.env.AGENTHUB_SESSION_SECRET = original.AGENTHUB_SESSION_SECRET;
  if (original.AGENTHUB_ADMIN_TOKEN === undefined) delete process.env.AGENTHUB_ADMIN_TOKEN;
  if (original.AGENTHUB_SESSION_SECRET === undefined) delete process.env.AGENTHUB_SESSION_SECRET;
});

describe('publisher tokens', () => {
  it('generates 32-byte base64url tokens that are unique', () => {
    const a = generatePublisherToken();
    const b = generatePublisherToken();
    expect(a).not.toBe(b);
    expect(isWellFormedPublisherToken(a)).toBe(true);
    expect(Buffer.from(a.slice(4), 'base64url')).toHaveLength(32);
  });

  it('accepts the right token and rejects a wrong one against the stored hash', () => {
    const token = generatePublisherToken();
    const stored = hashToken(token);
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyToken(token, stored)).toBe(true);
    expect(verifyToken(generatePublisherToken(), stored)).toBe(false);
    expect(verifyToken(`${token}x`, stored)).toBe(false);
  });

  it('compares hashes in constant time and rejects malformed input', () => {
    const h = hashToken('a');
    expect(hashesEqual(h, h)).toBe(true);
    expect(hashesEqual(h, hashToken('b'))).toBe(false);
    expect(hashesEqual(h, 'abcd')).toBe(false);
    expect(hashesEqual('', '')).toBe(false);
  });

  it('parses bearer headers strictly', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer a b')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe('admin token and sessions', () => {
  it('disables admin when the token is unset or shorter than 32 characters', () => {
    delete process.env.AGENTHUB_ADMIN_TOKEN;
    expect(verifyAdminToken('anything')).toBe(false);
    expect(createSession()).toBeNull();
    process.env.AGENTHUB_ADMIN_TOKEN = 'short';
    expect(verifyAdminToken('short')).toBe(false);
  });

  it('verifies the configured admin token', () => {
    process.env.AGENTHUB_ADMIN_TOKEN = ADMIN;
    expect(verifyAdminToken(ADMIN)).toBe(true);
    expect(verifyAdminToken(`${ADMIN}y`)).toBe(false);
    expect(verifyAdminToken('')).toBe(false);
  });

  it('signs sessions that verify, expire after 8 hours and resist tampering', () => {
    process.env.AGENTHUB_ADMIN_TOKEN = ADMIN;
    const now = 1_000_000;
    const session = createSession(now);
    expect(session).not.toBeNull();
    const value = session?.value ?? '';
    expect(verifySession(value, now + 1000)).toBe(true);
    expect(verifySession(value, now + SESSION_TTL_MS + 1)).toBe(false);

    const parts = value.split('.');
    const extended = [parts[0], String(now + 10 * SESSION_TTL_MS), parts[2], parts[3]].join('.');
    expect(verifySession(extended, now)).toBe(false);
    expect(verifySession(`${value}x`, now)).toBe(false);
    expect(verifySession('v1.1.2', now)).toBe(false);
    expect(verifySession(undefined, now)).toBe(false);
  });

  it('invalidates sessions when the signing secret changes', () => {
    process.env.AGENTHUB_ADMIN_TOKEN = ADMIN;
    const session = createSession();
    process.env.AGENTHUB_ADMIN_TOKEN = 'z'.repeat(40);
    expect(verifySession(session?.value)).toBe(false);
    process.env.AGENTHUB_SESSION_SECRET = 's'.repeat(32);
    const pinned = createSession();
    process.env.AGENTHUB_ADMIN_TOKEN = ADMIN;
    expect(verifySession(pinned?.value)).toBe(true);
  });
});
