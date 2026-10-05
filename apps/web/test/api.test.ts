/**
 * Route-handler tests for the /api/v1 contract the CLI consumes: response envelopes, status
 * codes and download headers. Uses a temp data dir (on-disk PGlite + artifact store).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SHARED_RATE_LIMITS } from '../src/lib/rate-limit';
import { DOWNLOAD_EXEC_SCRIPT, packTestSkill } from './helpers';

const ADMIN = 'a'.repeat(48);
let root: string;
let token: string;
let routes: {
  publish: typeof import('../app/api/v1/publish/route');
  search: typeof import('../app/api/v1/skills/route');
  detail: typeof import('../app/api/v1/skills/[slug]/route');
  versions: typeof import('../app/api/v1/skills/[slug]/versions/route');
  resolve: typeof import('../app/api/v1/skills/[slug]/resolve/route');
  download: typeof import('../app/api/v1/skills/[slug]/download/[version]/route');
  revoke: typeof import('../app/api/v1/skills/[slug]/revoke/route');
  publishers: typeof import('../app/api/v1/admin/publishers/route');
};

const BASE = 'http://localhost:3000';
// A unique client address per test file keeps the shared rate limiter out of the way.
const IP = { 'x-forwarded-for': '192.0.2.77' };
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agenthub-api-'));
  process.env.AGENTHUB_DATA_DIR = path.join(root, 'data');
  delete process.env.AGENTHUB_ADMIN_TOKEN;
  routes = {
    publish: await import('../app/api/v1/publish/route'),
    search: await import('../app/api/v1/skills/route'),
    detail: await import('../app/api/v1/skills/[slug]/route'),
    versions: await import('../app/api/v1/skills/[slug]/versions/route'),
    resolve: await import('../app/api/v1/skills/[slug]/resolve/route'),
    download: await import('../app/api/v1/skills/[slug]/download/[version]/route'),
    revoke: await import('../app/api/v1/skills/[slug]/revoke/route'),
    publishers: await import('../app/api/v1/admin/publishers/route'),
  };
  const { getRegistry } = await import('../src/lib/registry');
  token = (await (await getRegistry()).createPublisher('api-tester', true)).token;
}, 60_000);

afterAll(async () => {
  const { getDatabase } = await import('../src/db/client');
  await (await getDatabase()).close();
  delete process.env.AGENTHUB_DATA_DIR;
  delete process.env.AGENTHUB_ADMIN_TOKEN;
  await rm(root, { recursive: true, force: true });
});

function publishRequest(bytes: Uint8Array, auth: string | null, query = '') {
  return new Request(`${BASE}/api/v1/publish${query}`, {
    method: 'POST',
    headers: {
      ...IP,
      'content-type': 'application/octet-stream',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: Buffer.from(bytes),
  });
}

describe('/api/v1', () => {
  it('requires a publisher token to publish', async () => {
    const bytes = await packTestSkill(root, 'api-skill');
    const res = await routes.publish.POST(publishRequest(bytes, null), ctx({}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: expect.any(String) },
    });
    const wrong = await routes.publish.POST(
      publishRequest(bytes, `ahp_${'x'.repeat(43)}`),
      ctx({}),
    );
    expect(wrong.status).toBe(401);
  });

  it('publishes raw bytes and multipart uploads', async () => {
    const raw = await routes.publish.POST(
      publishRequest(
        await packTestSkill(root, 'api-skill', { version: '1.0.0' }),
        token,
        '?releaseNotes=Hello',
      ),
      ctx({}),
    );
    expect(raw.status).toBe(201);
    const body = await raw.json();
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({ slug: 'api-skill', version: '1.0.0', status: 'active' });

    const form = new FormData();
    form.set(
      'file',
      new Blob([Buffer.from(await packTestSkill(root, 'api-skill', { version: '1.1.0' }))]),
      'x.skillpkg',
    );
    form.set('releaseNotes', 'Second');
    const multipart = await routes.publish.POST(
      new Request(`${BASE}/api/v1/publish`, {
        method: 'POST',
        headers: { ...IP, authorization: `Bearer ${token}` },
        body: form,
      }),
      ctx({}),
    );
    expect(multipart.status).toBe(201);

    const dup = await routes.publish.POST(
      publishRequest(await packTestSkill(root, 'api-skill', { version: '1.1.0' }), token),
      ctx({}),
    );
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe('CONFLICT');
  });

  it('search, detail and versions match the CLI contract shapes', async () => {
    const search = await routes.search.GET(
      new Request(`${BASE}/api/v1/skills?q=api-skill&agent=cursor`, { headers: IP }),
      ctx({}),
    );
    expect(search.status).toBe(200);
    const { data } = await search.json();
    expect(data.results[0]).toMatchObject({
      slug: 'api-skill',
      name: 'api-skill',
      latestVersion: '1.1.0',
      publisher: { name: 'api-tester', verified: true },
      agents: ['claude-code', 'codex', 'cursor', 'vscode'],
    });
    expect(typeof data.results[0].updatedAt).toBe('string');

    const detail = await (
      await routes.detail.GET(
        new Request(`${BASE}/api/v1/skills/api-skill`, { headers: IP }),
        ctx({ slug: 'api-skill' }),
      )
    ).json();
    expect(detail.ok).toBe(true);
    expect(detail.data.latest).toMatchObject({
      version: '1.1.0',
      status: 'active',
      channel: 'stable',
    });
    expect(detail.data.latest.scan).toMatchObject({ scannerVersion: expect.any(String) });
    expect(detail.data.versions.map((v: { version: string }) => v.version)).toEqual([
      '1.1.0',
      '1.0.0',
    ]);

    const versions = await (
      await routes.versions.GET(
        new Request(`${BASE}/api/v1/skills/api-skill/versions`, { headers: IP }),
        ctx({ slug: 'api-skill' }),
      )
    ).json();
    expect(versions.data.versions).toHaveLength(2);

    const bad = await routes.detail.GET(
      new Request(`${BASE}/api/v1/skills/Bad_Slug`, { headers: IP }),
      ctx({ slug: 'Bad_Slug' }),
    );
    expect(bad.status).toBe(400);
    const missing = await routes.detail.GET(
      new Request(`${BASE}/api/v1/skills/nope`, { headers: IP }),
      ctx({ slug: 'nope' }),
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('NOT_FOUND');
  });

  it('resolve and download return digests and safe headers', async () => {
    const resolved = await (
      await routes.resolve.GET(
        new Request(`${BASE}/api/v1/skills/api-skill/resolve?agent=codex&version=^1.0.0`, {
          headers: IP,
        }),
        ctx({ slug: 'api-skill' }),
      )
    ).json();
    expect(resolved).toEqual({
      ok: true,
      data: {
        slug: 'api-skill',
        version: '1.1.0',
        digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        archiveDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        downloadUrl: '/api/v1/skills/api-skill/download/1.1.0',
      },
    });

    const res = await routes.download.GET(
      new Request(`${BASE}${resolved.data.downloadUrl}`, { headers: IP }),
      ctx({ slug: 'api-skill', version: '1.1.0' }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/vnd.agenthub.skillpkg');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="api-skill-1.1.0.skillpkg"',
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-archive-digest')).toBe(resolved.data.archiveDigest);
    expect(res.headers.get('x-content-digest')).toBe(resolved.data.digest);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('admin endpoints return 503 when admin is disabled, 401 with a bad token', async () => {
    const body = JSON.stringify({ version: '1.1.0', reason: 'testing revoke' });
    const req = (auth?: string) =>
      new Request(`${BASE}/api/v1/skills/api-skill/revoke`, {
        method: 'POST',
        headers: {
          ...IP,
          'content-type': 'application/json',
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        body,
      });
    const disabled = await routes.revoke.POST(req(ADMIN), ctx({ slug: 'api-skill' }));
    expect(disabled.status).toBe(503);

    process.env.AGENTHUB_ADMIN_TOKEN = ADMIN;
    expect((await routes.revoke.POST(req('wrong'), ctx({ slug: 'api-skill' }))).status).toBe(401);
    const ok = await routes.revoke.POST(req(ADMIN), ctx({ slug: 'api-skill' }));
    expect(ok.status).toBe(200);

    const gone = await routes.download.GET(
      new Request(`${BASE}/api/v1/skills/api-skill/download/1.1.0`, { headers: IP }),
      ctx({ slug: 'api-skill', version: '1.1.0' }),
    );
    expect(gone.status).toBe(410);
    expect((await gone.json()).error.code).toBe('GONE');

    const created = await routes.publishers.POST(
      new Request(`${BASE}/api/v1/admin/publishers`, {
        method: 'POST',
        headers: { ...IP, 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ displayName: 'new-pub', verified: false }),
      }),
      ctx({}),
    );
    expect(created.status).toBe(201);
    expect((await created.json()).data.token).toMatch(/^ahp_/);
  });

  it('quarantined versions are refused with 403', async () => {
    const res = await routes.publish.POST(
      publishRequest(
        await packTestSkill(root, 'api-bad', { files: { 'go.sh': DOWNLOAD_EXEC_SCRIPT } }),
        token,
      ),
      ctx({}),
    );
    expect((await res.json()).data.status).toBe('quarantined');
    const dl = await routes.download.GET(
      new Request(`${BASE}/api/v1/skills/api-bad/download/1.0.0`, { headers: IP }),
      ctx({ slug: 'api-bad', version: '1.0.0' }),
    );
    expect(dl.status).toBe(403);
    expect((await dl.json()).error.code).toBe('FORBIDDEN');
  });

  it('pages the version list and omits findings from it', async () => {
    const res = await routes.versions.GET(
      new Request(`${BASE}/api/v1/skills/api-skill/versions?limit=1&offset=1`, { headers: IP }),
      ctx({ slug: 'api-skill' }),
    );
    const { data } = await res.json();
    expect(data.versions.map((v: { version: string }) => v.version)).toEqual(['1.0.0']);
    expect(data.versions[0].scan.findings).toEqual([]);
    const bad = await routes.versions.GET(
      new Request(`${BASE}/api/v1/skills/api-skill/versions?limit=0`, { headers: IP }),
      ctx({ slug: 'api-skill' }),
    );
    expect(bad.status).toBe(400);
  });

  it('limits failed publisher tokens without locking out a valid token', async () => {
    const bytes = await packTestSkill(root, 'api-limited', { version: '1.0.0' });
    const statuses: number[] = [];
    for (let i = 0; i <= SHARED_RATE_LIMITS.auth.limit; i++) {
      statuses.push(
        (await routes.publish.POST(publishRequest(bytes, `ahp_${'y'.repeat(43)}`), ctx({}))).status,
      );
    }
    expect(statuses).toContain(401);
    expect(statuses.at(-1)).toBe(429);
    // Requests in the publisher's name with a forged X-Forwarded-For cannot block it.
    const ok = await routes.publish.POST(publishRequest(bytes, token), ctx({}));
    expect(ok.status).toBe(201);
  });

  it('admins can rotate a token and suspend a publisher', async () => {
    const manage = await import('../app/api/v1/admin/publishers/manage/route');
    const { getRegistry } = await import('../src/lib/registry');
    const registry = await getRegistry();
    const victim = await registry.createPublisher('rotating-pub', false);
    const call = (body: unknown) =>
      manage.POST(
        new Request(`${BASE}/api/v1/admin/publishers/manage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
          body: JSON.stringify(body),
        }),
        ctx({}),
      );
    const rotated = await call({ displayName: 'rotating-pub', action: 'rotate-token' });
    expect(rotated.status).toBe(200);
    const { data } = await rotated.json();
    expect(data.token).toMatch(/^ahp_/);
    expect(await registry.authenticatePublisher(victim.token)).toBeNull();
    expect(await registry.authenticatePublisher(data.token)).not.toBeNull();

    expect((await call({ displayName: 'rotating-pub', action: 'disable' })).status).toBe(200);
    expect(await registry.authenticatePublisher(data.token)).toBeNull();
    expect((await call({ displayName: 'nobody-here', action: 'disable' })).status).toBe(404);
  });
});
