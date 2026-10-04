/** Install policy tiers (design §8.2). */
import type {
  EvaluatedFinding,
  Finding,
  FindingDecision,
  PolicyResult,
  SkillManifest,
} from '@agenthub/core';

export interface PolicyOptions {
  /** `--dev`: every BLOCK becomes WARN. */
  dev?: boolean;
}

export const DEV_OVERRIDE_SUFFIX = ' (overridden by --dev)';

/** Normalizes a credential path: forward slashes, no home prefix, no `./`, no trailing `/`. */
function normalizeSecret(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)\//i, '')
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
}

function secretMatches(subject: string, entry: string): boolean {
  const s = normalizeSecret(subject);
  const e = normalizeSecret(entry);
  return e !== '' && (s === e || s.startsWith(`${e}/`));
}

/** Host or host suffix from a declared entry ('*.example.com', 'https://example.com:443/x'). */
function normalizeHost(entry: string): string {
  return entry
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^\*\./, '')
    .replace(/\.$/, '');
}

function hostMatches(host: string, entry: string): boolean {
  const h = host.toLowerCase();
  const e = normalizeHost(entry);
  return e !== '' && (h === e || h.endsWith(`.${e}`));
}

/**
 * Is the finding covered by the manifest's `permissions`?
 * exec → subject listed in `exec`; network → `network: true` or the host (or a parent
 * domain) listed; env → subject listed in `env`; secrets → listed exactly or as a parent
 * path; deps → the installer listed in `exec`. Prompt, binary, dynamic-code and
 * never-declarable findings are never declared.
 */
export function isDeclared(finding: Finding, manifest: SkillManifest | null): boolean {
  if (!finding.declarable || manifest === null) return false;
  const perms = manifest.permissions;
  const subject = finding.subject;
  if (perms === undefined || subject === undefined) return false;
  switch (finding.category) {
    case 'exec':
    case 'deps':
      return (perms.exec ?? []).some((e) => e.toLowerCase() === subject.toLowerCase());
    case 'network':
      if (perms.network === true) return true;
      return (
        Array.isArray(perms.network) &&
        subject !== '*' &&
        perms.network.some((e) => hostMatches(subject, e))
      );
    case 'env':
      return (perms.env ?? []).includes(subject);
    case 'secrets':
      return (perms.secrets ?? []).some((e) => secretMatches(subject, e));
    default:
      return false;
  }
}

function decide(finding: Finding, declared: boolean): FindingDecision {
  if (!finding.declarable) return 'BLOCK';
  if (finding.severity === 'medium') return declared ? 'INFO' : 'WARN';
  return declared ? 'WARN' : 'BLOCK';
}

/**
 * Applies the policy tiers:
 * medium & undeclared → WARN, medium & declared → INFO, high & declarable & undeclared →
 * BLOCK, high & declarable & declared → WARN, never declarable → BLOCK. `dev` turns every
 * BLOCK into WARN. Outcome: block if any BLOCK, else confirm if any WARN, else allow.
 */
export function evaluatePolicy(
  findings: readonly Finding[],
  manifest: SkillManifest | null,
  opts: PolicyOptions = {},
): PolicyResult {
  const evaluated: EvaluatedFinding[] = findings.map((finding) => {
    const declared = isDeclared(finding, manifest);
    let decision = decide(finding, declared);
    let message = finding.message;
    if (decision === 'BLOCK' && opts.dev === true) {
      decision = 'WARN';
      message += DEV_OVERRIDE_SUFFIX;
    }
    return { ...finding, message, declared, decision };
  });
  const outcome = evaluated.some((f) => f.decision === 'BLOCK')
    ? 'block'
    : evaluated.some((f) => f.decision === 'WARN')
      ? 'confirm'
      : 'allow';
  return { findings: evaluated, outcome };
}
