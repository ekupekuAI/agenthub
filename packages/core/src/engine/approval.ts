/**
 * Approval state of an installed entry and its approved baseline (trust features design §4).
 *
 * The capability fields in the lock are a reviewable record; they are never trusted alone. The
 * baseline an update is compared with is the recorded set intersected with a fresh scan of the
 * installed bytes, and no valid approval means an empty baseline (deleting an approval from the
 * lock yields more prompts, never fewer).
 */
import {
  capabilitiesCovered,
  diffCapabilities,
  emptyCapabilitySet,
  expansionTokens,
  intersectCapabilities,
  normalizeCapabilitySet,
} from '../capabilities';
import type { CapabilityReport, CapabilitySet, LockEntry, PolicyResult } from '../types';

export type ApprovalState =
  | 'approved'
  | 'approved-carried'
  | 'unapproved'
  | 'stale'
  | 'not-approvable';

export interface ApprovalStatus {
  state: ApprovalState;
  /** Tokens the current ruleset sees that the approval did not cover (state 'stale'). */
  stale: string[];
  /**
   * Whether the lock's capability block describes the installed bytes under the same ruleset:
   * false = the record was edited or forged (lock.capabilities-mismatch); null = not checked
   * (no block, another ruleset, or no intact copy to rescan).
   */
  lockMatches: boolean | null;
  /** False when no intact installed copy or cache entry could be rescanned. */
  checked: boolean;
}

/** The lock's recorded capability set, or null for an entry without a capability block. */
export function recordedSet(entry: LockEntry): CapabilitySet | null {
  if (entry.capabilities === undefined || entry.externals === undefined) return null;
  return normalizeCapabilitySet({ ...entry.capabilities, externals: entry.externals });
}

/** Rule 1 of §4.1: an approval bound to this entry's digest and capability block. */
export function hasBoundApproval(entry: LockEntry): boolean {
  const approval = entry.approval;
  return (
    approval !== undefined &&
    entry.capabilityDigest !== undefined &&
    entry.rulesetDigest !== undefined &&
    approval.digest === entry.digest &&
    approval.capabilityDigest === entry.capabilityDigest &&
    approval.rulesetDigest === entry.rulesetDigest
  );
}

/**
 * The state of an installed entry (design §4.1). `current` is a rescan of the installed bytes
 * (after they verified against the lock) or of the cached package; null when neither exists.
 */
export function approvalState(
  entry: LockEntry,
  current: CapabilityReport | null,
  strictOutcome: PolicyResult['outcome'] | null,
): ApprovalStatus {
  const recorded = recordedSet(entry);
  const checked = current !== null;
  const sameRuleset = current !== null && entry.rulesetDigest === current.rulesetDigest;
  const lockMatches =
    recorded === null || current === null || !sameRuleset
      ? null
      : current.digest === entry.capabilityDigest;
  const base = { stale: [] as string[], lockMatches, checked };
  if (!hasBoundApproval(entry) || recorded === null) return { ...base, state: 'unapproved' };
  if (current === null) return { ...base, state: 'unapproved' };
  if (strictOutcome === 'block') return { ...base, state: 'not-approvable' };
  if (sameRuleset) {
    return { ...base, state: lockMatches === true ? 'approved' : 'unapproved' };
  }
  if (capabilitiesCovered(current.set, recorded)) return { ...base, state: 'approved-carried' };
  return {
    ...base,
    state: 'stale',
    stale: expansionTokens(diffCapabilities(recorded, current.set)),
  };
}

/**
 * The approved baseline B (design §4.2): `approved` → the rescanned set; `approved-carried` and
 * `stale` → the rescanned set intersected with the recorded one; anything else → empty.
 */
export function approvedBaseline(
  entry: LockEntry,
  current: CapabilityReport | null,
  status: ApprovalStatus,
): CapabilitySet {
  const recorded = recordedSet(entry);
  if (current === null || recorded === null) return emptyCapabilitySet();
  switch (status.state) {
    case 'approved':
      return normalizeCapabilitySet(current.set);
    case 'approved-carried':
    case 'stale':
      return intersectCapabilities(current.set, recorded);
    default:
      return emptyCapabilitySet();
  }
}

/**
 * Approval as far as the lock alone can tell (no rescan; used by `list`): 'approved' when a
 * bound approval exists under the current ruleset, 'recheck' when it was recorded under another
 * ruleset, else 'unapproved'.
 */
export function recordedApproval(
  entry: LockEntry,
  rulesetDigest: string,
): 'approved' | 'recheck' | 'unapproved' {
  if (!hasBoundApproval(entry)) return 'unapproved';
  return entry.rulesetDigest === rulesetDigest ? 'approved' : 'recheck';
}
