/**
 * Lock v2 (trust features §3): strict schema, capability-block consistency, v1 migration,
 * refusal of newer versions, reserved fields and deterministic output.
 */
import { describe, expect, it } from 'vitest';
import {
  type AgentHubError,
  buildSkillPackage,
  capabilityDigest,
  emptyCapabilitySet,
  type LockEntry,
  normalizeCapabilitySet,
  parseLock,
  parseLockEntry,
  peekLockVersion,
  serializeLock,
  tokensOf,
} from '../src/index';
import { catchError, sampleFiles } from './helpers';

const FILE = '/repo/.agenthub/agenthub.lock';
const RULESET = `sha256:${'b'.repeat(64)}`;
const pkg = buildSkillPackage(sampleFiles(), { folderName: 'web-testing' });

function v1Entry(): Record<string, unknown> {
  return {
    version: '1.3.0',
    digest: pkg.digest,
    source: 'registry',
    registry: 'file:/r',
    installedTargets: ['claude-code'],
    paths: { '.claude/skills/web-testing': ['claude-code'] },
    files: pkg.fileHashes,
    installedAt: '2026-10-05T09:12:44.000Z',
  };
}

function v2Entry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const set = normalizeCapabilitySet({
    ...emptyCapabilitySet(),
    exec: ['npx'],
    network: ['*'],
    externals: [{ kind: 'npm', id: 'playwright', pin: 'unpinned', pinValue: null, role: 'run' }],
  });
  const digest = capabilityDigest(set);
  return {
    ...v1Entry(),
    capabilities: tokensOf(set),
    capabilityDigest: digest,
    rulesetDigest: RULESET,
    externals: set.externals,
    approval: {
      digest: pkg.digest,
      capabilityDigest: digest,
      rulesetDigest: RULESET,
      approvedAt: '2026-10-05T09:12:44Z',
      note: 'reviewed in PR 12',
    },
    ...extra,
  };
}

const text = (version: number, entry: Record<string, unknown>) =>
  JSON.stringify({ lockfileVersion: version, skills: { 'web-testing': entry } });

function issue(fn: () => unknown): AgentHubError {
  return catchError(fn);
}

describe('lock v2', () => {
  it('parses a v1 lock into the v2 shape without inventing anything', () => {
    const lock = parseLock(text(1, v1Entry()), FILE);
    expect(lock.lockfileVersion).toBe(2);
    const entry = lock.skills['web-testing'] as LockEntry;
    expect(entry.capabilities).toBeUndefined();
    expect(entry.approval).toBeUndefined();
    expect(peekLockVersion(text(1, v1Entry()))).toBe(1);
    // Upgraded on write.
    expect(serializeLock(lock)).toContain('"lockfileVersion": 2');
  });

  it('refuses v2 fields smuggled into a v1 lock', () => {
    expect(issue(() => parseLock(text(1, v2Entry()), FILE)).code).toBe('VALIDATION');
  });

  it('round-trips a full v2 entry, including reserved signer and quarantine, byte-identically', () => {
    const raw = text(
      2,
      v2Entry({ signer: { keyId: 'k1' }, quarantine: { reason: 'under review' } }),
    );
    const lock = parseLock(raw, FILE);
    const once = serializeLock(lock);
    expect(serializeLock(parseLock(once, FILE))).toBe(once);
    const entry = lock.skills['web-testing'] as LockEntry;
    expect(entry.quarantine).toEqual({ reason: 'under review' });
    expect(entry.signer).toEqual({ keyId: 'k1' });
    expect(entry.approval?.note).toBe('reviewed in PR 12');
    // Keys are sorted at every level.
    const parsed = JSON.parse(once).skills['web-testing'];
    expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
  });

  it('refuses a newer lockfileVersion with LOCK_TOO_NEW', () => {
    const error = issue(() => parseLock(text(3, v2Entry()), FILE));
    expect(error.code).toBe('VALIDATION');
    expect((error.details as { code?: string }).code).toBe('LOCK_TOO_NEW');
    expect(error.message).toContain('newer agenthub');
    for (const bad of [0, -1, 1.5, '2', null]) {
      const e = issue(() => parseLock(JSON.stringify({ lockfileVersion: bad, skills: {} }), FILE));
      expect((e.details as { code?: string }).code).toBeUndefined();
    }
  });

  it('rejects unknown keys instead of stripping them', () => {
    expect(issue(() => parseLock(text(2, v2Entry({ trusted: true })), FILE)).code).toBe(
      'VALIDATION',
    );
    const root = JSON.stringify({ lockfileVersion: 2, skills: {}, extra: 1 });
    expect(issue(() => parseLock(root, FILE)).code).toBe('VALIDATION');
  });

  it.each([
    ['a control character in the version', { version: '1.0.0\nVerified' }],
    ['a bad timestamp', { installedAt: 'yesterday' }],
    ['duplicate agents', { installedTargets: ['codex', 'codex'] }],
    ['an unknown agent', { installedTargets: ['evil'] }],
    [
      'an oversize token list',
      {
        capabilities: {
          ...tokensOf(emptyCapabilitySet()),
          exec: Array.from({ length: 1025 }, (_, i) => `t${i}`),
        },
      },
    ],
    [
      'a token with a space',
      { capabilities: { ...tokensOf(emptyCapabilitySet()), exec: ['rm -rf'] } },
    ],
    ['a missing capability key', { capabilities: { exec: [] } }],
    [
      'a bad external kind',
      { externals: [{ kind: 'ftp', id: 'x', pin: 'unpinned', pinValue: null, role: 'run' }] },
    ],
    [
      'a bad fsWrite scope',
      { capabilities: { ...tokensOf(emptyCapabilitySet()), fsWrite: ['root'] } },
    ],
    ['a __proto__ key in quarantine', { quarantine: JSON.parse('{"__proto__": "x"}') }],
    [
      'too many reserved keys',
      { signer: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 'v'])) },
    ],
    [
      'a multi-line approval note',
      { approval: { ...(v2Entry().approval as object), note: 'a\nb' } },
    ],
    [
      'an approval with a bad digest',
      { approval: { ...(v2Entry().approval as object), digest: 'sha256:xyz' } },
    ],
    ['a traversal in files', { files: { '../x': `sha256:${'0'.repeat(64)}` } }],
  ])('rejects %s', (_label, patch) => {
    expect(issue(() => parseLock(text(2, v2Entry(patch)), FILE)).code).toBe('VALIDATION');
  });

  it('detects an edited capability block (LOCK_INCONSISTENT)', () => {
    const forged = v2Entry();
    (forged.capabilities as { network: string[] }).network = ['*', 'evil.invalid'];
    const error = issue(() => parseLock(text(2, forged), FILE));
    expect((error.details as { code?: string }).code).toBe('LOCK_INCONSISTENT');
  });

  it('requires the capability block to be complete, and an approval to have one', () => {
    const partial = v2Entry();
    delete partial.externals;
    expect((issue(() => parseLock(text(2, partial), FILE)).details as { code?: string }).code).toBe(
      'LOCK_INCONSISTENT',
    );
    const orphan = { ...v1Entry(), approval: v2Entry().approval };
    expect(issue(() => parseLock(text(2, orphan), FILE)).code).toBe('VALIDATION');
  });

  it('normalizes token order on read without changing the digest', () => {
    const entry = v2Entry();
    (entry.capabilities as { exec: string[] }).exec = ['npx', 'node'];
    const set = normalizeCapabilitySet({
      ...(entry.capabilities as object),
      externals: entry.externals as never,
    });
    entry.capabilityDigest = capabilityDigest(set);
    (entry.approval as { capabilityDigest: string }).capabilityDigest =
      entry.capabilityDigest as string;
    const parsed = parseLock(text(2, entry), FILE).skills['web-testing'] as LockEntry;
    expect(parsed.capabilities?.exec).toEqual(['node', 'npx']);
  });

  it('snapshot and journal entries use the same v2 entry schema (v1-era entries stay valid)', () => {
    expect(parseLockEntry(v1Entry(), 'entry.json', 'web-testing').capabilityDigest).toBeUndefined();
    expect(parseLockEntry(v2Entry(), 'entry.json', 'web-testing').approval?.digest).toBe(
      pkg.digest,
    );
    expect(issue(() => parseLockEntry({ ...v2Entry(), extra: 1 }, 'entry.json')).code).toBe(
      'VALIDATION',
    );
  });
});
