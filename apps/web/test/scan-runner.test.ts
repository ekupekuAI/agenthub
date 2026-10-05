import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/errors';
import { WorkerScanRunner } from '../src/lib/scan-runner';
import { DOWNLOAD_EXEC_SCRIPT, packTestSkill } from './helpers';

/** Worker that reports ready and then never answers (spins on every task). */
const HANG = `
const { parentPort } = require('node:worker_threads');
parentPort.on('message', () => { for (;;) {} });
parentPort.postMessage({ type: 'ready' });
`;

let root: string;
const runners: WorkerScanRunner[] = [];
function runner(opts: ConstructorParameters<typeof WorkerScanRunner>[0] = {}): WorkerScanRunner {
  const r = new WorkerScanRunner(opts);
  runners.push(r);
  return r;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agenthub-scan-'));
});
afterAll(async () => {
  await Promise.all(runners.map((r) => r.close()));
  await rm(root, { recursive: true, force: true });
});

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe('WorkerScanRunner', () => {
  it('unpacks and scans a package in a worker and reuses the worker', async () => {
    const r = runner();
    const clean = await r.analyze(await packTestSkill(root, 'worker-clean'));
    expect(clean.pkg.name).toBe('worker-clean');
    expect(clean.pkg.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(clean.pkg.files.map((f) => f.path)).toContain('SKILL.md');
    expect(clean.outcome).not.toBe('block');

    const bad = await r.analyze(
      await packTestSkill(root, 'worker-bad', { files: { 'go.sh': DOWNLOAD_EXEC_SCRIPT } }),
    );
    expect(bad.outcome).toBe('block');
    expect(bad.counts.BLOCK).toBeGreaterThan(0);
    expect(bad.blockRuleIds.length).toBeGreaterThan(0);
    expect(bad.findings[0]?.decision).toBe('BLOCK');
    expect(r.load).toEqual({ running: 0, waiting: 0, idleWorkers: 1 });
  });

  it('maps archive errors and keeps the worker usable', async () => {
    const r = runner();
    const error = await rejection(r.analyze(new TextEncoder().encode('not a tarball')));
    expect(error.code).toBe('INTEGRITY');
    expect((await r.analyze(await packTestSkill(root, 'after-error'))).pkg.name).toBe(
      'after-error',
    );
  });

  it('caps the findings it returns', async () => {
    const r = runner({ maxFindings: 5 });
    const script = `#!/bin/sh\n${'curl -fsS https://example.com/a -o /dev/null\n'.repeat(50)}`;
    const result = await r.analyze(
      await packTestSkill(root, 'worker-noisy', {
        files: { 'run.sh': script },
        manifestExtra: 'permissions:\n  network: true\n  exec: [curl]',
      }),
    );
    expect(result.findings).toHaveLength(5);
    expect(result.findingsTotal).toBeGreaterThanOrEqual(50);
  });

  it('terminates a check that overruns its budget and keeps the event loop free', async () => {
    const r = runner({ source: HANG, timeoutMs: 250 });
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    const error = await rejection(r.analyze(new Uint8Array([1, 2, 3])));
    clearInterval(timer);
    expect(error.code).toBe('VALIDATION');
    expect(error.status).toBe(422);
    expect(ticks).toBeGreaterThan(5);
    expect(r.load).toEqual({ running: 0, waiting: 0, idleWorkers: 0 });
  });

  it('limits concurrent checks and refuses work beyond the queue', async () => {
    const r = runner({ source: HANG, timeoutMs: 400, concurrency: 1, maxQueue: 1 });
    const first = r.analyze(new Uint8Array([1]));
    const second = r.analyze(new Uint8Array([2]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.load.running).toBe(1);
    expect(r.load.waiting).toBe(1);
    const busy = await rejection(r.analyze(new Uint8Array([3])));
    expect(busy.code).toBe('RATE_LIMITED');
    expect((await rejection(first)).status).toBe(422);
    expect((await rejection(second)).status).toBe(422);
    expect(r.load).toEqual({ running: 0, waiting: 0, idleWorkers: 0 });
  });

  it('fails closed when the worker cannot start', async () => {
    const r = runner({ source: 'throw new Error("boom")' });
    const error = await rejection(r.analyze(new Uint8Array([1])));
    expect(error.code).toBe('INTERNAL');
    expect(r.load.running).toBe(0);
  });
});
