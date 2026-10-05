/**
 * Unpacks, validates and scans uploaded packages off the request thread.
 *
 * Archive parsing and the scanner are CPU-bound and synchronous, and some inputs make them
 * slow. Running them on the event loop would freeze every other request, so each check runs in
 * a worker thread with a wall-clock budget and a heap cap: on overrun the worker is terminated
 * and the upload is rejected. A small fixed pool also limits how many uploads are checked at
 * once; a short queue absorbs bursts and anything beyond it is refused as busy. There is no
 * in-process fallback: when no worker can start, uploads are refused (fail closed).
 *
 * The worker program is ./scan-worker.ts. Two ways to load it:
 *
 * - Production (`next start`, Vercel): the self-contained bundle `dist/scan-worker.mjs`,
 *   built by scripts/build-scan-worker.mjs before `next build` and shipped with every server
 *   function (outputFileTracingIncludes in next.config.ts). It does not depend on how Next.js
 *   bundles the server or on the monorepo sources being present.
 * - Development and tests (or a production run without the bundle): a small inline bootstrap
 *   loads the TypeScript sources with Node's type transform and a resolve hook for
 *   extensionless relative imports.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { EvaluatedFinding, SkillFrontmatter, SkillManifest } from '@agenthub/core';
import { MAX_STORED_FINDINGS, scanConcurrency, scanTimeoutMs } from '../config';
import type { ScanOutcome } from './api-types';
import { ApiError } from './errors';

export interface AnalyzedFile {
  path: string;
  size: number;
  sha256: string;
  kind: 'text' | 'binary';
  executable: boolean;
}

/** Everything the registry needs from an upload. File contents never leave the worker. */
export interface AnalyzedPackage {
  pkg: {
    name: string;
    version: string;
    frontmatter: SkillFrontmatter;
    body: string;
    manifest: SkillManifest | null;
    digest: string;
    files: AnalyzedFile[];
    issues: { code: string; message: string; path?: string }[];
  };
  scannerVersion: string;
  outcome: ScanOutcome;
  /** At most `maxFindings`, BLOCK first, then WARN, then INFO (scanner order within each). */
  findings: EvaluatedFinding[];
  /** Number of findings before the cap. */
  findingsTotal: number;
  counts: { INFO: number; WARN: number; BLOCK: number };
  /** Distinct rule ids of every BLOCK finding (not capped by `maxFindings`). */
  blockRuleIds: string[];
  /** Distinct `ruleId\u0000file` pairs of BLOCK findings (at most 2000). */
  blockKeys: string[];
}

export interface ScanRunner {
  analyze(bytes: Uint8Array): Promise<AnalyzedPackage>;
}

/** Relative path of the bundled worker inside the app directory. */
export const SCAN_WORKER_BUNDLE = path.join('dist', 'scan-worker.mjs');

/**
 * Absolute path of the bundled worker, or null when it has not been built. Looked up from the
 * working directory (the app directory under `next start` and on Vercel) and, for commands
 * run from the repository root, `apps/web`.
 */
export function scanWorkerBundlePath(): string | null {
  for (const dir of [process.cwd(), path.join(process.cwd(), 'apps', 'web')]) {
    const file = path.join(dir, SCAN_WORKER_BUNDLE);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * Bootstrap for running ./scan-worker.ts from source (development and tests). Plain
 * JavaScript (CommonJS eval context); keep it dependency-free.
 */
export const SCAN_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const nodeModule = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RELATIVE = /^\.{1,2}\//;
const FROM_TS = /\.[cm]?ts$/;
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const code = error && error.code;
      if (
        !RELATIVE.test(specifier) ||
        typeof context.parentURL !== 'string' ||
        !FROM_TS.test(context.parentURL) ||
        (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ERR_UNSUPPORTED_DIR_IMPORT')
      ) {
        throw error;
      }
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return nextResolve(specifier + suffix, context);
        } catch {}
      }
      throw error;
    }
  },
});

function resolveFromBases(name) {
  let lastError;
  for (const base of workerData.bases) {
    try {
      return pathToFileURL(nodeModule.createRequire(path.join(base, 'noop.js')).resolve(name)).href;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

import(resolveFromBases('@agenthub/web/src/lib/scan-worker.ts')).catch((error) => {
  parentPort.postMessage({
    type: 'fatal',
    error: error instanceof Error ? error.stack || error.message : String(error),
  });
});
`;

/** How a worker is started: a bundled file, or an inline program evaluated in the worker. */
type WorkerProgram = { file: string } | { source: string };

/** The bundle in production when it exists; otherwise the TypeScript sources. */
function defaultProgram(): WorkerProgram {
  if (process.env.NODE_ENV === 'production') {
    const file = scanWorkerBundlePath();
    if (file) {
      console.info(`[agenthub] package scanner: bundled worker ${file}`);
      return { file };
    }
    console.warn(
      `[agenthub] package scanner: ${SCAN_WORKER_BUNDLE} not found, loading the TypeScript ` +
        'sources instead (run `npm run build -w apps/web`, which builds the bundle first)',
    );
  }
  return { source: SCAN_WORKER_SOURCE };
}

export interface WorkerScanRunnerOptions {
  /** Budget for one check, in ms. Default: AGENTHUB_SCAN_TIMEOUT_MS or 15 s. */
  timeoutMs?: number;
  /** Checks running at once. Default: AGENTHUB_SCAN_CONCURRENCY or 2. */
  concurrency?: number;
  /** Checks waiting for a free worker before new ones are refused as busy. */
  maxQueue?: number;
  maxFindings?: number;
  /** Time allowed for a new worker to load the scanner. */
  startupTimeoutMs?: number;
  /** Idle workers are stopped after this long. */
  idleMs?: number;
  /** Heap cap per worker, in MB. */
  maxHeapMb?: number;
  /** Inline worker program (tests only). */
  source?: string;
  /** Worker program file, e.g. a bundle built by scripts/build-scan-worker.mjs (tests only). */
  workerFile?: string;
}

interface WorkerError {
  stage: 'read' | 'scan';
  core: boolean;
  code?: string;
  message: string;
}

type WorkerReply =
  | { id: number; ok: true; result: AnalyzedPackage }
  | { id: number; ok: false; error: WorkerError };

function timeoutError(ms: number): ApiError {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return new ApiError(
    'VALIDATION',
    `The package could not be checked within ${seconds} seconds, so it was not published. ` +
      'Very large or unusual text files (for example extremely long lines) can cause this.',
    { status: 422 },
  );
}

function unavailableError(detail: string): ApiError {
  console.error('[agenthub] package scanner unavailable:', detail);
  return new ApiError('INTERNAL', 'The package scanner is unavailable. Try again later.');
}

function mapWorkerError(error: WorkerError): ApiError {
  if (error.stage === 'read') {
    if (error.core && error.code === 'INTEGRITY') return new ApiError('INTEGRITY', error.message);
    if (error.core) return new ApiError('VALIDATION', error.message);
    return new ApiError('VALIDATION', 'The upload is not a valid .skillpkg archive.');
  }
  console.error('[agenthub] scan failed:', error.message);
  return new ApiError('INTERNAL', 'The package could not be scanned because of a server error.');
}

export class WorkerScanRunner implements ScanRunner {
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly maxQueue: number;
  private readonly maxFindings: number;
  private readonly startupTimeoutMs: number;
  private readonly idleMs: number;
  private readonly maxHeapMb: number;
  private readonly program: WorkerProgram;

  private readonly idle: Worker[] = [];
  private readonly idleTimers = new Map<Worker, NodeJS.Timeout>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;
  private seq = 0;

  constructor(opts: WorkerScanRunnerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? scanTimeoutMs();
    this.concurrency = opts.concurrency ?? scanConcurrency();
    this.maxQueue = opts.maxQueue ?? this.concurrency * 4;
    this.maxFindings = opts.maxFindings ?? MAX_STORED_FINDINGS;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 60_000;
    this.idleMs = opts.idleMs ?? 60_000;
    this.maxHeapMb = opts.maxHeapMb ?? 512;
    this.program = opts.workerFile
      ? { file: opts.workerFile }
      : opts.source
        ? { source: opts.source }
        : defaultProgram();
  }

  /** Checks currently running and waiting (for tests and diagnostics). */
  get load(): { running: number; waiting: number; idleWorkers: number } {
    return { running: this.running, waiting: this.waiting.length, idleWorkers: this.idle.length };
  }

  async analyze(bytes: Uint8Array): Promise<AnalyzedPackage> {
    await this.acquire();
    try {
      const worker = await this.takeWorker();
      return await this.runOn(worker, bytes);
    } finally {
      this.release();
    }
  }

  /** Stop every idle worker (busy ones finish or time out on their own). */
  async close(): Promise<void> {
    const workers = this.idle.splice(0);
    for (const worker of workers) this.clearIdleTimer(worker);
    await Promise.all(workers.map((w) => w.terminate()));
  }

  private acquire(): Promise<void> {
    if (this.running < this.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxQueue) {
      return Promise.reject(
        new ApiError(
          'RATE_LIMITED',
          'The registry is busy checking other uploads. Try again in a moment.',
          { headers: { 'Retry-After': '10' } },
        ),
      );
    }
    // The releasing task hands its slot over, so `running` stays unchanged.
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }

  private async takeWorker(): Promise<Worker> {
    const worker = this.idle.pop();
    if (worker) {
      this.clearIdleTimer(worker);
      return worker;
    }
    return this.spawn();
  }

  private spawn(): Promise<Worker> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        const program = this.program;
        worker = new Worker('file' in program ? program.file : program.source, {
          eval: !('file' in program),
          // The source bootstrap needs Node's TypeScript transform; the bundle is plain JS.
          execArgv:
            'file' in program
              ? []
              : ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'],
          // Where the bootstrap looks for the worker sources: the working directory, then the
          // directory of the entry script (e.g. node_modules/next/dist/bin).
          workerData: {
            bases: [process.cwd(), process.argv[1] ? path.dirname(process.argv[1]) : null].filter(
              (b): b is string => typeof b === 'string',
            ),
          },
          resourceLimits: { maxOldGenerationSizeMb: this.maxHeapMb },
        });
      } catch (error) {
        reject(unavailableError(error instanceof Error ? error.message : String(error)));
        return;
      }
      // Never let an 'error' event go unhandled, also while the worker is idle.
      worker.on('error', () => {});
      worker.once('exit', () => this.forget(worker));
      const cleanup = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      const fail = (detail: string) => {
        cleanup();
        void worker.terminate();
        reject(unavailableError(detail));
      };
      const onMessage = (message: { type?: string; error?: string }) => {
        if (message?.type === 'ready') {
          cleanup();
          resolve(worker);
        } else if (message?.type === 'fatal') {
          fail(message.error ?? 'worker failed to start');
        }
      };
      const onError = (error: Error) => fail(error.message);
      const onExit = (code: number) => fail(`worker exited with code ${code} during startup`);
      const timer = setTimeout(() => fail('worker startup timed out'), this.startupTimeoutMs);
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
    });
  }

  private runOn(worker: Worker, bytes: Uint8Array): Promise<AnalyzedPackage> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      worker.ref();
      const finish = () => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      const onMessage = (reply: WorkerReply) => {
        if (reply?.id !== id) return;
        finish();
        this.park(worker);
        if (reply.ok) resolve(reply.result);
        else reject(mapWorkerError(reply.error));
      };
      const onError = (error: Error & { code?: string }) => {
        finish();
        void worker.terminate();
        if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
          reject(
            new ApiError(
              'VALIDATION',
              'Checking the package needed too much memory, so it was not published.',
              { status: 422 },
            ),
          );
        } else {
          reject(unavailableError(error.message));
        }
      };
      const onExit = (code: number) => {
        finish();
        reject(unavailableError(`worker exited with code ${code}`));
      };
      const timer = setTimeout(() => {
        finish();
        void worker.terminate();
        reject(timeoutError(this.timeoutMs));
      }, this.timeoutMs);
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      const copy = bytes.slice();
      worker.postMessage({ id, bytes: copy, maxFindings: this.maxFindings }, [copy.buffer]);
    });
  }

  private park(worker: Worker): void {
    worker.unref();
    this.idle.push(worker);
    const timer = setTimeout(() => {
      this.idleTimers.delete(worker);
      const at = this.idle.indexOf(worker);
      if (at >= 0) this.idle.splice(at, 1);
      void worker.terminate();
    }, this.idleMs);
    timer.unref();
    this.idleTimers.set(worker, timer);
  }

  private clearIdleTimer(worker: Worker): void {
    const timer = this.idleTimers.get(worker);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(worker);
  }

  private forget(worker: Worker): void {
    this.clearIdleTimer(worker);
    const at = this.idle.indexOf(worker);
    if (at >= 0) this.idle.splice(at, 1);
  }
}

const globalForScan = globalThis as unknown as { __agenthubScanRunner?: WorkerScanRunner };

/** Process-wide runner, so every module instance shares one pool and one concurrency limit. */
export function defaultScanRunner(): ScanRunner {
  globalForScan.__agenthubScanRunner ??= new WorkerScanRunner();
  return globalForScan.__agenthubScanRunner;
}
