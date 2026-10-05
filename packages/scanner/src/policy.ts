/** Install policy tiers (design §8.2). */
import {
  type EvaluatedFinding,
  type Finding,
  type FindingDecision,
  hostCovered,
  type PolicyResult,
  type SkillManifest,
  secretCovered,
} from '@agenthub/core';

export interface PolicyOptions {
  /** `--dev`: every BLOCK becomes WARN. */
  dev?: boolean;
}

export const DEV_OVERRIDE_SUFFIX = ' (overridden by --dev)';

/**
 * Is the finding covered by the manifest's `permissions`?
 * exec → subject listed in `exec`; network → `network: true` or the host (or a parent
 * domain) listed (remote instructions: the same host rule); env → subject listed in `env`; secrets → listed exactly or as a parent
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
    case 'remote-instructions':
      // Remote instructions count as declared only when their host is within permissions.network.
      if (perms.network === true) return true;
      return (
        Array.isArray(perms.network) &&
        subject !== '*' &&
        perms.network.some((e) => hostCovered(subject, e))
      );
    case 'env':
      return (perms.env ?? []).includes(subject);
    case 'secrets':
      return (perms.secrets ?? []).some((e) => secretCovered(subject, e));
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
