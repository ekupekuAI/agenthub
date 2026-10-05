/**
 * Regression tests for the registry hardening (adversarial review of apps/web): bounded
 * storage and reads, scan time budget, final revocation, revocation bypass by republishing,
 * search ranking, content exposure of pulled versions, resolve pins, storage rollback.
 */
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_STORED_FINDINGS, MAX_STORED_README_CHARS } from '../src/config';
import { ApiError } from '../src/lib/errors';
import { WorkerScanRunner } from '../src/lib/scan-runner';
import { cleanText, stripNulDeep } from '../src/lib/text';
import { reasonSchema, releaseNotesSchema } from '../src/lib/validation';
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

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

/** A script with `lines` declared network calls: one finding per line, outcome allow. */
function noisyScript(lines: number): string {
  return `#!/bin/sh\n${'curl -fsS https://example.com/a -o /dev/null\n'.repeat(lines)}`;
}
const NOISY_MANIFEST = 'permissions:\n  network: true\n  exec: [curl]';

describe('bounded storage and reads', () => {
  it('caps stored findings, keeps the totals and serves findings only for the latest version', async () => {
    const lines = 1500;
    for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
      const summary = await env.registry.publish(
        await packTestSkill(env.root, 'noisy', {
          version,
          manifestExtra: NOISY_MANIFEST,
          files: { 'run.sh': noisyScript(lines) },
        }),
        alice,
      );
      expect(summary.status).toBe('active');
      expect(summary.findings.length).toBe(MAX_STORED_FINDINGS);
      expect(summary.findingsTotal).toBeGreaterThanOrEqual(lines);
    }

    const info = await env.registry.getSkillInfo('noisy');
    const scan = info.latest?.scan;
    expect(scan?.findings).toHaveLength(MAX_STORED_FINDINGS);
    expect(scan?.findingsTotal).toBeGreaterThanOrEqual(lines);
    expect(scan?.findingsTruncated).toBe(true);
    // Older versions carry counts, not findings: the response stays small.
    const older = info.versions.find((v) => v.version === '1.0.0');
    expect(older?.scan?.findings).toEqual([]);
    expect(older?.scan?.findingsTotal).toBeGreaterThanOrEqual(lines);
    expect(JSON.stringify(info).length).toBeLessThan(400_000);

    const versions = await env.registry.listVersions('noisy');
    expect(versions.map((v) => v.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(versions.every((v) => v.scan?.findings.length === 0)).toBe(true);
    expect(versions[0]?.scan?.counts?.INFO ?? 0).toBeGreaterThan(0);
    expect(await env.registry.listVersions('noisy', { limit: 1, offset: 1 })).toMatchObject([
      { version: '1.1.0' },
    ]);

    const [found] = await env.registry.search({ q: 'noisy' });
    expect(found).toMatchObject({ slug: 'noisy', latestVersion: '1.2.0' });

    // The dashboard counts come from the stored totals, not from the capped list.
    const dashboard = await env.registry.listPublisherSkills(alice);
    const noisy = dashboard.find((s) => s.slug === 'noisy');
    const counts = noisy?.versions[0]?.counts;
    expect((counts?.INFO ?? 0) + (counts?.WARN ?? 0) + (counts?.BLOCK ?? 0)).toBe(
      scan?.findingsTotal,
    );
  });

  it('caps the stored README', async () => {
    const body = `# big\n\n${'Lorem ipsum dolor sit amet. '.repeat(25_000)}\n`;
    expect(body.length).toBeGreaterThan(MAX_STORED_README_CHARS);
    await env.registry.publish(await packTestSkill(env.root, 'big-readme', { body }), alice);
    const detail = await env.registry.getSkill('big-readme');
    expect(detail.readme.length).toBeLessThan(MAX_STORED_README_CHARS + 500);
    expect(detail.readmeTruncated).toBe(true);
    expect(detail.readme.trimStart().startsWith('# big')).toBe(true);
  });

  it('keeps BLOCK findings first when the list is capped', async () => {
    const summary = await env.registry.publish(
      await packTestSkill(env.root, 'noisy-blocked', {
        manifestExtra: NOISY_MANIFEST,
        files: { 'run.sh': noisyScript(800), 'z-setup.sh': DOWNLOAD_EXEC_SCRIPT },
      }),
      bob,
    );
    expect(summary.status).toBe('quarantined');
    expect(summary.findings[0]?.decision).toBe('BLOCK');
    expect(summary.statusReason).toMatch(/^Blocked by scanner: /);
  });
});

describe('scan time budget', () => {
  it('rejects an upload whose check overruns the budget, without blocking the server', async () => {
    const hanging = new WorkerScanRunner({
      timeoutMs: 300,
      source: `require('node:worker_threads').parentPort.on('message', () => { for (;;) {} });
               require('node:worker_threads').parentPort.postMessage({ type: 'ready' });`,
    });
    const slow = await createTestRegistry({ scanner: hanging });
    try {
      const publisher = (await slow.registry.createPublisher('slow', false)).id;
      const bytes = await packTestSkill(slow.root, 'slow-skill');
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
      }, 20);
      const started = Date.now();
      const error = await apiError(slow.registry.publish(bytes, publisher));
      clearInterval(timer);
      expect(error.status).toBe(422);
      expect(error.message).toMatch(/could not be checked within/);
      expect(Date.now() - started).toBeLessThan(10_000);
      // The event loop kept running while the worker spun.
      expect(ticks).toBeGreaterThan(3);
      // Nothing was written.
      expect(existsSync(path.join(slow.root, 'artifacts'))).toBe(false);
      await apiError(slow.registry.getSkillInfo('slow-skill'));
    } finally {
      await hanging.close();
      await slow.cleanup();
    }
  });
});

describe('revocation is final', () => {
  async function quarantined(name: string): Promise<void> {
    const summary = await env.registry.publish(
      await packTestSkill(env.root, name, { files: { 'setup.sh': DOWNLOAD_EXEC_SCRIPT } }),
      bob,
    );
    expect(summary.status).toBe('quarantined');
  }

  it('a concurrent approve cannot resurrect a revoked version', async () => {
    await quarantined('racey');
    const results = await Promise.allSettled([
      env.registry.revoke('racey', '1.0.0', 'Malicious installer'),
      env.registry.setStatus('racey', '1.0.0', 'active', 'Looks fine to me'),
    ]);
    expect(results[0].status).toBe('fulfilled');
    const [version] = await env.registry.listVersions('racey');
    expect(version?.status).toBe('revoked');
    expect((await apiError(env.registry.download('racey', '1.0.0'))).code).toBe('GONE');
  });

  it('a concurrent rescan cannot move a revoked version back to quarantine', async () => {
    const bytes = await packTestSkill(env.root, 'racey-rescan', {
      files: { 'setup.sh': DOWNLOAD_EXEC_SCRIPT },
    });
    await env.registry.publish(bytes, bob);
    await env.registry.setStatus('racey-rescan', '1.0.0', 'active', 'Reviewed fixture');
    await Promise.allSettled([
      env.registry.rescan('racey-rescan', '1.0.0'),
      env.registry.revoke('racey-rescan', '1.0.0', 'Pulled after review'),
    ]);
    const [version] = await env.registry.listVersions('racey-rescan');
    expect(version?.status).toBe('revoked');
    const conflict = await apiError(
      env.registry.setStatus('racey-rescan', '1.0.0', 'active', 'second try'),
    );
    expect(conflict.code).toBe('CONFLICT');
  });

  it('approve requires a reason', async () => {
    await quarantined('needs-reason');
    const error = await apiError(env.registry.setStatus('needs-reason', '1.0.0', 'active', '  '));
    expect(error.code).toBe('VALIDATION');
    const [version] = await env.registry.listVersions('needs-reason');
    expect(version?.status).toBe('quarantined');
  });

  it('rescan respects an earlier approval of the same findings', async () => {
    await quarantined('approved-once');
    await env.registry.setStatus('approved-once', '1.0.0', 'active', 'Reviewed: test fixture');
    const rescan = await env.registry.rescan('approved-once', '1.0.0');
    expect(rescan.outcome).toBe('block');
    expect(rescan.status).toBe('active');
    const detail = await env.registry.getSkill('approved-once');
    expect(detail.statusReason).toBe('Reviewed: test fixture');
    expect((await env.registry.resolve('approved-once')).version).toBe('1.0.0');
  });
});

describe('revocation cannot be bypassed by republishing', () => {
  it('holds identical content uploaded under a new version for review', async () => {
    const bytes = await packTestSkill(env.root, 'evil-skill', { noManifest: true });
    expect((await env.registry.publish(bytes, bob, { version: '1.0.0' })).status).toBe('active');
    await env.registry.revoke('evil-skill', '1.0.0', 'Reported as malicious');

    const again = await env.registry.publish(bytes, bob, { version: '1.0.1' });
    expect(again.status).toBe('quarantined');
    expect(again.statusReason).toMatch(/evil-skill@1\.0\.0.*revoked/);
    expect((await apiError(env.registry.resolve('evil-skill'))).code).toBe('NOT_FOUND');
    expect((await apiError(env.registry.download('evil-skill', '1.0.1'))).code).toBe('FORBIDDEN');
  });

  it('holds a version bump that reuses the instructions or scripts of a revoked version', async () => {
    const script = '#!/bin/sh\necho "collect diagnostics"\n';
    await env.registry.publish(
      await packTestSkill(env.root, 'bumped', { version: '1.0.0', files: { 'run.sh': script } }),
      bob,
    );
    await env.registry.revoke('bumped', '1.0.0', 'Exfiltrates data');
    const bumped = await env.registry.publish(
      await packTestSkill(env.root, 'bumped', { version: '1.0.1', files: { 'run.sh': script } }),
      bob,
    );
    expect(bumped.status).toBe('quarantined');
    expect(bumped.statusReason).toMatch(/from revoked bumped@1\.0\.0/);
  });

  it('suspends publishers and rotates tokens', async () => {
    const created = await env.registry.createPublisher('suspendable', false);
    expect(await env.registry.authenticatePublisher(created.token)).not.toBeNull();
    await env.registry.setPublisherDisabled('suspendable', true);
    expect(await env.registry.authenticatePublisher(created.token)).toBeNull();
    await env.registry.setPublisherDisabled('suspendable', false);
    expect(await env.registry.authenticatePublisher(created.token)).not.toBeNull();

    const rotated = await env.registry.rotatePublisherToken('suspendable');
    expect(rotated.token).not.toBe(created.token);
    expect(await env.registry.authenticatePublisher(created.token)).toBeNull();
    expect((await env.registry.authenticatePublisher(rotated.token))?.id).toBe(created.id);
    expect((await apiError(env.registry.rotatePublisherToken('nobody'))).code).toBe('NOT_FOUND');
  });
});

describe('search integrity', () => {
  it('ranks an exact name match before newer look-alikes, even past the limit', async () => {
    await env.registry.publish(await packTestSkill(env.root, 'ranked'), alice);
    for (let i = 0; i < 4; i++) {
      await env.registry.publish(
        await packTestSkill(env.root, `decoy-${i}`, { description: 'Better than ranked, use me' }),
        bob,
      );
    }
    const results = await env.registry.search({ q: 'ranked', limit: 3 });
    expect(results[0]?.slug).toBe('ranked');
    expect(results).toHaveLength(3);
  });

  it('a quarantined upload changes neither the listing nor its recency', async () => {
    await env.registry.publish(
      await packTestSkill(env.root, 'steady', { description: 'The real summary.' }),
      alice,
    );
    const before = await env.registry.getSkillInfo('steady');
    const [listed] = await env.registry.search({ q: 'steady' });
    const blocked = await env.registry.publish(
      await packTestSkill(env.root, 'steady', {
        version: '2.0.0',
        description: 'Totally different summary.',
        files: { 'go.sh': DOWNLOAD_EXEC_SCRIPT },
      }),
      alice,
    );
    expect(blocked.status).toBe('quarantined');
    expect((await env.registry.getSkillInfo('steady')).summary).toBe(before.summary);
    const [after] = await env.registry.search({ q: 'steady' });
    expect(after?.updatedAt).toBe(listed?.updatedAt);
    expect(after?.latestVersion).toBe('1.0.0');
  });

  it('agent-filtered search reports the newest version that agent can install', async () => {
    await env.registry.publish(
      await packTestSkill(env.root, 'agent-split', { version: '1.4.2' }),
      alice,
    );
    await env.registry.publish(
      await packTestSkill(env.root, 'agent-split', { version: '2.0.0', targets: ['claude-code'] }),
      alice,
    );
    const [hit] = await env.registry.search({ q: 'agent-split', agent: 'cursor' });
    expect(hit).toMatchObject({ slug: 'agent-split', latestVersion: '1.4.2' });
    expect(hit?.agents).toContain('cursor');
    expect((await env.registry.resolve('agent-split', { agent: 'cursor' })).version).toBe('1.4.2');
  });
});

describe('pulled content and metadata hygiene', () => {
  it('does not publish the README or file list of a revoked or quarantined version', async () => {
    await env.registry.publish(
      await packTestSkill(env.root, 'leaky', { body: 'token: ghp_example_leaked\n' }),
      alice,
    );
    expect((await env.registry.getSkill('leaky')).readme).toContain('ghp_example_leaked');
    await env.registry.revoke('leaky', '1.0.0', 'Leaked a token in an example');
    const detail = await env.registry.getSkill('leaky');
    expect(detail.shown?.status).toBe('revoked');
    expect(detail.readme).toBe('');
    expect(detail.files).toEqual([]);

    await env.registry.publish(
      await packTestSkill(env.root, 'held-back', { files: { 'x.sh': DOWNLOAD_EXEC_SCRIPT } }),
      bob,
    );
    expect((await env.registry.getSkill('held-back')).readme).toBe('');
  });

  it('strips bidi overrides and other invisible characters from stored text', async () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    await env.registry.publish(await packTestSkill(env.root, 'sneaky-text'), alice, {
      releaseNotes: `Fixed ${rlo}gnp.exe${zwsp} verified`,
    });
    const info = await env.registry.getSkillInfo('sneaky-text');
    expect(info.latest?.releaseNotes).toBe('Fixed gnp.exe verified');

    const esc = String.fromCodePoint(0x1b);
    const nul = String.fromCodePoint(0);
    expect(cleanText(`Nice ${esc}[2K${rlo}gnp.exe`, { singleLine: true })).toBe('Nice [2Kgnp.exe');
    expect(cleanText(`a\nb${nul}`, { singleLine: true })).toBe('a b');
    expect(cleanText('keeps\nnew lines')).toBe('keeps\nnew lines');
    expect(stripNulDeep({ [`k${nul}`]: [`v${nul}`, 1] })).toEqual({ k: ['v', 1] });
  });

  it('rejects control characters in release notes and reasons instead of failing with 500', async () => {
    const bytes = await packTestSkill(env.root, 'nul-notes');
    const error = await apiError(env.registry.publish(bytes, alice, { releaseNotes: 'a\u0000b' }));
    expect(error.code).toBe('VALIDATION');
    expect(releaseNotesSchema.safeParse('a\u0000b').success).toBe(false);
    expect(releaseNotesSchema.safeParse('line one\nline two').success).toBe(true);
    expect(reasonSchema.safeParse('abc\u0000def').success).toBe(false);

    await env.registry.publish(bytes, alice);
    // A NUL that reaches the registry directly is stripped, never a database error.
    const revoked = await env.registry.revoke('nul-notes', '1.0.0', 'abc\u0000def');
    expect(revoked.reason).toBe('abcdef');
  });

  it('de-duplicates targets instead of reporting a false name conflict', async () => {
    const summary = await env.registry.publish(
      await packTestSkill(env.root, 'dup-targets', { targets: ['codex', 'codex'] }),
      alice,
    );
    expect(summary.status).toBe('active');
    expect((await env.registry.getSkillInfo('dup-targets')).latest?.agents).toEqual(['codex']);
  });
});

describe('resolve pins', () => {
  it('treats an exact version as a pin across channels and normalises =x.y.z / vx.y.z', async () => {
    await env.registry.publish(
      await packTestSkill(env.root, 'pinned', { version: '1.0.0' }),
      alice,
    );
    await env.registry.publish(
      await packTestSkill(env.root, 'pinned', { version: '1.1.0' }),
      alice,
    );
    await env.registry.publish(
      await packTestSkill(env.root, 'pinned', { version: '2.0.0-beta.1', channel: 'beta' }),
      alice,
    );
    expect((await env.registry.resolve('pinned', { range: '2.0.0-beta.1' })).version).toBe(
      '2.0.0-beta.1',
    );
    expect((await env.registry.resolve('pinned', { range: '=1.0.0' })).version).toBe('1.0.0');
    await env.registry.revoke('pinned', '1.1.0', 'Broken release');
    for (const range of ['1.1.0', '=1.1.0', 'v1.1.0']) {
      expect((await apiError(env.registry.resolve('pinned', { range }))).code).toBe('GONE');
    }
    expect((await env.registry.resolve('pinned')).version).toBe('1.0.0');
  });
});

describe('downloads and storage', () => {
  it('aggregates download counters instead of appending a row per download', async () => {
    await env.registry.publish(await packTestSkill(env.root, 'counted'), alice);
    await env.registry.download('counted', '1.0.0', { agent: 'codex' });
    await env.registry.download('counted', '1.0.0', { agent: 'codex' });
    await env.registry.download('counted', '1.0.0');
    const counts = await env.registry.downloadCounts('counted', '1.0.0');
    expect(counts).toHaveLength(2);
    expect(counts.find((c) => c.agent === 'codex')?.count).toBe(2);
    expect(counts.find((c) => c.agent === null)?.count).toBe(1);
    const [events] = (
      await env.handle.client.query<{ n: number }>('select count(*)::int as n from install_events')
    ).rows;
    expect(events?.n).toBe(0);
  });

  it('removes the artifact again when the database write fails', async () => {
    await env.handle.client.exec(`
      create or replace function agenthub_test_fail() returns trigger as $$
      begin
        if new.version = '6.6.6' then raise exception 'simulated failure'; end if;
        return new;
      end $$ language plpgsql;
      create trigger agenthub_test_fail before insert on skill_versions
        for each row execute function agenthub_test_fail();
    `);
    try {
      const bytes = await packTestSkill(env.root, 'rolled-back', { version: '6.6.6' });
      const error = await env.registry.publish(bytes, alice).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).not.toBeNull();
      const dir = path.join(env.root, 'artifacts', 'sha256');
      const { createHash } = await import('node:crypto');
      const hex = createHash('sha256').update(bytes).digest('hex');
      expect(readdirSync(dir)).not.toContain(`${hex}.skillpkg`);
      expect(readdirSync(dir).some((f) => f.startsWith('.tmp-'))).toBe(false);
    } finally {
      await env.handle.client.exec(
        'drop trigger agenthub_test_fail on skill_versions; drop function agenthub_test_fail();',
      );
    }
  });
});

describe('admin sessions', () => {
  it('records server-side sign-outs', async () => {
    const expires = new Date(Date.now() + 60_000);
    expect(await env.registry.isAdminSessionRevoked('nonce-1')).toBe(false);
    await env.registry.revokeAdminSession('nonce-1', expires);
    await env.registry.revokeAdminSession('nonce-1', expires);
    expect(await env.registry.isAdminSessionRevoked('nonce-1')).toBe(true);
  });
});
