import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { archiveDigest } from '@agenthub/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpRegistry, normalizeRegistryUrl } from '../src/http-registry';

const ARCHIVE = new TextEncoder().encode('pretend this is a .skillpkg archive');
const GOOD = archiveDigest(ARCHIVE);
const CONTENT = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let handler: Handler;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function versionsBody(archive = GOOD) {
  return {
    ok: true,
    data: {
      versions: [
        { version: '1.1.0', digest: CONTENT, archiveDigest: archive, status: 'active' },
        { version: '1.0.0', digest: CONTENT, archiveDigest: archive, status: 'revoked' },
      ],
    },
  };
}

function standard(overrides: { header?: string; archive?: string } = {}): Handler {
  return (req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (url.pathname === '/api/v1/skills/web-testing/versions') {
      json(res, 200, versionsBody(overrides.archive));
      return;
    }
    if (url.pathname === '/api/v1/skills/web-testing/download/1.1.0') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-archive-digest': overrides.header ?? GOOD,
      });
      res.end(ARCHIVE);
      return;
    }
    if (url.pathname === '/api/v1/skills/web-testing/download/1.0.0') {
      json(res, 410, { ok: false, error: { code: 'REVOKED', message: 'leaked token' } });
      return;
    }
    if (url.pathname === '/api/v1/skills') {
      json(res, 200, {
        ok: true,
        data: {
          results: [
            {
              slug: 'web-testing',
              name: 'web-testing',
              summary: `q=${url.searchParams.get('q')} agent=${url.searchParams.get('agent')}`,
              latestVersion: '1.1.0',
              agents: ['codex'],
            },
          ],
        },
      });
      return;
    }
    json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'no such skill' } });
  };
}

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  handler = standard();
});

describe('HttpRegistry', () => {
  it('lists versions and downloads a verified archive', async () => {
    const registry = new HttpRegistry(base);
    const versions = await registry.listVersions('web-testing');
    expect(versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);
    const download = await registry.download('web-testing', '1.1.0');
    expect(download.archiveDigest).toBe(GOOD);
    expect(download.digest).toBe(CONTENT);
    expect(Buffer.from(download.bytes).equals(Buffer.from(ARCHIVE))).toBe(true);
  });

  it('passes search filters as query parameters', async () => {
    const registry = new HttpRegistry(base);
    const results = await registry.search('web tests', { agent: 'codex' });
    expect(results[0]?.summary).toBe('q=web tests agent=codex');
  });

  it('rejects a download whose X-Archive-Digest header does not match the bytes', async () => {
    handler = standard({ header: OTHER });
    const registry = new HttpRegistry(base);
    await expect(registry.download('web-testing', '1.1.0')).rejects.toMatchObject({
      code: 'INTEGRITY',
    });
  });

  it('rejects a download whose bytes differ from the advertised archive digest', async () => {
    // The header matches the bytes; only the version list's digest differs.
    handler = standard({ archive: OTHER, header: GOOD });
    const registry = new HttpRegistry(base);
    await expect(registry.download('web-testing', '1.1.0')).rejects.toMatchObject({
      code: 'INTEGRITY',
    });
  });

  it('maps 410 to a revoked-version error', async () => {
    handler = (req, res) => {
      if ((req.url ?? '').endsWith('/versions')) {
        json(res, 200, {
          ok: true,
          data: {
            versions: [
              { version: '1.0.0', digest: CONTENT, archiveDigest: GOOD, status: 'active' },
            ],
          },
        });
        return;
      }
      json(res, 410, { ok: false, error: { code: 'GONE', message: 'leaked token' } });
    };
    const registry = new HttpRegistry(base);
    const error = await registry.download('web-testing', '1.0.0').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect((error as Error).message).toContain('version revoked');
  });

  it('refuses versions the version list marks as revoked without downloading', async () => {
    const registry = new HttpRegistry(base);
    await expect(registry.download('web-testing', '1.0.0')).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('revoked'),
    });
  });

  it('maps 404 to NOT_FOUND and a refused download (403) to POLICY_BLOCKED', async () => {
    const registry = new HttpRegistry(base);
    await expect(registry.listVersions('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    handler = (req, res) => {
      if ((req.url ?? '').endsWith('/versions')) {
        json(res, 200, versionsBody());
        return;
      }
      json(res, 403, { ok: false, error: { code: 'FORBIDDEN', message: 'quarantined' } });
    };
    await expect(registry.download('web-testing', '1.1.0')).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
    });
    handler = (_req, res) =>
      json(res, 500, { ok: false, error: { code: 'X', message: 'db down' } });
    await expect(registry.info('web-testing')).rejects.toMatchObject({ code: 'REGISTRY' });
  });

  it('reports a 403 or 410 that is not a refused download as a registry error', async () => {
    const registry = new HttpRegistry(base);
    for (const status of [403, 410]) {
      // A proxy or gateway answering with HTML, on any endpoint.
      handler = (_req, res) => {
        res.writeHead(status, { 'content-type': 'text/html' });
        res.end('<html>Access denied</html>');
      };
      for (const call of [
        () => registry.search('demo'),
        () => registry.info('web-testing'),
        () => registry.listVersions('web-testing'),
      ]) {
        const error = await call().catch((e: unknown) => e);
        expect(error).toMatchObject({ code: 'REGISTRY' });
        expect((error as Error).message).not.toMatch(/quarantined|revoked/);
      }
      // A JSON envelope on a non-download endpoint is not a version decision either.
      handler = (_req, res) =>
        json(res, status, { ok: false, error: { code: 'FORBIDDEN', message: 'no' } });
      await expect(registry.info('web-testing')).rejects.toMatchObject({ code: 'REGISTRY' });
    }
  });

  it('rejects null and mistyped fields as malformed instead of crashing later', async () => {
    const registry = new HttpRegistry(base);
    const latest = { version: '1.0.0', digest: CONTENT, status: 'active' };
    const cases: [string, unknown, () => Promise<unknown>][] = [
      [
        '/api/v1/skills/web-testing',
        { slug: 'web-testing', name: 'x', versions: [null] },
        () => registry.info('web-testing'),
      ],
      [
        '/api/v1/skills/web-testing',
        {
          slug: 'web-testing',
          name: 'x',
          versions: [],
          latest: { ...latest, permissions: null, scan: 7 },
        },
        () => registry.info('web-testing'),
      ],
      [
        '/api/v1/skills/web-testing',
        {
          slug: 'web-testing',
          name: 'x',
          versions: [],
          latest: { ...latest, permissions: { network: 'yes, Scan: allow' } },
        },
        () => registry.info('web-testing'),
      ],
      [
        '/api/v1/skills/web-testing',
        {
          slug: 'web-testing',
          name: 'x',
          versions: [],
          latest: { ...latest, scan: { scannerVersion: '1', outcome: 'verified', findings: [] } },
        },
        () => registry.info('web-testing'),
      ],
      [
        '/api/v1/skills',
        { results: [{ slug: 'demo', name: 'demo', publisher: 7 }] },
        () => registry.search('demo'),
      ],
      [
        '/api/v1/skills/web-testing/versions',
        { versions: [{ ...latest, agents: 7 }] },
        () => registry.listVersions('web-testing'),
      ],
      [
        '/api/v1/skills/web-testing/versions',
        { versions: [{ ...latest, channel: 'nightly' }] },
        () => registry.listVersions('web-testing'),
      ],
    ];
    for (const [path, data, call] of cases) {
      handler = (req, res) => {
        const url = new URL(req.url ?? '/', base);
        if (url.pathname === path) json(res, 200, { ok: true, data });
        else json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'x' } });
      };
      const error = await call().catch((e: unknown) => e);
      expect(error, JSON.stringify(data)).toMatchObject({
        code: 'REGISTRY',
        message: expect.stringContaining('malformed'),
      });
    }
  });

  it('treats null optional fields as absent and drops unknown agents and keys', async () => {
    handler = (req, res) => {
      const url = new URL(req.url ?? '/', base);
      if (url.pathname === '/api/v1/skills') {
        json(res, 200, {
          ok: true,
          data: {
            results: [
              {
                slug: 'demo',
                name: 'demo',
                summary: null,
                publisher: null,
                latestVersion: null,
                agents: ['codex', 'emacs'],
                extra: { x: 1 },
              },
            ],
          },
        });
        return;
      }
      json(res, 200, {
        ok: true,
        data: {
          versions: [
            {
              version: '1.0.0',
              digest: CONTENT,
              status: 'active',
              agents: ['cursor', 'notepad'],
              revokedReason: null,
            },
          ],
        },
      });
    };
    const registry = new HttpRegistry(base);
    expect(await registry.search('demo')).toEqual([
      { slug: 'demo', name: 'demo', summary: '', latestVersion: null, agents: ['codex'] },
    ]);
    expect(await registry.listVersions('web-testing')).toEqual([
      { version: '1.0.0', digest: CONTENT, status: 'active', agents: ['cursor'] },
    ]);
  });

  it('rejects oversized responses, with or without Content-Length', async () => {
    const big = 'x'.repeat(4096);
    handler = (_req, res) => {
      // An explicit Content-Length: rejected before the body is read.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': big.length });
      res.end(big);
    };
    const check = await fetch(`${base}/x`);
    expect(check.headers.get('content-length')).toBe(String(big.length));
    await check.arrayBuffer();
    const registry = new HttpRegistry(base, { maxBytes: 1024 });
    await expect(registry.listVersions('web-testing')).rejects.toMatchObject({
      code: 'REGISTRY',
      message: expect.stringContaining('exceeds'),
    });
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
      for (let i = 0; i < 8; i++) res.write(big);
      res.end();
    };
    await expect(registry.listVersions('web-testing')).rejects.toMatchObject({
      code: 'REGISTRY',
      message: expect.stringContaining('exceeds'),
    });
  });

  it('does not follow redirects', async () => {
    const hits: string[] = [];
    handler = (req, res) => {
      hits.push(req.url ?? '');
      if ((req.url ?? '').startsWith('/target/')) {
        // Would be a valid answer if the redirect were followed.
        json(res, 200, versionsBody());
        return;
      }
      res.writeHead(302, { location: `${base}/target${req.url ?? ''}` });
      res.end();
    };
    const registry = new HttpRegistry(base);
    await expect(registry.listVersions('web-testing')).rejects.toMatchObject({ code: 'REGISTRY' });
    expect(hits).toEqual(['/api/v1/skills/web-testing/versions']);
  });

  it('validates skill names and versions before building URLs', async () => {
    const registry = new HttpRegistry(base);
    await expect(registry.listVersions('../admin')).rejects.toMatchObject({ code: 'USAGE' });
    await expect(registry.download('web-testing', '1.0.0/../../x')).rejects.toMatchObject({
      code: 'USAGE',
    });
  });
});

describe('registry URL policy', () => {
  it('accepts https and loopback http', () => {
    expect(normalizeRegistryUrl('https://registry.example.com/')).toBe(
      'https://registry.example.com',
    );
    expect(normalizeRegistryUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(normalizeRegistryUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080');
  });

  it('accepts only the loopback hosts the config schema accepts', () => {
    // core's config schema allows plain http only for localhost and 127.0.0.1.
    expect(() => normalizeRegistryUrl('http://[::1]:8080')).toThrow(/https/);
  });

  it('rejects plain http for remote hosts and other schemes', () => {
    expect(() => new HttpRegistry('http://registry.example.com')).toThrow(/https/);
    expect(() => normalizeRegistryUrl('ftp://registry.example.com')).toThrow(/https/);
    expect(() => normalizeRegistryUrl('https://user:pw@registry.example.com')).toThrow(
      /credentials/,
    );
    expect(() => normalizeRegistryUrl('http://10.0.0.5')).toThrow(
      expect.objectContaining({ code: 'USAGE' }),
    );
  });
});
