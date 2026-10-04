import { fixtureNames, readExpected, readFixtureFiles } from '@agenthub/test-fixtures';
import { describe, expect, it } from 'vitest';
import { evaluatePolicy, scanPackage } from '../src/index';
import { FIXTURE_MANIFESTS, fixtureManifest, ruleIds } from './helpers';

describe('fixture skills', () => {
  const names = fixtureNames();

  it('covers every fixture from the design', () => {
    expect(names).toEqual([
      'complex-benign',
      'download-exec',
      'hello-skill',
      'hidden-unicode',
      'needs-node-99',
      'obfuscated',
      'persistence',
      'prompt-injection',
      'secret-reader',
      'web-testing',
    ]);
  });

  it('has a manifest mirror for every fixture with an agenthub.yaml', () => {
    const withYaml = names.filter((name) =>
      readFixtureFiles(name).some((f) => f.path === 'agenthub.yaml'),
    );
    expect(withYaml.sort()).toEqual(Object.keys(FIXTURE_MANIFESTS).sort());
  });

  it.each(names)('%s matches its expected outcome and rule ids', (name) => {
    const expected = readExpected(name);
    const result = scanPackage(readFixtureFiles(name));
    const policy = evaluatePolicy(result.findings, fixtureManifest(name));
    const summary = policy.findings.map(
      (f) => `${f.decision} ${f.ruleId} ${f.file}:${f.line} [${f.subject ?? ''}] ${f.evidence}`,
    );
    expect(
      { outcome: policy.outcome, ruleIds: ruleIds(result.findings) },
      summary.join('\n'),
    ).toEqual(expected);
  });

  it('benign fixtures produce no warnings or blocks', () => {
    for (const name of ['hello-skill', 'web-testing', 'complex-benign', 'needs-node-99']) {
      const policy = evaluatePolicy(
        scanPackage(readFixtureFiles(name)).findings,
        fixtureManifest(name),
      );
      expect(policy.findings.filter((f) => f.decision !== 'INFO')).toEqual([]);
    }
  });

  it('declared web-testing behavior is reported as INFO, never hidden', () => {
    const policy = evaluatePolicy(
      scanPackage(readFixtureFiles('web-testing')).findings,
      fixtureManifest('web-testing'),
    );
    expect(policy.findings.map((f) => [f.ruleId, f.subject, f.decision])).toEqual([
      ['env.read', 'PLAYWRIGHT_BROWSERS_PATH', 'INFO'],
      ['exec.shell', 'npx', 'INFO'],
    ]);
  });

  it('the same benign behavior without a manifest needs confirmation', () => {
    const policy = evaluatePolicy(scanPackage(readFixtureFiles('complex-benign')).findings, null);
    expect(policy.outcome).toBe('confirm');
  });

  it('blocked fixtures are only installable with --dev', () => {
    for (const name of [
      'secret-reader',
      'download-exec',
      'obfuscated',
      'hidden-unicode',
      'persistence',
    ]) {
      const findings = scanPackage(readFixtureFiles(name)).findings;
      expect(evaluatePolicy(findings, null).outcome).toBe('block');
      expect(evaluatePolicy(findings, null, { dev: true }).outcome).toBe('confirm');
    }
  });
});
