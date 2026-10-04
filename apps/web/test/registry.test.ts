import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillFromDir, packSkill } from '@agenthub/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors';
import { createTestRegistry, DOWNLOAD_EXEC_SCRIPT, packTestSkill, type TestEnv } from './helpers';

let env: TestEnv;
let alice: string;
let bob: string;

beforeAll(async () => {
  env = await createTestRegistry();
  alice = (await env.registry.createPublisher('alice', true)).id;
  bob = (await env.registry.createPublisher('bob', false)).id;
}, 60_000);

afterAll(async () => {
  await env?.cleanup();
});

async function expectApiError(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  expect((error as ApiError).status).toBe(status);
}

describe('publish', () => {
  it('publishes a clean skill as active and stores it by archive digest', async () => {
    const bytes = await packTestSkill(env.root, 'happy-path', {
      version: '1.2.0',
      manifestExtra: 'requires:\n  runtimes:\n    node: ">=20"\n  commands: [git]',
    });
    const summary = await env.registry.publish(bytes, alice, { releaseNotes: 'First.' });
    expect(summary).toMatchObject({ slug: 'happy-path', version: '1.2.0', status: 'active' });
    expect(summary.outcome).not.toBe('block');
    const hex = createHash('sha256').update(bytes).digest('hex');
    expect(summary.archiveDigest).toBe(`sha256:${hex}`);
    expect(summary.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(existsSync(path.join(env.root, 'artifacts', 'sha256', `${hex}.skillpkg`))).toBe(true);

    const info = await env.registry.getSkillInfo('happy-path');
    expect(info.publisher).toEqual({ name: 'alice', verified: true });
    expect(info.latest?.version).toBe('1.2.0');
    expect(info.latest?.agents).toEqual(['claude-code', 'codex', 'cursor', 'vscode']);
    expect(info.latest?.requirements).toEqual(
      expect.arrayContaining([
        { kind: 'runtime', name: 'node', constraint: '>=20' },
        { kind: 'command', name: 'git', constraint: null },
      ]),
    );
    expect(info.latest?.releaseNotes).toBe('First.');
    expect(info.category).toBe('testing');

    const found = await env.registry.search({ q: 'happy' });
    expect(found.map((r) => r.slug)).toContain('happy-path');
  });

  it('rejects a duplicate version with 409 (versions are immutable)', async () => {
    const bytes = await packTestSkill(env.root, 'immutable-skill', { version: '1.0.0' });
    await env.registry.publish(bytes, alice);
    const changed = await packTestSkill(env.root, 'immutable-skill', {
      version: '1.0.0',
      description: 'A different body under the same version.',
    });
    await expectApiError(env.registry.publish(changed, alice), 'CONFLICT', 409);
  });

  it("rejects publishing to another publisher's skill name with 409", async () => {
    await env.registry.publish(await packTestSkill(env.root, 'owned-by-alice'), alice);
    const squat = await packTestSkill(env.root, 'owned-by-alice', { version: '9.9.9' });
    await expectApiError(env.registry.publish(squat, bob), 'CONFLICT', 409);
  });

  it('rejects bytes that are not a skill package', async () => {
    await expectApiError(
      env.registry.publish(new TextEncoder().encode('not a tarball'), alice),
      'INTEGRITY',
      422,
    );
    await expectApiError(env.registry.publish(new Uint8Array(), alice), 'VALIDATION', 400);
  });

  it('quarantines a malicious package and refuses to serve it (403)', async () => {
    const bytes = await packTestSkill(env.root, 'download-runner', {
      files: { 'scripts/setup.sh': DOWNLOAD_EXEC_SCRIPT },
    });
    const summary = await env.registry.publish(bytes, bob);
    expect(summary.status).toBe('quarantined');
    expect(summary.outcome).toBe('block');
    expect(summary.findings.some((f) => f.decision === 'BLOCK')).toBe(true);

    await expectApiError(env.registry.download('download-runner', '1.0.0'), 'FORBIDDEN', 403);
    await expectApiError(env.registry.resolve('download-runner'), 'NOT_FOUND', 404);
    expect((await env.registry.search({ q: 'download-runner' })).length).toBe(0);
    const queue = await env.registry.listByStatus('quarantined');
    expect(queue.map((q) => q.slug)).toContain('download-runner');
  });

  const fixtureDir = fileURLToPath(
    new URL('../../../packages/test-fixtures/fixtures/secret-reader', import.meta.url),
  );
  it.skipIf(!existsSync(fixtureDir))('quarantines the secret-reader fixture', async () => {
    const hasManifest = existsSync(path.join(fixtureDir, 'agenthub.yaml'));
    const pkg = await loadSkillFromDir(fixtureDir);
    const summary = await env.registry.publish(
      packSkill(pkg),
      bob,
      hasManifest ? {} : { version: '1.0.0' },
    );
    expect(summary.status).toBe('quarantined');
    await expectApiError(env.registry.download(summary.slug, summary.version), 'FORBIDDEN', 403);
  });
});

describe('download, revoke and resolve', () => {
  it('serves active versions with matching digests', async () => {
    const bytes = await packTestSkill(env.root, 'downloadable', { version: '2.0.0' });
    const summary = await env.registry.publish(bytes, alice);
    const pkg = await env.registry.download('downloadable', '2.0.0');
    expect(Buffer.from(pkg.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(pkg.archiveDigest).toBe(summary.archiveDigest);
    expect(pkg.digest).toBe(summary.digest);
    expect(pkg.filename).toBe('downloadable-2.0.0.skillpkg');
    await expectApiError(env.registry.download('downloadable', '9.0.0'), 'NOT_FOUND', 404);
    await expectApiError(env.registry.download('no-such-skill', '1.0.0'), 'NOT_FOUND', 404);
  });

  it('revoked versions are skipped by resolve and return 410 on download', async () => {
    for (const version of ['1.0.0', '1.1.0']) {
      await env.registry.publish(await packTestSkill(env.root, 'revocable', { version }), alice);
    }
    expect((await env.registry.resolve('revocable')).version).toBe('1.1.0');
    await env.registry.revoke('revocable', '1.1.0', 'Leaked a token in an example');

    const resolved = await env.registry.resolve('revocable');
    expect(resolved.version).toBe('1.0.0');
    expect(resolved.downloadUrl).toBe('/api/v1/skills/revocable/download/1.0.0');
    await expectApiError(env.registry.download('revocable', '1.1.0'), 'GONE', 410);
    await expectApiError(env.registry.resolve('revocable', { range: '1.1.0' }), 'GONE', 410);

    const versions = await env.registry.listVersions('revocable');
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      ['1.1.0', 'revoked'],
      ['1.0.0', 'active'],
    ]);
    expect(versions[0]?.revokedReason).toBe('Leaked a token in an example');
    // Revocation is final.
    await expectApiError(
      env.registry.setStatus('revocable', '1.1.0', 'active', 'oops'),
      'CONFLICT',
      409,
    );
  });

  it('resolve picks the highest compatible stable version; prereleases only on beta', async () => {
    await env.registry.publish(await packTestSkill(env.root, 'multi', { version: '1.0.0' }), alice);
    await env.registry.publish(await packTestSkill(env.root, 'multi', { version: '1.4.2' }), alice);
    await env.registry.publish(
      await packTestSkill(env.root, 'multi', { version: '2.0.0', targets: ['claude-code'] }),
      alice,
    );
    await env.registry.publish(
      await packTestSkill(env.root, 'multi', { version: '2.1.0-beta.1', channel: 'beta' }),
      alice,
    );

    expect((await env.registry.resolve('multi')).version).toBe('2.0.0');
    expect((await env.registry.resolve('multi', { agent: 'cursor' })).version).toBe('1.4.2');
    expect((await env.registry.resolve('multi', { agent: 'claude-code' })).version).toBe('2.0.0');
    expect((await env.registry.resolve('multi', { range: '^1.0.0' })).version).toBe('1.4.2');
    expect((await env.registry.resolve('multi', { range: '~1.0.0' })).version).toBe('1.0.0');
    expect((await env.registry.resolve('multi', { channel: 'beta' })).version).toBe('2.1.0-beta.1');
    expect(
      (await env.registry.resolve('multi', { channel: 'beta', range: '^1.0.0' })).version,
    ).toBe('1.4.2');
    await expectApiError(env.registry.resolve('multi', { range: '>=3.0.0' }), 'NOT_FOUND', 404);
    await expectApiError(
      env.registry.resolve('multi', { range: 'nonsense range' }),
      'VALIDATION',
      400,
    );

    const info = await env.registry.getSkillInfo('multi');
    expect(info.latest?.version).toBe('2.0.0');
    expect(info.versions.map((v) => v.version)).toEqual([
      '2.1.0-beta.1',
      '2.0.0',
      '1.4.2',
      '1.0.0',
    ]);
  });

  it('admin can approve a quarantined version and rescan it', async () => {
    const bytes = await packTestSkill(env.root, 'needs-review', {
      files: { 'run.sh': DOWNLOAD_EXEC_SCRIPT },
    });
    await env.registry.publish(bytes, bob);
    const rescan = await env.registry.rescan('needs-review', '1.0.0');
    expect(rescan.outcome).toBe('block');
    await env.registry.setStatus('needs-review', '1.0.0', 'active', 'Reviewed: test fixture');
    expect((await env.registry.resolve('needs-review')).version).toBe('1.0.0');
  });

  it('filters search by agent and category', async () => {
    await env.registry.publish(
      await packTestSkill(env.root, 'codex-only', { targets: ['codex'], category: 'docs' }),
      alice,
    );
    const forCodex = await env.registry.search({ agent: 'codex', q: 'codex-only' });
    expect(forCodex.map((r) => r.slug)).toEqual(['codex-only']);
    expect(forCodex[0]?.agents).toEqual(['codex']);
    expect(await env.registry.search({ agent: 'cursor', q: 'codex-only' })).toEqual([]);
    expect((await env.registry.search({ category: 'docs' })).map((r) => r.slug)).toContain(
      'codex-only',
    );
    // LIKE wildcards in the query are treated literally.
    expect(await env.registry.search({ q: '%' })).toEqual([]);
  });
});

describe('publisher tokens', () => {
  it('authenticates only the exact token', async () => {
    const created = await env.registry.createPublisher('carol', false);
    expect((await env.registry.authenticatePublisher(created.token))?.id).toBe(created.id);
    expect(await env.registry.authenticatePublisher(`${created.token.slice(0, -1)}A`)).toBeNull();
    expect(await env.registry.authenticatePublisher('')).toBeNull();
    expect(await env.registry.authenticatePublisher(null)).toBeNull();
    await expectApiError(env.registry.createPublisher('carol', false), 'CONFLICT', 409);
  });
});
