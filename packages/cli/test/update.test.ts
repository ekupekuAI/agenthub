import type { InstallPlan } from '@agenthub/core';
import { describe, expect, it } from 'vitest';
import { bulkExitCode, sourceChange } from '../src/commands/update';

function plan(previous: Partial<NonNullable<InstallPlan['previous']>> | undefined): InstallPlan {
  return {
    skill: { name: 'demo', version: '2.0.0', digest: 'sha256:x' },
    source: { kind: 'registry', name: 'demo', registry: 'https://registry.example.com' },
    ...(previous === undefined
      ? {}
      : {
          previous: {
            version: '1.0.0',
            digest: 'sha256:y',
            source: 'registry',
            registry: 'https://registry.example.com',
            installedTargets: [],
            paths: {},
            files: {},
            installedAt: '',
            ...previous,
          },
        }),
  } as unknown as InstallPlan;
}

describe('update source checks', () => {
  it('accepts an update from the registry the skill was installed from', () => {
    expect(sourceChange(plan({}))).toBeNull();
    expect(sourceChange(plan({ registry: 'https://registry.example.com/' }))).toBeNull();
    expect(sourceChange(plan(undefined))).toBeNull();
  });

  it('flags a folder or file install and a different registry', () => {
    expect(sourceChange(plan({ source: 'dir', registry: null }))).toMatch(/local folder/);
    expect(sourceChange(plan({ source: 'file', registry: null }))).toMatch(/local package/);
    expect(sourceChange(plan({ registry: 'https://other.example.com' }))).toMatch(
      /other\.example\.com/,
    );
  });
});

describe('bulk update exit code', () => {
  it('reports the most security-relevant failure', () => {
    expect(bulkExitCode([])).toBe(0);
    expect(bulkExitCode([{ code: 'REGISTRY' }])).toBe(1);
    expect(bulkExitCode([{ code: 'REGISTRY' }, { code: 'POLICY_BLOCKED' }])).toBe(3);
    expect(bulkExitCode([{ code: 'POLICY_BLOCKED' }, { code: 'INTEGRITY' }])).toBe(4);
    expect(bulkExitCode([{ code: 'INCOMPATIBLE' }])).toBe(5);
  });
});
