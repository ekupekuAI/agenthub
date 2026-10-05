/**
 * Capability model (trust features §1–§2): derivation, canonical digest, delta semantics.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_KEYS,
  type CapabilitySet,
  canonicalCapabilities,
  capabilityDigest,
  capToken,
  deriveCapabilities,
  diffCapabilities,
  type EvaluatedFinding,
  type ExternalRef,
  emptyCapabilitySet,
  expansionTokens,
  type FindingCategory,
  hostCovered,
  intersectCapabilities,
  isValidToken,
  normalizeCapabilitySet,
  normalizeHost,
  type SkillManifest,
  secretCovered,
  summarizeFileChanges,
} from '../src/index';

const RULESET = `sha256:${'a'.repeat(64)}`;

function finding(
  category: FindingCategory,
  subject: string | undefined,
  extra: Partial<EvaluatedFinding> = {},
): EvaluatedFinding {
  return {
    ruleId: `rule.${category}`,
    category,
    severity: 'medium',
    declarable: true,
    file: 'scripts/run.sh',
    line: 1,
    evidence: 'x',
    message: 'm',
    declared: false,
    decision: 'WARN',
    ...(subject === undefined ? {} : { subject }),
    ...extra,
  };
}

function set(partial: Partial<CapabilitySet>): CapabilitySet {
  return normalizeCapabilitySet({ ...emptyCapabilitySet(), ...partial });
}

function ext(partial: Partial<ExternalRef> & Pick<ExternalRef, 'id'>): ExternalRef {
  return { kind: 'npm', pin: 'unpinned', pinValue: null, role: 'run', ...partial };
}

describe('deriveCapabilities', () => {
  it.each([
    ['exec', 'NPX', 'exec', ['npx']],
    ['network', 'API.Example.invalid', 'network', ['api.example.invalid']],
    ['download-exec', 'x.invalid', 'markers', ['download-exec']],
    ['secrets', '~/.aws/credentials', 'secrets', ['.aws/credentials']],
    ['env', 'GITHUB_TOKEN', 'env', ['GITHUB_TOKEN']],
    ['dynamic', 'eval', 'dynamic', ['eval']],
    ['obfuscation', 'encoded-blob', 'markers', ['obfuscation:encoded-blob']],
    ['persistence', '~/.bashrc', 'markers', ['persistence:~/.bashrc']],
    ['hidden', 'unicode-tags', 'markers', ['hidden:unicode-tags']],
    ['deps', 'pip', 'installers', ['pip']],
    ['prompt', 'override', 'prompt', ['override']],
    ['binary', 'elf', 'binaries', ['elf']],
    ['remote-instructions', 'rules.invalid', 'network', ['rules.invalid']],
  ] as const)('%s with subject %s → %s %j', (category, subject, key, tokens) => {
    const report = deriveCapabilities([finding(category, subject)], null, [], RULESET);
    for (const token of tokens) expect(report.set[key]).toContain(token);
  });

  it('a missing subject becomes *; download-exec also adds the host; untrusted dynamic code is a marker', () => {
    const report = deriveCapabilities(
      [
        finding('exec', undefined),
        finding('download-exec', 'dl.invalid', { declarable: false }),
        finding('dynamic', 'eval', { declarable: false }),
      ],
      null,
      [],
      RULESET,
    );
    expect(report.set.exec).toEqual(['*']);
    expect(report.set.network).toEqual(['dl.invalid']);
    expect(report.set.markers).toEqual(['download-exec', 'dynamic-untrusted']);
  });

  it('maps declarations: network true → *, hosts → *.host, exec/env/secrets/fs.write', () => {
    const manifest: SkillManifest = {
      schema: 1,
      version: '1.0.0',
      permissions: {
        network: ['API.example.invalid', '*.cdn.invalid'],
        exec: ['Node'],
        env: ['HOME_DIR'],
        secrets: ['~/.npmrc'],
        fs: { write: ['project', 'temp'] },
      },
    };
    const report = deriveCapabilities([], manifest, [], RULESET);
    expect(report.set.network).toEqual(['*.api.example.invalid', '*.cdn.invalid']);
    expect(report.set.exec).toEqual(['node']);
    expect(report.set.env).toEqual(['HOME_DIR']);
    expect(report.set.secrets).toEqual(['.npmrc']);
    expect(report.set.fsWrite).toEqual(['project', 'temp']);
    expect(report.unobserved).toEqual([
      'env:HOME_DIR',
      'exec:node',
      'network:*.api.example.invalid',
      'network:*.cdn.invalid',
      'secrets:.npmrc',
    ]);
    const all = deriveCapabilities(
      [],
      { schema: 1, version: '1.0.0', permissions: { network: true } },
      [],
      RULESET,
    );
    expect(all.set.network).toEqual(['*']);
  });

  it('lists undeclared observations and keeps them out of the digest', () => {
    const declared = finding('network', 'x.invalid', { declared: true, decision: 'INFO' });
    const undeclared = finding('network', 'x.invalid');
    const a = deriveCapabilities([declared], null, [], RULESET);
    const b = deriveCapabilities([undeclared], null, [], RULESET);
    expect(a.undeclared).toEqual([]);
    expect(b.undeclared).toEqual(['network:x.invalid']);
    expect(a.digest).toBe(b.digest);
  });

  it('adds the hosts of fetched, installed and run externals to network, not of references', () => {
    const report = deriveCapabilities(
      [],
      null,
      [
        ext({ kind: 'url', id: 'https://a.invalid/x', host: 'a.invalid', role: 'fetch' }),
        ext({ kind: 'url', id: 'https://b.invalid', host: 'b.invalid', role: 'reference' }),
        ext({ kind: 'git', id: 'g.invalid/o/r', host: 'g.invalid', role: 'install' }),
      ],
      RULESET,
    );
    expect(report.set.network).toEqual(['a.invalid', 'g.invalid']);
    expect(report.set.externals).toHaveLength(3);
  });

  it('only category, subject and declarable count: order, file, line and evidence do not', () => {
    const findings = [
      finding('exec', 'npx'),
      finding('network', 'a.invalid'),
      finding('env', 'TOKEN'),
    ];
    const moved = findings
      .map((f, i) => ({
        ...f,
        file: `other/${i}.py`,
        line: 99 - i,
        evidence: 'changed',
        message: 'other',
      }))
      .reverse();
    const a = deriveCapabilities(findings, null, [], RULESET);
    const b = deriveCapabilities(moved, null, [], RULESET);
    expect(b.digest).toBe(a.digest);
    expect(b.set).toEqual(a.set);
  });
});

describe('canonical form and digest', () => {
  it('is independent of input order and duplicates, and pinned to a golden value', () => {
    const a = set({
      exec: ['npx', 'node', 'npx'],
      network: ['b.invalid', 'a.invalid'],
      externals: [ext({ id: 'zod' }), ext({ id: 'ajv', pin: 'version', pinValue: '8.0.0' })],
    });
    const b = set({
      network: ['a.invalid', 'b.invalid'],
      exec: ['node', 'npx'],
      externals: [ext({ id: 'ajv', pin: 'version', pinValue: '8.0.0' }), ext({ id: 'zod' })],
    });
    expect(canonicalCapabilities(a)).toBe(canonicalCapabilities(b));
    expect(capabilityDigest(a)).toBe(capabilityDigest(b));
    expect(canonicalCapabilities(a)).toBe(
      '{"binaries":[],"dynamic":[],"env":[],"exec":["node","npx"],"externals":[{"id":"ajv","kind":"npm","pin":"version","pinValue":"8.0.0","role":"run"},{"id":"zod","kind":"npm","pin":"unpinned","pinValue":null,"role":"run"}],"fsWrite":[],"installers":[],"markers":[],"network":["a.invalid","b.invalid"],"prompt":[],"schema":1,"secrets":[]}',
    );
    expect(capabilityDigest(emptyCapabilitySet())).toBe(capabilityDigest(set({})));
    expect(capabilityDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('merges the same external with the highest role', () => {
    const merged = set({
      externals: [ext({ id: 'x', role: 'reference' }), ext({ id: 'x', role: 'install' })],
    });
    expect(merged.externals).toEqual([ext({ id: 'x', role: 'install' })]);
  });

  it('capToken makes every subject a valid lock token', () => {
    expect(capToken('a b\tc')).toBe('a_b_c');
    expect(capToken('\u001b[31mred‮')).toBe('[31mred');
    expect(capToken('   ')).toBe('*');
    const long = capToken('x'.repeat(1000));
    expect(long.length).toBe(256);
    expect(long).not.toBe(capToken(`${'x'.repeat(999)}y`));
    for (const value of ['a b', '\u0000', 'é', 'x'.repeat(300)])
      expect(isValidToken(capToken(value))).toBe(true);
  });

  it('host and secret helpers keep the policy semantics', () => {
    expect(normalizeHost('https://API.Example.invalid:443/x')).toBe('api.example.invalid');
    expect(normalizeHost('*.example.invalid.')).toBe('example.invalid');
    expect(normalizeHost('bücher.example')).toBe('xn--bcher-kva.example');
    expect(hostCovered('a.b.example.invalid', '*.example.invalid')).toBe(true);
    expect(hostCovered('badexample.invalid', 'example.invalid')).toBe(false);
    expect(secretCovered('~/.aws/credentials', '~/.aws')).toBe(true);
    expect(secretCovered('.awsx', '.aws')).toBe(false);
  });
});

describe('diffCapabilities (expansion semantics)', () => {
  const base = set({
    exec: ['npx'],
    network: ['api.invalid'],
    externals: [
      ext({ id: 'tool', pin: 'version', pinValue: '1.2.3' }),
      ext({ id: 'free', pin: 'unpinned', pinValue: null, role: 'install' }),
      ext({ kind: 'url', id: 'https://docs.invalid', host: 'docs.invalid', role: 'reference' }),
    ],
  });

  it('diff(x, x) is empty', () => {
    const delta = diffCapabilities(base, base);
    expect(delta.expansion).toBe(false);
    expect(delta.reasons).toEqual([]);
    expect(expansionTokens(delta)).toEqual([]);
  });

  it('null installed: everything is added', () => {
    const delta = diffCapabilities(null, base);
    expect(delta.expansion).toBe(true);
    expect(delta.added.exec).toEqual(['npx']);
    expect(delta.externals.added).toHaveLength(3);
  });

  it.each([
    ['a new host', set({ ...base, network: ['api.invalid', 'x.invalid'] }), true],
    ['* added to a host list', set({ ...base, network: ['*', 'api.invalid'] }), true],
    ['a new concrete host under an existing *', null, true],
    ['a new exec token', set({ ...base, exec: ['npx', 'uvx'] }), true],
    [
      'a new external (pinned)',
      set({
        ...base,
        externals: [...base.externals, ext({ id: 'new', pin: 'version', pinValue: '1.0.0' })],
      }),
      true,
    ],
    [
      'pinned → unpinned',
      set({
        ...base,
        externals: [
          ext({ id: 'tool', pin: 'unpinned', pinValue: '^1' }),
          ...base.externals.slice(1),
        ],
      }),
      true,
    ],
    [
      'a changed pin value',
      set({
        ...base,
        externals: [
          ext({ id: 'tool', pin: 'version', pinValue: '1.2.4' }),
          ...base.externals.slice(1),
        ],
      }),
      true,
    ],
    [
      'a role escalation (install → run)',
      set({
        ...base,
        externals: [
          base.externals[0] as ExternalRef,
          ext({ id: 'free', role: 'run' }),
          base.externals[2] as ExternalRef,
        ],
      }),
      true,
    ],
    ['a removal', set({ ...base, exec: [] }), false],
    [
      'unpinned → pinned (tightened)',
      set({
        ...base,
        externals: [
          base.externals[0] as ExternalRef,
          ext({ id: 'free', pin: 'version', pinValue: '2.0.0', role: 'install' }),
          base.externals[2] as ExternalRef,
        ],
      }),
      false,
    ],
    [
      'a lower role for the same external',
      set({
        ...base,
        externals: [
          base.externals[0] as ExternalRef,
          ext({ id: 'free', role: 'fetch' }),
          base.externals[2] as ExternalRef,
        ],
      }),
      false,
    ],
  ] as const)('%s → expansion %s', (_label, candidate, expected) => {
    if (candidate === null) {
      const wild = set({ ...base, network: ['*'] });
      expect(diffCapabilities(wild, set({ ...wild, network: ['*', 'x.invalid'] })).expansion).toBe(
        true,
      );
      return;
    }
    expect(diffCapabilities(base, candidate).expansion).toBe(expected);
  });

  it('classifies external changes and reports tightened pins', () => {
    const candidate = set({
      ...base,
      externals: [
        ext({ id: 'tool', pin: 'unpinned', pinValue: '^1' }),
        ext({ id: 'free', pin: 'version', pinValue: '2.0.0', role: 'install' }),
      ],
    });
    const delta = diffCapabilities(base, candidate);
    expect(delta.externals.changed.map((c) => c.change)).toEqual(['pin-loosened']);
    expect(delta.externals.tightened).toHaveLength(1);
    expect(delta.externals.removed.map((r) => r.id)).toEqual(['https://docs.invalid']);
    expect(delta.reasons).toEqual([
      '~external:npm:tool version 1.2.3 → ^1 (unpinned) (pin loosened)',
    ]);
  });

  it('is order-independent', () => {
    const shuffled = {
      ...base,
      exec: [...base.exec].reverse(),
      externals: [...base.externals].reverse(),
    };
    expect(diffCapabilities(shuffled, base).expansion).toBe(false);
  });

  it('intersect keeps only what is both recorded and present', () => {
    const current = set({
      exec: ['npx', 'nc'],
      externals: [ext({ id: 'tool', pin: 'version', pinValue: '1.2.3' })],
    });
    const recorded = set({ exec: ['npx'], externals: [ext({ id: 'tool', pin: 'unpinned' })] });
    const inter = intersectCapabilities(current, recorded);
    expect(inter.exec).toEqual(['npx']);
    expect(inter.externals).toHaveLength(1);
    for (const key of CAPABILITY_KEYS) expect(Array.isArray(inter[key])).toBe(true);
  });
});

describe('summarizeFileChanges', () => {
  it('counts added, removed and modified files and the SKILL.md line delta (CRLF-independent)', () => {
    const summary = summarizeFileChanges(
      { files: { 'SKILL.md': 'a', 'x.sh': 'b', 'gone.md': 'c' }, skillMd: 'one\r\ntwo\r\n' },
      { files: { 'SKILL.md': 'a2', 'x.sh': 'b', 'new.md': 'd' }, skillMd: 'one\ntwo\nthree\n' },
    );
    expect(summary).toEqual({
      added: ['new.md'],
      removed: ['gone.md'],
      modified: ['SKILL.md'],
      unchanged: 1,
      skillMd: { before: 2, after: 3, delta: 1 },
    });
    expect(summarizeFileChanges(null, { files: {}, skillMd: 'x' }).skillMd).toEqual({
      before: null,
      after: 1,
      delta: null,
    });
  });
});
