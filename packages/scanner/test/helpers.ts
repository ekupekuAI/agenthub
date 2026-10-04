import type { Finding, SkillManifest } from '@agenthub/core';
import { type ScanFile, scanPackage } from '../src/index';

const encoder = new TextEncoder();

export function file(path: string, content: string | Uint8Array): ScanFile {
  return { path, content: typeof content === 'string' ? encoder.encode(content) : content };
}

/** Scans one text file and returns its findings. */
export function scan(path: string, content: string, extra: ScanFile[] = []): Finding[] {
  return scanPackage([file(path, content), ...extra]).findings.filter((f) => f.file === path);
}

/** Findings of one rule. */
export function ofRule(findings: readonly Finding[], ruleId: string): Finding[] {
  return findings.filter((f) => f.ruleId === ruleId);
}

export function ruleIds(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((f) => f.ruleId))].sort();
}

/** The parsed `agenthub.yaml` of each fixture that has one (mirrors the files on disk). */
export const FIXTURE_MANIFESTS: Record<string, SkillManifest> = {
  'web-testing': {
    schema: 1,
    version: '1.3.0',
    requires: { runtimes: { node: '>=22' } },
    permissions: { network: true, exec: ['npx', 'node'], env: ['PLAYWRIGHT_BROWSERS_PATH'] },
    channel: 'stable',
  },
  'complex-benign': {
    schema: 1,
    version: '2.0.1',
    permissions: {
      network: false,
      exec: ['git', 'node'],
      env: ['COMPLEX_BENIGN_MODE'],
      fs: { write: ['project'] },
    },
  },
  'needs-node-99': {
    schema: 1,
    version: '0.1.0',
    requires: { runtimes: { node: '>=99' } },
  },
};

export function fixtureManifest(name: string): SkillManifest | null {
  return FIXTURE_MANIFESTS[name] ?? null;
}
