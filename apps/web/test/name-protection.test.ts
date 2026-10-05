import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors';
import { createTestRegistry, DOWNLOAD_EXEC_SCRIPT, packTestSkill, type TestEnv } from './helpers';

let env: TestEnv;
let owner: string;
let other: string;
let verified: string;

beforeAll(async () => {
  env = await createTestRegistry();
  owner = (await env.registry.createPublisher('name-owner', false)).id;
  other = (await env.registry.createPublisher('name-squatter', false)).id;
  verified = (await env.registry.createPublisher('name-verified', true)).id;
  // The legitimate names, published first.
  await env.registry.publish(await packTestSkill(env.root, 'web-testing'), owner);
  await env.registry.publish(await packTestSkill(env.root, 'git-commit-helper'), owner);
  await env.registry.publish(await packTestSkill(env.root, 'docker-compose-lint'), owner);
}, 60_000);

afterAll(async () => {
  await env?.cleanup();
});

async function publish(name: string, publisherId: string, version = '1.0.0', description?: string) {
  return env.registry.publish(
    await packTestSkill(env.root, name, { version, description }),
    publisherId,
  );
}

describe('reserved names', () => {
  it('holds a reserved name, even for a verified publisher', async () => {
    const summary = await publish('agenthub', verified);
    expect(summary.status).toBe('quarantined');
    expect(summary.statusReason).toBe('name-review: reserved name');
    expect(summary.nameReview).toEqual({ status: 'held', reason: 'name-review: reserved name' });
    const info = await env.registry.getSkillInfo('agenthub');
    expect(info.nameReview).toEqual({ status: 'held', reason: 'name-review: reserved name' });
  });

  it('holds affixed vendor names', async () => {
    expect((await publish('claude-code-cli', other)).status).toBe('quarantined');
  });
});

describe('lookalikes across publishers', () => {
  it.each([
    ['web-testlng', 'web-testing'],
    ['web-testing-cli', 'web-testing'],
    ['webtesting', 'web-testing'],
    ['testing-web', 'web-testing'],
    ['d0cker-compose-lint', 'docker-compose-lint'],
    ['git-cornmit-helper', 'git-commit-helper'],
  ])('%s by another publisher is held as a lookalike of %s', async (name, target) => {
    const summary = await publish(name, other);
    expect(summary.status).toBe('quarantined');
    expect(summary.statusReason).toBe(`name-review: looks like ${target}`);
  });

  it('allows the same publisher to grow its family of names', async () => {
    for (const name of ['web-testing-skill', 'web-tester', 'web-testing-js']) {
      const summary = await publish(name, owner);
      expect(summary.status).toBe('active');
      expect(summary.nameReview).toEqual({ status: 'clear' });
    }
  });

  it('does not hold a clearly different name', async () => {
    const summary = await publish('api-docs-writer', other);
    expect(summary.status).toBe('active');
    const results = await env.registry.search({ q: 'api-docs-writer' });
    expect(results[0]).toMatchObject({
      slug: 'api-docs-writer',
      publisher: { name: 'name-squatter', verified: false },
      nameReview: { status: 'clear' },
    });
    expect(Date.parse(results[0]?.firstPublishedAt ?? '')).not.toBeNaN();
  });

  it('keeps holding later versions of a held name and joins scanner reasons', async () => {
    const summary = await env.registry.publish(
      await packTestSkill(env.root, 'web-testlng', {
        version: '1.0.1',
        files: { 'scripts/install.sh': DOWNLOAD_EXEC_SCRIPT },
      }),
      other,
    );
    expect(summary.status).toBe('quarantined');
    expect(summary.statusReason).toMatch(
      /^Blocked by scanner: .+; name-review: looks like web-testing$/,
    );
  });

  it('lists the hold in the admin queue with the colliding name', async () => {
    const queue = await env.registry.listByStatus('quarantined');
    const item = queue.find((q) => q.slug === 'web-testlng' && q.version === '1.0.0');
    expect(item?.nameReview).toEqual({
      status: 'held',
      reason: 'name-review: looks like web-testing',
      conflict: 'web-testing',
    });
  });

  it('admin approval releases the hold for later versions', async () => {
    await publish('webb-testing', other);
    await env.registry.setStatus('webb-testing', '1.0.0', 'active', 'Different project, checked.');
    const info = await env.registry.getSkillInfo('webb-testing');
    expect(info.nameReview).toEqual({ status: 'clear' });
    expect(info.latest?.version).toBe('1.0.0');
    const next = await publish('webb-testing', other, '1.1.0');
    expect(next.status).toBe('active');
  });

  it('approval requires a reason', async () => {
    const error = await env.registry
      .setStatus('testing-web', '1.0.0', 'active', ' ')
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('VALIDATION');
  });
});

describe('tombstones', () => {
  it('retires a name once every version is revoked', async () => {
    await publish('retired-skill', owner, '1.0.0');
    await publish('retired-skill', owner, '1.1.0');
    await env.registry.revoke('retired-skill', '1.0.0', 'Withdrawn by moderator.');
    const tomb = await env.handle.client.query<{ slug: string }>(
      "select slug from name_tombstones where slug = 'retired-skill'",
    );
    expect(tomb.rows).toHaveLength(0);
    await env.registry.revoke('retired-skill', '1.1.0', 'Withdrawn by moderator.');
    const after = await env.handle.client.query<{ slug: string; reason: string }>(
      "select slug, reason from name_tombstones where slug = 'retired-skill'",
    );
    expect(after.rows).toEqual([{ slug: 'retired-skill', reason: 'Withdrawn by moderator.' }]);
  });

  it('refuses a retired name to another publisher', async () => {
    const error = await publish('retired-skill', other, '2.0.0').catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('CONFLICT');
    expect((error as ApiError).message).toMatch(/retired/);
  });

  it('lets the original publisher publish a new version (still scanned)', async () => {
    // New instructions: reusing a revoked SKILL.md byte for byte would be held anyway.
    const clean = await publish('retired-skill', owner, '2.0.0', 'A rewritten skill.');
    expect(clean.status).toBe('active');
    const blocked = await env.registry.publish(
      await packTestSkill(env.root, 'retired-skill', {
        version: '2.1.0',
        files: { 'scripts/install.sh': DOWNLOAD_EXEC_SCRIPT },
      }),
      owner,
    );
    expect(blocked.status).toBe('quarantined');
    expect(blocked.statusReason).toMatch(/^Blocked by scanner/);
  });
});
