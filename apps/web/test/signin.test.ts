/**
 * Publisher sign-in with GitHub (OAuth web flow with PKCE), sessions, sign-out, publishing and
 * the dashboard with a session, and named CLI tokens. GitHub is replaced by a fetch stub.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { packTestSkill } from './helpers';

const state = vi.hoisted(() => ({
  headers: new Headers(),
  cookies: new Map<string, string>(),
}));

vi.mock('next/headers', () => ({
  headers: async () => state.headers,
  cookies: async () => ({
    get: (name: string) =>
      state.cookies.has(name) ? { name, value: state.cookies.get(name) } : undefined,
    set: (name: string, value: string) => state.cookies.set(name, value),
    delete: (name: string) => state.cookies.delete(name),
  }),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));

const CLIENT_ID = 'Iv1.testclient0001';
const CLIENT_SECRET = 'c'.repeat(40);
const ORIGIN = 'http://localhost:3000';

let root: string;
let routes: typeof import('../src/lib/signin-routes');
let session: typeof import('../src/lib/publisher-session');
let accountsMod: typeof import('../src/lib/accounts');
let guard: typeof import('../src/lib/action-guard');
let publish: typeof import('../app/publish/actions');
let dashboard: typeof import('../app/dashboard/actions');
let registryMod: typeof import('../src/lib/registry');
let rateLimit: typeof import('../src/lib/rate-limit');
let dbClient: typeof import('../src/db/client');

/** What the GitHub stub answers, and what it saw. */
const github = {
  user: { id: 4242, login: 'octo-cat', type: 'User' } as Record<string, unknown>,
  accessToken: 'gho_TESTACCESSTOKEN1234567890abcdef',
  tokenError: false,
  calls: [] as { url: string; method: string; body: string; auth: string | null }[],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const fetchStub = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  const headers = new Headers(init.headers);
  github.calls.push({
    url,
    method: init.method ?? 'GET',
    body: typeof init.body === 'string' ? init.body : String(init.body ?? ''),
    auth: headers.get('authorization'),
  });
  if (url === 'https://github.com/login/oauth/access_token') {
    if (github.tokenError) return json({ error: 'bad_verification_code' });
    return json({ access_token: github.accessToken, token_type: 'bearer', scope: 'read:user' });
  }
  if (url === 'https://api.github.com/user') {
    if (headers.get('authorization') !== `Bearer ${github.accessToken}`) return json({}, 401);
    return json(github.user);
  }
  if (url.startsWith('https://api.github.com/applications/'))
    return new Response(null, { status: 204 });
  return new Response('unexpected', { status: 500 });
});

function getRequest(pathAndQuery: string, cookie?: string): Request {
  const headers = new Headers({ host: 'localhost:3000' });
  if (cookie) headers.set('cookie', cookie);
  return new Request(`${ORIGIN}${pathAndQuery}`, { headers });
}

function setCookies(response: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const index = (pair ?? '').indexOf('=');
    out.set((pair ?? '').slice(0, index), (pair ?? '').slice(index + 1));
  }
  return out;
}

/** Start sign-in and return the OAuth cookie value and the state sent to GitHub. */
async function start(next?: string): Promise<{ cookie: string; state: string; location: URL }> {
  const response = await routes.startGitHubSignIn(
    getRequest(`/api/auth/github/start${next ? `?next=${next}` : ''}`),
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location') ?? '');
  const cookie = setCookies(response).get('agenthub_oauth') ?? '';
  return { cookie, state: location.searchParams.get('state') ?? '', location };
}

async function callback(query: string, cookie?: string): Promise<Response> {
  return routes.finishGitHubSignIn(
    getRequest(
      `/api/auth/github/callback?${query}`,
      cookie ? `agenthub_oauth=${cookie}` : undefined,
    ),
  );
}

/** Complete a sign-in; returns the session cookie value. */
async function signIn(): Promise<string> {
  const { cookie, state: st } = await start();
  const response = await callback(`code=abc123&state=${st}`, cookie);
  expect(response.headers.get('location')).toBe('/dashboard');
  const value = setCookies(response).get('agenthub_session');
  expect(value).toBeTruthy();
  return value as string;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agenthub-signin-'));
  process.env.AGENTHUB_DATA_DIR = path.join(root, 'data');
  routes = await import('../src/lib/signin-routes');
  session = await import('../src/lib/publisher-session');
  accountsMod = await import('../src/lib/accounts');
  guard = await import('../src/lib/action-guard');
  publish = await import('../app/publish/actions');
  dashboard = await import('../app/dashboard/actions');
  registryMod = await import('../src/lib/registry');
  rateLimit = await import('../src/lib/rate-limit');
  dbClient = await import('../src/db/client');
}, 60_000);

afterAll(async () => {
  await (await dbClient.getDatabase()).close();
  delete process.env.AGENTHUB_DATA_DIR;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.stubEnv('GITHUB_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('GITHUB_CLIENT_SECRET', CLIENT_SECRET);
  vi.stubGlobal('fetch', fetchStub);
  github.user = { id: 4242, login: 'octo-cat', type: 'User' };
  github.tokenError = false;
  github.calls.length = 0;
  state.headers = new Headers({ origin: ORIGIN, host: 'localhost:3000' });
  state.cookies.clear();
  rateLimit.resetRateLimits();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('configuration', () => {
  it('answers 503 on every route when GitHub is not configured', async () => {
    vi.stubEnv('GITHUB_CLIENT_SECRET', '');
    const startRes = await routes.startGitHubSignIn(getRequest('/api/auth/github/start'));
    expect(startRes.status).toBe(503);
    expect(await startRes.text()).toContain('not configured');
    const cb = await callback('code=x&state=y');
    expect(cb.status).toBe(503);
    expect(fetchStub).not.toHaveBeenCalledWith(
      expect.stringContaining('github'),
      expect.anything(),
    );
  });

  it('refuses a non-loopback host without AGENTHUB_PUBLIC_URL', async () => {
    const res = await routes.startGitHubSignIn(
      new Request('https://evil.example/api/auth/github/start', {
        headers: { host: 'evil.example' },
      }),
    );
    expect(res.status).toBe(503);
  });

  it('builds the callback from AGENTHUB_PUBLIC_URL and moves other hosts there first', async () => {
    vi.stubEnv('AGENTHUB_PUBLIC_URL', 'https://agenthub-registry.vercel.app');
    const other = await routes.startGitHubSignIn(
      new Request('https://preview-abc.vercel.app/api/auth/github/start?next=publish'),
    );
    expect(other.status).toBe(302);
    expect(other.headers.get('location')).toBe(
      'https://agenthub-registry.vercel.app/api/auth/github/start?next=publish',
    );
    expect(other.headers.getSetCookie()).toEqual([]);
    const same = await routes.startGitHubSignIn(
      new Request('https://agenthub-registry.vercel.app/api/auth/github/start'),
    );
    const location = new URL(same.headers.get('location') ?? '');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://agenthub-registry.vercel.app/api/auth/github/callback',
    );
  });
});

describe('start', () => {
  it('sets a signed short-lived state cookie and redirects to GitHub with PKCE', async () => {
    const response = await routes.startGitHubSignIn(getRequest('/api/auth/github/start'));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    );
    const p = location.searchParams;
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/github/callback`);
    expect(p.get('scope')).toBe('read:user');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [line] = response.headers.getSetCookie();
    expect(line).toMatch(/^agenthub_oauth=/);
    expect(line).toContain('HttpOnly');
    expect(line).toContain('SameSite=Lax');
    expect(line).toContain('Path=/');
    const value = /^agenthub_oauth=([^;]+)/.exec(line ?? '')?.[1] ?? '';
    const attempt = session.readOAuthAttempt(value);
    expect(attempt?.state).toBe(p.get('state'));
    expect(session.pkceChallenge(attempt?.verifier ?? '')).toBe(p.get('code_challenge'));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('uses __Host- cookies with Secure in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const response = await routes.startGitHubSignIn(getRequest('/api/auth/github/start'));
    const [line] = response.headers.getSetCookie();
    expect(line).toMatch(/^__Host-agenthub_oauth=/);
    expect(line).toContain('Secure');
    expect(line).toContain('Path=/');
    expect(line).not.toContain('Domain');
  });

  it('is rate limited', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 125; i++) {
      last = await routes.startGitHubSignIn(getRequest('/api/auth/github/start'));
    }
    expect(last?.headers.get('location')).toBe('/signin?error=rate_limited');
  });
});

describe('callback', () => {
  it('rejects a missing state cookie, a forged state and an expired attempt', async () => {
    const { cookie, state: st } = await start();
    const missing = await callback(`code=abc&state=${st}`);
    expect(missing.headers.get('location')).toBe('/signin?error=state');

    const forged = await callback(`code=abc&state=${'A'.repeat(43)}`, cookie);
    expect(forged.headers.get('location')).toBe('/signin?error=state');

    const tampered = await callback(`code=abc&state=${st}`, `${cookie.slice(0, -2)}xx`);
    expect(tampered.headers.get('location')).toBe('/signin?error=state');

    vi.useFakeTimers({ now: Date.now() + session.OAUTH_STATE_TTL_MS + 1000, toFake: ['Date'] });
    try {
      const expired = await callback(`code=abc&state=${st}`, cookie);
      expect(expired.headers.get('location')).toBe('/signin?error=state');
    } finally {
      vi.useRealTimers();
    }
    // GitHub was never asked for a token.
    expect(github.calls).toEqual([]);
    // Every outcome clears the attempt cookie.
    expect(forged.headers.getSetCookie()[0]).toMatch(/^agenthub_oauth=; .*Max-Age=0/);
  });

  it('refuses a state cookie signed with another key', async () => {
    const { cookie, state: st } = await start();
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'd'.repeat(40));
    const res = await callback(`code=abc&state=${st}`, cookie);
    expect(res.headers.get('location')).toBe('/signin?error=state');
  });

  it('accepts each state once (no replay)', async () => {
    const { cookie, state: st } = await start();
    const first = await callback(`code=abc&state=${st}`, cookie);
    expect(first.headers.get('location')).toBe('/dashboard');
    const replay = await callback(`code=abc&state=${st}`, cookie);
    expect(replay.headers.get('location')).toBe('/signin?error=state');
  });

  it('maps a GitHub refusal and a failed exchange to friendly errors', async () => {
    const a = await start();
    const denied = await callback(`error=access_denied&state=${a.state}`, a.cookie);
    expect(denied.headers.get('location')).toBe('/signin?error=denied');

    const b = await start();
    github.tokenError = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await callback(`code=abc&state=${b.state}`, b.cookie);
    expect(failed.headers.get('location')).toBe('/signin?error=github');
    expect(spy.mock.calls.flat().join(' ')).not.toContain('abc');
    spy.mockRestore();
  });

  it('refuses an invalid GitHub user payload', async () => {
    github.user = { id: '12', login: 'x' };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { cookie, state: st } = await start();
    const res = await callback(`code=abc&state=${st}`, cookie);
    expect(res.headers.get('location')).toBe('/signin?error=github');
    spy.mockRestore();
  });

  it('exchanges the code with the PKCE verifier and creates an unverified publisher', async () => {
    github.user = { id: 777001, login: 'first-timer', type: 'User' };
    const { cookie, state: st } = await start('publish');
    const attempt = session.readOAuthAttempt(cookie);
    const response = await callback(`code=thecode&state=${st}`, cookie);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/publish');

    const exchange = github.calls.find((c) => c.url.endsWith('/access_token'));
    const body = new URLSearchParams(exchange?.body);
    expect(body.get('code')).toBe('thecode');
    expect(body.get('code_verifier')).toBe(attempt?.verifier);
    expect(body.get('client_secret')).toBe(CLIENT_SECRET);
    expect(body.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/github/callback`);
    // The access token is revoked at GitHub right after use.
    const revoke = github.calls.find((c) => c.method === 'DELETE');
    expect(revoke?.body).toContain(github.accessToken);

    const sessionLine = response.headers
      .getSetCookie()
      .find((l) => l.startsWith('agenthub_session='));
    expect(sessionLine).toContain('HttpOnly');
    expect(sessionLine).toContain('SameSite=Lax');
    const value = /^agenthub_session=([^;]+)/.exec(sessionLine ?? '')?.[1];
    const read = session.readPublisherSession(value);
    const accounts = await accountsMod.getAccounts();
    const publisher = await accounts.findPublisherById(read?.publisherId ?? '');
    expect(publisher).toMatchObject({
      displayName: 'first-timer',
      githubUserId: 777001,
      githubLogin: 'first-timer',
      verifiedAt: null,
      tokenHash: null,
    });
  });

  it('never stores the GitHub access token', async () => {
    github.user = { id: 777002, login: 'secret-keeper', type: 'User' };
    await signIn();
    const { client } = (await dbClient.getDatabase()) as Awaited<
      ReturnType<typeof dbClient.openDatabase>
    >;
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    for (const { table_name } of tables.rows) {
      const rows = await client.query(`SELECT * FROM "${table_name}"`);
      expect(JSON.stringify(rows.rows)).not.toContain(github.accessToken);
    }
  });

  it('reuses the publisher by GitHub id after a rename, and never matches on the login', async () => {
    github.user = { id: 900001, login: 'renamer', type: 'User' };
    const first = session.readPublisherSession(await signIn());
    github.user = { id: 900001, login: 'renamed-now', type: 'User' };
    const second = session.readPublisherSession(await signIn());
    expect(second?.publisherId).toBe(first?.publisherId);
    const accounts = await accountsMod.getAccounts();
    const row = await accounts.findPublisherById(second?.publisherId ?? '');
    expect(row?.githubLogin).toBe('renamed-now');
    expect(row?.displayName).toBe('renamer');

    // Someone else now takes the old login: a different account, with a suffixed name.
    github.user = { id: 900002, login: 'renamer', type: 'User' };
    const third = session.readPublisherSession(await signIn());
    expect(third?.publisherId).not.toBe(first?.publisherId);
    const other = await accounts.findPublisherById(third?.publisherId ?? '');
    expect(other?.displayName).toBe('renamer-2');
  });

  it('suffixes names taken case-insensitively and refuses suspended publishers', async () => {
    const registry = await registryMod.getRegistry();
    await registry.createPublisher('Taken-Name', true);
    github.user = { id: 900010, login: 'taken-name', type: 'User' };
    const s = session.readPublisherSession(await signIn());
    const accounts = await accountsMod.getAccounts();
    expect((await accounts.findPublisherById(s?.publisherId ?? ''))?.displayName).toBe(
      'taken-name-2',
    );
    await registry.setPublisherDisabled('taken-name-2', true);
    const { cookie, state: st } = await start();
    const res = await callback(`code=abc&state=${st}`, cookie);
    expect(res.headers.get('location')).toBe('/signin?error=suspended');
  });
});

describe('session', () => {
  it('validates the signature and expiry', async () => {
    const created = session.createPublisherSession('0a5b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d');
    expect(session.readPublisherSession(created?.value)?.publisherId).toBe(
      '0a5b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
    );
    expect(session.readPublisherSession(`${created?.value}x`)).toBeNull();
    const later = Date.now() + session.PUBLISHER_SESSION_TTL_MS + 1;
    expect(session.readPublisherSession(created?.value, later)).toBeNull();
    // Sessions end when GitHub sign-in is switched off.
    vi.stubEnv('GITHUB_CLIENT_ID', '');
    expect(session.readPublisherSession(created?.value)).toBeNull();
  });

  it('signs out: Origin-checked, revoked on the server, cookie cleared', async () => {
    github.user = { id: 900100, login: 'leaver', type: 'User' };
    const value = await signIn();
    state.cookies.set('agenthub_session', value);
    expect((await guard.currentPublisher())?.publisher.githubLogin).toBe('leaver');

    const crossSite = await routes.signOut(
      new Request(`${ORIGIN}/api/auth/signout`, {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          origin: 'https://evil.example',
          cookie: `agenthub_session=${value}`,
        },
      }),
    );
    expect(crossSite.status).toBe(403);
    expect(await guard.currentPublisher()).not.toBeNull();

    const res = await routes.signOut(
      new Request(`${ORIGIN}/api/auth/signout`, {
        method: 'POST',
        headers: { host: 'localhost:3000', origin: ORIGIN, cookie: `agenthub_session=${value}` },
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/');
    expect(res.headers.getSetCookie()[0]).toMatch(/^agenthub_session=; .*Max-Age=0/);
    // The old cookie value no longer works anywhere.
    expect(await guard.currentPublisher()).toBeNull();
  });
});

describe('publishing and the dashboard with a session', () => {
  async function signedInAs(id: number, login: string): Promise<string> {
    github.user = { id, login, type: 'User' };
    const value = await signIn();
    state.cookies.set('agenthub_session', value);
    return session.readPublisherSession(value)?.publisherId as string;
  }

  it('publishes without a token and lists the skill on the dashboard', async () => {
    await signedInAs(910001, 'session-pub');
    const bytes = await packTestSkill(root, 'session-skill');
    const form = new FormData();
    form.set('file', new File([Buffer.from(bytes)], 'session-skill-1.0.0.skillpkg'));
    const result = await publish.publishAction({ status: 'idle' }, form);
    expect(result).toMatchObject({ status: 'done', summary: { slug: 'session-skill' } });

    const registry = await registryMod.getRegistry();
    const me = await guard.currentPublisher();
    const skills = await registry.listPublisherSkills(me?.publisher.id ?? '');
    expect(skills.map((s) => s.slug)).toEqual(['session-skill']);
  });

  it('asks for a token when there is no session, and refuses a cross-site post', async () => {
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1])], 'x.skillpkg'));
    expect(await publish.publishAction({ status: 'idle' }, form)).toMatchObject({
      status: 'error',
      field: 'token',
    });
    await signedInAs(910002, 'csrf-target');
    state.headers = new Headers({ origin: 'https://evil.example', host: 'localhost:3000' });
    expect(await publish.publishAction({ status: 'idle' }, form)).toMatchObject({
      status: 'error',
      message: expect.stringContaining('agenthub site'),
    });
  });

  it('creates, lists and revokes CLI tokens; a revoked token cannot publish', async () => {
    const publisherId = await signedInAs(910003, 'token-owner');
    const create = new FormData();
    create.set('intent', 'create');
    create.set('name', 'laptop CLI');
    const created = await dashboard.tokensAction({ tokens: [] }, create);
    expect(created.error).toBeUndefined();
    expect(created.created?.token).toMatch(/^ahp_[A-Za-z0-9_-]{43}$/);
    expect(created.tokens.map((t) => t.name)).toEqual(['laptop CLI']);
    const token = created.created?.token as string;

    const registry = await registryMod.getRegistry();
    expect((await registry.authenticatePublisher(token))?.id).toBe(publisherId);
    const accounts = await accountsMod.getAccounts();
    expect((await accounts.listTokens(publisherId))[0]?.lastUsedAt).not.toBeNull();

    // Another publisher cannot revoke it.
    const other = await accounts.signInWithGitHub({ id: 910004, login: 'intruder' });
    expect(await accounts.revokeToken(other.publisher.id, created.tokens[0]?.id ?? '')).toBe(false);

    const revoke = new FormData();
    revoke.set('intent', 'revoke');
    revoke.set('tokenId', created.tokens[0]?.id ?? '');
    const after = await dashboard.tokensAction(created, revoke);
    expect(after.revoked).toBe('laptop CLI');
    expect(after.tokens).toEqual([]);
    expect(await registry.authenticatePublisher(token)).toBeNull();

    // The token flow of the publish form refuses it too.
    state.cookies.clear();
    const form = new FormData();
    form.set('token', token);
    form.set(
      'file',
      new File([Buffer.from(await packTestSkill(root, 'never-published'))], 'n.skillpkg'),
    );
    expect(await publish.publishAction({ status: 'idle' }, form)).toMatchObject({
      status: 'error',
      field: 'token',
    });
  });

  it('validates token names and needs a session to manage tokens', async () => {
    await signedInAs(910005, 'namer');
    const bad = new FormData();
    bad.set('intent', 'create');
    bad.set('name', '');
    expect((await dashboard.tokensAction({ tokens: [] }, bad)).error).toMatch(/Name the token/);
    state.cookies.clear();
    const ok = new FormData();
    ok.set('intent', 'create');
    ok.set('name', 'ci');
    expect((await dashboard.tokensAction({ tokens: [] }, ok)).error).toMatch(/Sign in again/);
  });
});

describe('admin-issued tokens', () => {
  it('keep working, can be revoked from the dashboard, and rotation revokes every token', async () => {
    const registry = await registryMod.getRegistry();
    const created = await registry.createPublisher('legacy-team', false);
    const found = await registry.authenticatePublisher(created.token);
    expect(found?.id).toBe(created.id);
    const accounts = await accountsMod.getAccounts();
    const extra = await accounts.createToken(created.id, 'ci');
    expect((await accounts.listTokens(created.id)).map((t) => t.name)).toEqual(['default', 'ci']);

    const rotated = await registry.rotatePublisherToken('legacy-team');
    expect(await registry.authenticatePublisher(created.token)).toBeNull();
    expect(await registry.authenticatePublisher(extra.token)).toBeNull();
    expect((await registry.authenticatePublisher(rotated.token))?.id).toBe(created.id);

    const [admin] = await accounts.listTokens(created.id);
    expect(await accounts.revokeToken(created.id, admin?.id ?? '')).toBe(true);
    expect(await registry.authenticatePublisher(rotated.token)).toBeNull();
  });

  it('copies a token known only from publishers.token_hash in once, and never revives a revoked one', async () => {
    const { db } = await dbClient.getDatabase();
    const { publishers } = await import('../src/db/schema');
    const auth = await import('../src/lib/auth');
    const { randomUUID } = await import('node:crypto');
    const token = auth.generatePublisherToken();
    const id = randomUUID();
    await db
      .insert(publishers)
      .values({ id, displayName: 'older-deploy', tokenHash: auth.hashToken(token) });
    const registry = await registryMod.getRegistry();
    expect((await registry.authenticatePublisher(token))?.id).toBe(id);
    const accounts = await accountsMod.getAccounts();
    const [row] = await accounts.listTokens(id);
    expect(row?.name).toBe('default');
    await accounts.revokeToken(id, row?.id ?? '');
    expect(await registry.authenticatePublisher(token)).toBeNull();
    // Even if an older deployment wrote the hash back, the revoked row keeps it dead.
    const { eq } = await import('drizzle-orm');
    await db
      .update(publishers)
      .set({ tokenHash: auth.hashToken(token) })
      .where(eq(publishers.id, id));
    expect(await registry.authenticatePublisher(token)).toBeNull();
  });
});
