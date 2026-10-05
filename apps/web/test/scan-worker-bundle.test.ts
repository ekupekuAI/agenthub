import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSkillFromDir, packSkill } from '@agenthub/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerScanRunner } from '../src/lib/scan-runner';
import { packTestSkill } from './helpers';

/**
 * The production worker: src/lib/scan-worker.ts bundled by scripts/build-scan-worker.mjs.
 * Built into a temp folder outside the repository, so it can only work if the bundle really
 * is self-contained (no monorepo sources, no node_modules next to it).
 */
let root: string;
let bundle: string;
let runner: WorkerScanRunner;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agenthub-bundle-'));
  const script = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../scripts/build-scan-worker.mjs',
  );
  const { buildScanWorker } = (await import(script)) as {
    buildScanWorker(target: string): Promise<string>;
  };
  bundle = await buildScanWorker(path.join(root, 'isolated', 'scan-worker.mjs'));
  runner = new WorkerScanRunner({ workerFile: bundle, concurrency: 1 });
}, 60_000);

afterAll(async () => {
  await runner?.close();
  await rm(root, { recursive: true, force: true });
});

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../packages/test-fixtures/fixtures',
);

describe('bundled scan worker', () => {
  it('scans a clean package', async () => {
    const result = await runner.analyze(await packTestSkill(root, 'bundle-clean'));
    expect(result.pkg.name).toBe('bundle-clean');
    expect(result.outcome).not.toBe('block');
  });

  it('blocks the secret-reader fixture', async () => {
    const pkg = await loadSkillFromDir(path.join(fixtures, 'secret-reader'));
    const result = await runner.analyze(packSkill(pkg));
    expect(result.outcome).toBe('block');
    expect(result.counts.BLOCK).toBeGreaterThan(0);
  });

  it('maps archive errors like the source worker', async () => {
    // Core errors keep their identity across the bundle (isAgentHubError still works).
    await expect(runner.analyze(new TextEncoder().encode('not a tarball'))).rejects.toMatchObject({
      code: 'INTEGRITY',
    });
  });
});
