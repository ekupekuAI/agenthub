/**
 * Server actions (admin, publish) with next/headers and next/navigation stubbed: session
 * sign-out, admin-disabled checks and credential rate limits.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { packTestSkill } from './helpers';

const state = vi.hoisted(() => ({
  headers: new Headers(),
  cookies: new Map<string, string>(),
  sets: [] as { name: string; value: string; options: Record<string, unknown> }[],
}));

vi.mock('next/headers', () => ({
  headers: async () => state.headers,
  cookies: async () => ({
    get: (name: string) =>
      state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined,
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      state.sets.push({ name, value, options });
      state.cookies.set(name, value);
    },
    delete: (name: string) => {
      state.sets.push({ name, value: '', options: { deleted: true } });
      state.cookies.delete(name);
    },
  }),
}));

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));

const ADMIN = 'q'.repeat(48);
let root: string;
let admin: typeof import('../app/admin/actions');
let publish: typeof import('../app/publish/actions');
let auth: typeof import('../src/lib/auth');
let guard: typeof import('../src/lib/action-guard');
let rateLimit: typeof import('../src/lib/rate-limit');

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Redirect);
  return (error as Redirect).url;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agenthub-actions-'));
  process.env.AGENTHUB_DATA_DIR = path.join(root, 'data');
  admin = await import('../app/admin/actions');
  publish = await import('../app/publish/actions');
  auth = await import('../src/lib/auth');
  guard = await import('../src/lib/action-guard');
  rateLimit = await import('../src/lib/rate-limit');
}, 60_000);

afterAll(async () => {
  const { getDatabase } = await import('../src/db/client');
  await (await getDatabase()).close();
  delete process.env.AGENTHUB_DATA_DIR;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.AGENTHUB_ADMIN_TOKEN = ADMIN;
  state.headers = new Headers({ origin: 'http://localhost:3000', host: 'localhost:3000' });
  state.cookies.clear();
  state.sets.length = 0;
  rateLimit.resetRateLimits();
});

afterEach(() => {
  delete process.env.AGENTHUB_ADMIN_TOKEN;
  delete process.env.AGENTHUB_SESSION_SECRET;
  vi.unstubAllEnvs();
});

function signIn(): string {
  const session = auth.createSession();
  if (!session) throw new Error('admin disabled');
  state.cookies.set(auth.sessionCookieName(), session.value);
  return session.value;
}

describe('admin sign-out', () => {
  it('clears the __Host- cookie with Secure and Path=/ and ends the session on the server', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const value = signIn();
    expect(await guard.hasAdminSession()).toBe(true);

    expect(await redirectOf(admin.logoutAction())).toBe('/admin');
    const cleared = state.sets.find((s) => s.name === '__Host-agenthub_admin');
    expect(cleared?.value).toBe('');
    expect(cleared?.options).toMatchObject({ secure: true, path: '/', maxAge: 0, httpOnly: true });

    // A copy of the old cookie no longer works.
    state.cookies.set('__Host-agenthub_admin', value);
    expect(await guard.hasAdminSession()).toBe(false);
  });
});

describe('admin actions re-check that admin is enabled', () => {
  it('refuses moderation with a valid old session once admin is disabled', async () => {
    process.env.AGENTHUB_SESSION_SECRET = 'p'.repeat(40);
    signIn();
    delete process.env.AGENTHUB_ADMIN_TOKEN;
    expect(await guard.hasAdminSession()).toBe(false);
    const form = new FormData();
    form.set('slug', 'anything');
    form.set('version', '1.0.0');
    form.set('reason', 'approve it');
    expect(await redirectOf(admin.approveAction(form))).toBe('/admin?error=unauthorized');

    const created = await admin.createPublisherAction({ status: 'idle' }, new FormData());
    expect(created.status).toBe('error');
  });

  it('refuses a session issued before the admin token was rotated', async () => {
    process.env.AGENTHUB_SESSION_SECRET = 'p'.repeat(40);
    signIn();
    process.env.AGENTHUB_ADMIN_TOKEN = 'n'.repeat(48);
    expect(await guard.hasAdminSession()).toBe(false);
  });
});

describe('credential rate limits in actions', () => {
  it('limits failed admin logins but still lets the real token in', async () => {
    const attempt = (token: string) => {
      const form = new FormData();
      form.set('token', token);
      return admin.loginAction({}, form);
    };
    let last: { error?: string } = {};
    for (let i = 0; i <= rateLimit.SHARED_RATE_LIMITS.auth.limit; i++) {
      // A forged X-Forwarded-For per attempt does not create fresh buckets.
      state.headers.set('x-forwarded-for', `10.1.${i >> 8}.${i & 255}`);
      last = await attempt(`wrong-token-${i}`);
    }
    expect(last.error).toMatch(/Too many attempts/);
    expect(await redirectOf(attempt(ADMIN))).toBe('/admin');
  });

  it('limits publishing per publisher token, after the token verified', async () => {
    const { getRegistry } = await import('../src/lib/registry');
    const { token } = await (await getRegistry()).createPublisher('action-pub', false);
    const form = async (version: string, withToken = token) => {
      const f = new FormData();
      f.set('token', withToken);
      f.set(
        'file',
        new File(
          [Buffer.from(await packTestSkill(root, 'action-skill', { version }))],
          'x.skillpkg',
        ),
      );
      return f;
    };
    const bad = await publish.publishAction({ status: 'idle' }, await form('1.0.0', 'ahp_nope'));
    expect(bad.status).toBe('error');
    const ok = await publish.publishAction({ status: 'idle' }, await form('1.0.0'));
    expect(ok.status).toBe('done');
    for (let i = 1; i < rateLimit.RATE_LIMITS.publish.limit; i++) {
      await publish.publishAction({ status: 'idle' }, await form(`1.0.${i}`));
    }
    const limited = await publish.publishAction({ status: 'idle' }, await form('2.0.0'));
    expect(limited).toMatchObject({ status: 'error', message: expect.stringMatching(/Too many/) });
  });
});
