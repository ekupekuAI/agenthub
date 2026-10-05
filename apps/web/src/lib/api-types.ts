/**
 * Wire shapes of the registry API. They mirror RegistryVersion / SearchResult / SkillInfo in
 * packages/core/src/engine/api.ts, which the CLI consumes; keep them structurally identical.
 */
import type { EvaluatedFinding, SkillManifest } from '@agenthub/core';
import type { Agent } from './validation';

export type ScanOutcome = 'allow' | 'confirm' | 'block';
export type VersionStatus = 'active' | 'quarantined' | 'revoked';

export interface RegistryVersion {
  version: string;
  digest: string;
  archiveDigest?: string;
  status: VersionStatus;
  channel?: 'stable' | 'beta';
  agents?: Agent[];
  revokedReason?: string;
  createdAt?: string;
}

export interface SkillInfoVersion extends RegistryVersion {
  sizeBytes?: number;
  requirements?: {
    kind: 'runtime' | 'command' | 'mcp';
    name: string;
    constraint?: string | null;
  }[];
  permissions?: SkillManifest['permissions'];
  scan?: {
    scannerVersion: string;
    outcome: ScanOutcome;
    /**
     * Findings of the latest scan, BLOCK first, at most MAX_STORED_FINDINGS. Only the latest
     * (and the displayed) version carries them in a skill detail; version lists and older
     * versions return an empty list, with `findingsTruncated: true` when there were findings.
     */
    findings: EvaluatedFinding[];
    /** ISO time of the scan (extension; not part of the CLI contract). */
    scannedAt?: string;
    /** Findings the scan produced in total (extension). */
    findingsTotal?: number;
    /** True when `findings` holds fewer than `findingsTotal` entries (extension). */
    findingsTruncated?: boolean;
    /** Findings per decision (extension). */
    counts?: { INFO: number; WARN: number; BLOCK: number };
  };
  releaseNotes?: string | null;
}

export interface PublisherRef {
  name: string;
  verified: boolean;
}

export interface SearchResult {
  slug: string;
  name: string;
  summary: string;
  category?: string;
  latestVersion: string | null;
  publisher?: PublisherRef;
  agents: Agent[];
  scanOutcome?: ScanOutcome;
  updatedAt?: string;
}

export interface SkillInfo {
  slug: string;
  name: string;
  summary: string;
  category?: string;
  publisher?: PublisherRef;
  latest: SkillInfoVersion | null;
  versions: SkillInfoVersion[];
}

export interface ResolveResult {
  slug: string;
  version: string;
  digest: string;
  archiveDigest: string;
  /** Path relative to the registry origin. */
  downloadUrl: string;
}
