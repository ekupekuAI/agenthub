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
    findings: EvaluatedFinding[];
    /** ISO time of the scan (extension; not part of the CLI contract). */
    scannedAt?: string;
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
