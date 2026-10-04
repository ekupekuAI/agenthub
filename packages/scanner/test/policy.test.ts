import type { Finding, SkillManifest } from '@agenthub/core';
import { describe, expect, it } from 'vitest';
import { DEV_OVERRIDE_SUFFIX, evaluatePolicy, isDeclared } from '../src/index';

function finding(overrides: Partial<Finding> & Pick<Finding, 'ruleId' | 'category'>): Finding {
  return {
    severity: 'medium',
    declarable: true,
    file: 'scripts/run.sh',
    line: 1,
    evidence: 'evidence',
    message: 'message',
    ...overrides,
  };
}

const exec = (subject: string) => finding({ ruleId: 'exec.shell', category: 'exec', subject });
const net = (subject: string) => finding({ ruleId: 'net.access', category: 'network', subject });
const env = (subject: string) => finding({ ruleId: 'env.read', category: 'env', subject });
const secret = (subject: string) =>
  finding({ ruleId: 'secrets.read', category: 'secrets', severity: 'high', subject });
const deps = (subject: string) => finding({ ruleId: 'deps.remote', category: 'deps', subject });
const downloadExec = finding({
  ruleId: 'net.download-exec',
  category: 'download-exec',
  severity: 'high',
  declarable: false,
  subject: 'example.invalid',
});

function manifest(permissions: SkillManifest['permissions']): SkillManifest {
  return { schema: 1, version: '1.0.0', permissions };
}

describe('policy tiers (design §8.2)', () => {
  it('medium and undeclared → WARN (confirm)', () => {
    const result = evaluatePolicy([exec('npx')], null);
    expect(result.findings[0]).toMatchObject({ declared: false, decision: 'WARN' });
    expect(result.outcome).toBe('confirm');
  });

  it('medium and declared → INFO (allow)', () => {
    const result = evaluatePolicy([exec('npx')], manifest({ exec: ['npx'] }));
    expect(result.findings[0]).toMatchObject({ declared: true, decision: 'INFO' });
    expect(result.outcome).toBe('allow');
  });

  it('high, declarable and undeclared → BLOCK', () => {
    const result = evaluatePolicy([secret('~/.aws/credentials')], manifest({ secrets: [] }));
    expect(result.findings[0]).toMatchObject({ declared: false, decision: 'BLOCK' });
    expect(result.outcome).toBe('block');
  });

  it('high, declarable and declared → WARN (still needs confirmation)', () => {
    const result = evaluatePolicy(
      [secret('~/.aws/credentials')],
      manifest({ secrets: ['~/.aws'] }),
    );
    expect(result.findings[0]).toMatchObject({ declared: true, decision: 'WARN' });
    expect(result.outcome).toBe('confirm');
  });

  it('never declarable → BLOCK even when the manifest allows everything', () => {
    const result = evaluatePolicy(
      [downloadExec],
      manifest({ network: true, exec: ['sh', 'curl'] }),
    );
    expect(result.findings[0]).toMatchObject({ declared: false, decision: 'BLOCK' });
    expect(result.outcome).toBe('block');
  });

  it('allows a package with no findings', () => {
    expect(evaluatePolicy([], null)).toEqual({ findings: [], outcome: 'allow' });
  });

  it('block wins over confirm, confirm wins over allow', () => {
    const m = manifest({ exec: ['npx'] });
    expect(evaluatePolicy([exec('npx'), exec('bash')], m).outcome).toBe('confirm');
    expect(evaluatePolicy([exec('npx'), exec('bash'), downloadExec], m).outcome).toBe('block');
  });

  it('--dev turns every BLOCK into WARN and says so', () => {
    const result = evaluatePolicy([downloadExec, secret('.env'), exec('npx')], null, { dev: true });
    expect(result.findings.map((f) => f.decision)).toEqual(['WARN', 'WARN', 'WARN']);
    expect(result.findings[0]?.message).toBe(`message${DEV_OVERRIDE_SUFFIX}`);
    expect(result.findings[2]?.message).toBe('message');
    expect(result.outcome).toBe('confirm');
  });

  it('--dev leaves INFO findings alone', () => {
    const result = evaluatePolicy([exec('npx')], manifest({ exec: ['npx'] }), { dev: true });
    expect(result.findings[0]).toMatchObject({ decision: 'INFO', message: 'message' });
    expect(result.outcome).toBe('allow');
  });

  it('keeps every finding field and does not mutate the input', () => {
    const input = [exec('npx')];
    const result = evaluatePolicy(input, null, { dev: true });
    expect(result.findings[0]).toMatchObject(input[0] as Finding);
    expect(input[0]).not.toHaveProperty('decision');
  });
});

describe('declarations', () => {
  it('exec: subject listed in permissions.exec (case-insensitive)', () => {
    expect(isDeclared(exec('npx'), manifest({ exec: ['NPX'] }))).toBe(true);
    expect(isDeclared(exec('node'), manifest({ exec: ['npx'] }))).toBe(false);
    expect(isDeclared(exec('*'), manifest({ exec: ['npx'] }))).toBe(false);
  });

  it('network: true, or the host or a parent domain listed', () => {
    expect(isDeclared(net('api.example.invalid'), manifest({ network: true }))).toBe(true);
    expect(isDeclared(net('*'), manifest({ network: true }))).toBe(true);
    expect(isDeclared(net('api.example.invalid'), manifest({ network: ['example.invalid'] }))).toBe(
      true,
    );
    expect(
      isDeclared(net('api.example.invalid'), manifest({ network: ['*.example.invalid'] })),
    ).toBe(true);
    expect(
      isDeclared(net('example.invalid'), manifest({ network: ['https://example.invalid:443/x'] })),
    ).toBe(true);
    expect(isDeclared(net('badexample.invalid'), manifest({ network: ['example.invalid'] }))).toBe(
      false,
    );
    expect(isDeclared(net('*'), manifest({ network: ['example.invalid'] }))).toBe(false);
    expect(isDeclared(net('example.invalid'), manifest({ network: false }))).toBe(false);
  });

  it('env: subject listed in permissions.env', () => {
    expect(isDeclared(env('API_URL'), manifest({ env: ['API_URL'] }))).toBe(true);
    expect(isDeclared(env('API_KEY'), manifest({ env: ['API_URL'] }))).toBe(false);
  });

  it('secrets: exact or parent path, with ~ and ./ normalized', () => {
    const m = manifest({ secrets: ['~/.aws', '.env', 'env:*'] });
    expect(isDeclared(secret('~/.aws/credentials'), m)).toBe(true);
    expect(isDeclared(secret('~/.aws'), m)).toBe(true);
    expect(isDeclared(secret('.env'), m)).toBe(true);
    expect(isDeclared(secret('./.env'), m)).toBe(true);
    expect(isDeclared(secret('env:*'), m)).toBe(true);
    expect(isDeclared(secret('~/.awsome'), m)).toBe(false);
    expect(isDeclared(secret('.env.local'), m)).toBe(false);
    expect(isDeclared(secret('~/.ssh/id_rsa'), m)).toBe(false);
  });

  it('deps: installer listed in permissions.exec', () => {
    expect(isDeclared(deps('pip'), manifest({ exec: ['pip'] }))).toBe(true);
    expect(isDeclared(deps('npm'), manifest({ exec: ['pip'] }))).toBe(false);
  });

  it('prompt, binary, dynamic code and never-declarable findings are never declared', () => {
    const all = manifest({ network: true, exec: ['*'], env: ['*'], secrets: ['*'] });
    const never = [
      finding({ ruleId: 'prompt.injection', category: 'prompt', subject: 'override' }),
      finding({ ruleId: 'file.binary', category: 'binary', subject: 'elf' }),
      finding({ ruleId: 'code.dynamic', category: 'dynamic', subject: 'eval' }),
      downloadExec,
    ];
    for (const f of never) expect(isDeclared(f, all), f.ruleId).toBe(false);
  });

  it('nothing is declared without a manifest or without a subject', () => {
    expect(isDeclared(exec('npx'), null)).toBe(false);
    expect(
      isDeclared(finding({ ruleId: 'exec.shell', category: 'exec' }), manifest({ exec: ['npx'] })),
    ).toBe(false);
    expect(isDeclared(exec('npx'), { schema: 1, version: '1.0.0' })).toBe(false);
  });
});
