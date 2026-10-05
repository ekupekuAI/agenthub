/**
 * Scan worker program: unpacks, validates and scans one package per message.
 *
 * Runs only inside a worker thread started by scan-runner.ts, never in the server bundle.
 * Production builds bundle it (with @agenthub/core and @agenthub/scanner) into a single
 * self-contained file, `dist/scan-worker.mjs` (scripts/build-scan-worker.mjs, run before
 * `next build`). Development and tests load this TypeScript source directly.
 *
 * Protocol: posts `{ type: 'ready' }` once loaded, then answers each
 * `{ id, bytes, maxFindings }` with `{ id, ok: true, result }` or `{ id, ok: false, error }`.
 */
import { parentPort } from 'node:worker_threads';
import { type EvaluatedFinding, isAgentHubError, readSkillArchive } from '@agenthub/core';
import { evaluatePolicy, SCANNER_VERSION, scanPackage } from '@agenthub/scanner';
import type { AnalyzedPackage } from './scan-runner';

type Decision = EvaluatedFinding['decision'];

const RANK: Record<string, number> = { BLOCK: 0, WARN: 1, INFO: 2 };

function clip<T>(value: T, max: number): T {
  return (typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value) as T;
}

class StageError extends Error {
  readonly stage: 'read' | 'scan';
  readonly original: unknown;
  constructor(stage: 'read' | 'scan', original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.stage = stage;
    this.original = original;
  }
}

/** Everything the registry needs from an upload. File contents never leave the worker. */
export function analyzePackage(bytes: Uint8Array, maxFindings: number): AnalyzedPackage {
  let pkg: ReturnType<typeof readSkillArchive>;
  try {
    pkg = readSkillArchive(bytes);
  } catch (error) {
    throw new StageError('read', error);
  }
  const scan = scanPackage(
    pkg.files.map((f) => ({ path: f.path, content: f.content, kind: f.kind })),
  );
  const policy = evaluatePolicy(scan.findings, pkg.manifest);
  const counts: Record<Decision, number> = { INFO: 0, WARN: 0, BLOCK: 0 };
  const blockRuleIds = new Set<string>();
  const blockKeys = new Set<string>();
  for (const f of policy.findings) {
    counts[f.decision] = (counts[f.decision] || 0) + 1;
    if (f.decision === 'BLOCK') {
      blockRuleIds.add(f.ruleId);
      if (blockKeys.size < 2000) blockKeys.add(`${f.ruleId}\u0000${f.file}`);
    }
  }
  const findings = policy.findings
    .slice()
    .sort((a, b) => (RANK[a.decision] ?? 3) - (RANK[b.decision] ?? 3))
    .slice(0, maxFindings)
    .map((f) => {
      const out: EvaluatedFinding = {
        ...f,
        evidence: clip(f.evidence, 240),
        message: clip(f.message, 500),
        file: clip(f.file, 300),
      };
      if (f.subject === undefined) delete out.subject;
      else out.subject = clip(f.subject, 200);
      return out;
    });
  return {
    pkg: {
      name: pkg.name,
      version: pkg.version,
      frontmatter: pkg.frontmatter,
      body: pkg.body,
      manifest: pkg.manifest,
      digest: pkg.digest,
      files: pkg.files.map((f) => ({
        path: f.path,
        size: f.content.byteLength,
        sha256: pkg.fileHashes[f.path] || '',
        kind: f.kind,
        executable: f.executable,
      })),
      issues: pkg.issues.slice(0, 200).map((i) => ({
        code: i.code,
        message: clip(i.message, 500),
        path: i.path,
      })),
    },
    scannerVersion: scan.scannerVersion || SCANNER_VERSION,
    outcome: policy.outcome,
    findings,
    findingsTotal: policy.findings.length,
    counts,
    blockRuleIds: [...blockRuleIds],
    blockKeys: [...blockKeys],
  };
}

function describeError(error: unknown): {
  stage: 'read' | 'scan';
  core: boolean;
  code?: string;
  message: string;
} {
  const stage = error instanceof StageError ? error.stage : 'scan';
  const original = error instanceof StageError ? error.original : error;
  const code = (original as { code?: unknown } | null)?.code;
  return {
    stage,
    core: isAgentHubError(original),
    code: typeof code === 'string' ? code : undefined,
    message: original instanceof Error ? original.message : String(original),
  };
}

const port = parentPort;
if (port) {
  port.on('message', (task: { id: number; bytes: Uint8Array; maxFindings: number }) => {
    try {
      const result = analyzePackage(task.bytes, task.maxFindings);
      port.postMessage({ id: task.id, ok: true, result });
    } catch (error) {
      port.postMessage({ id: task.id, ok: false, error: describeError(error) });
    }
  });
  port.postMessage({ type: 'ready' });
}
