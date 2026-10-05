/**
 * Shared contracts for every agenthub package.
 * Design reference: docs/specs/2026-10-04-agenthub-mvp-design.md
 */

export const AGENT_IDS = ['claude-code', 'codex', 'cursor', 'vscode'] as const;
export type AgentId = (typeof AGENT_IDS)[number];
export type Scope = 'project' | 'user';

// ---------------------------------------------------------------------------
// Skill package
// ---------------------------------------------------------------------------

/** SKILL.md frontmatter (Agent Skills spec). Unknown keys are vendor extensions. */
export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  'allowed-tools'?: string;
  [key: string]: unknown;
}

export type FsWriteScope = 'project' | 'home' | 'temp';

/** agenthub.yaml, schema 1 (design §5.2). */
export interface SkillManifest {
  schema: 1;
  version: string;
  targets?: AgentId[];
  requires?: {
    runtimes?: Record<string, string>;
    commands?: string[];
    mcp?: string[];
  };
  permissions?: {
    network?: boolean | string[];
    exec?: string[];
    env?: string[];
    secrets?: string[];
    fs?: { write?: FsWriteScope[] };
  };
  channel?: 'stable' | 'beta';
}

export interface PackageFile {
  /** POSIX relative path, already checked by the path-safety rules (design §5.4). */
  path: string;
  /** Normalized bytes: text files are LF-only, binary files untouched. */
  content: Uint8Array;
  /**
   * 'text' = no NUL bytes and either valid UTF-8 or a known text/script type (extension or
   * shebang). Text files may therefore contain invalid UTF-8; consumers must decode leniently.
   */
  kind: 'text' | 'binary';
  /** True when the file starts with "#!" (written with mode 0755 on POSIX). */
  executable: boolean;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  /** Stable machine code, e.g. 'name.format', 'description.missing'. */
  code: string;
  message: string;
  path?: string;
}

export interface SkillPackage {
  name: string;
  version: string;
  frontmatter: SkillFrontmatter;
  /** SKILL.md body after the frontmatter block. */
  body: string;
  /** Parsed agenthub.yaml, or null when absent. */
  manifest: SkillManifest | null;
  /** Sorted by path (UTF-8 byte order). */
  files: PackageFile[];
  /** path -> 'sha256:<hex>' of normalized bytes. */
  fileHashes: Record<string, string>;
  /** Content digest 'sha256:<hex>' (design §5.5) — the identity of this version. */
  digest: string;
  /** Warnings only; errors are thrown as AgentHubError('VALIDATION'). */
  issues: ValidationIssue[];
}

export interface PackageLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxPathLength: number;
  maxDepth: number;
}

// ---------------------------------------------------------------------------
// Scanner and policy
// ---------------------------------------------------------------------------

export type FindingCategory =
  | 'exec'
  | 'network'
  | 'download-exec'
  | 'secrets'
  | 'env'
  | 'dynamic'
  | 'obfuscation'
  | 'persistence'
  | 'deps'
  | 'prompt'
  | 'hidden'
  | 'binary'
  | 'remote-instructions';

export interface Finding {
  ruleId: string;
  category: FindingCategory;
  severity: 'medium' | 'high';
  /** False for categories that can never be declared away (design §8.2). */
  declarable: boolean;
  file: string;
  /** 1-based line; 0 when the finding concerns the whole file. */
  line: number;
  /** Short excerpt (≤ 120 chars) with control and invisible characters escaped. */
  evidence: string;
  message: string;
  /** What was touched: command name, host, env var, secret path. Used to match declarations. */
  subject?: string;
}

export interface ScanResult {
  scannerVersion: string;
  findings: Finding[];
  /**
   * Identity of the rules that produced this result ('sha256:<hex>'). A capability approval is
   * bound to it. Optional for older producers: the engine then derives one from scannerVersion.
   */
  rulesetDigest?: string;
  /** Outbound references found in the files (sorted, merged). Absent = none reported. */
  externals?: ExternalRef[];
}

// ---------------------------------------------------------------------------
// Capabilities (trust features design §1)
// ---------------------------------------------------------------------------

/** Keys of a capability set, in canonical (sorted) order. */
export const CAPABILITY_KEYS = [
  'binaries',
  'dynamic',
  'env',
  'exec',
  'fsWrite',
  'installers',
  'markers',
  'network',
  'prompt',
  'secrets',
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export const EXTERNAL_KINDS = ['url', 'git', 'npm', 'pypi', 'crates', 'mcp'] as const;
export type ExternalKind = (typeof EXTERNAL_KINDS)[number];
export const EXTERNAL_PINS = ['sha256', 'commit', 'version', 'unpinned'] as const;
export type ExternalPin = (typeof EXTERNAL_PINS)[number];
export const EXTERNAL_ROLES = ['reference', 'fetch', 'install', 'run', 'instructions'] as const;
export type ExternalRole = (typeof EXTERNAL_ROLES)[number];

/** Something outside the package that the skill points at, fetches, installs or runs. */
export interface ExternalRef {
  kind: ExternalKind;
  /** Canonical id: a normalized URL, 'host/owner/repo' for git, or a package name. */
  id: string;
  /** url, git and mcp only; '*' when the host is templated. */
  host?: string;
  /** How firmly the reference names fixed content. */
  pin: ExternalPin;
  /** Hash, 40-hex commit, exact version, or the mutable ref (branch, tag, range); else null. */
  pinValue: string | null;
  role: ExternalRole;
}

/** Sorted, unique string tokens per capability key. */
export type CapabilityTokens = Record<CapabilityKey, string[]>;

/** What a version can do: observed and declared tokens per key, plus its externals. */
export interface CapabilitySet extends CapabilityTokens {
  externals: ExternalRef[];
}

export interface CapabilityReport {
  set: CapabilitySet;
  /** capabilityDigest: 'sha256:<hex>' of the canonical set. */
  digest: string;
  rulesetDigest: string;
  /** 'key:token' observed but not covered by the manifest. Not part of the digest. */
  undeclared: string[];
  /** 'key:token' declared, with no finding it covers. Not part of the digest. */
  unobserved: string[];
}

export interface ExternalChange {
  change: 'pin-changed' | 'pin-loosened' | 'role-escalated';
  from: ExternalRef;
  to: ExternalRef;
}

export interface CapabilityDelta {
  added: CapabilityTokens;
  removed: CapabilityTokens;
  externals: {
    added: ExternalRef[];
    removed: ExternalRef[];
    changed: ExternalChange[];
    tightened: { from: ExternalRef; to: ExternalRef }[];
  };
  /** True when the candidate can do anything the baseline could not (design §2). */
  expansion: boolean;
  /** Sorted display tokens, e.g. '+network:x.example', '~npm:tool 1.2.3 → ^1 (pin loosened)'. */
  reasons: string[];
}

export interface FileChangeSummary {
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: number;
  /** SKILL.md line counts (LF-normalized); before is null when unknown. */
  skillMd: { before: number | null; after: number; delta: number | null };
}

export type FindingDecision = 'INFO' | 'WARN' | 'BLOCK';

export interface EvaluatedFinding extends Finding {
  declared: boolean;
  decision: FindingDecision;
}

export interface PolicyResult {
  findings: EvaluatedFinding[];
  /** allow = nothing above INFO; confirm = at least one WARN; block = at least one BLOCK. */
  outcome: 'allow' | 'confirm' | 'block';
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type Confidence = 'high' | 'medium' | 'low';

export interface AgentPathTable {
  /** POSIX paths relative to the project root, e.g. '.claude/skills'. */
  project: string[];
  /** POSIX paths relative to the home directory, e.g. '.claude/skills'. */
  user: string[];
  /** Official documentation URLs the paths were verified against. */
  sources: string[];
  /** ISO date of verification. */
  verifiedAt: string;
}

export interface AgentEnvironment {
  id: AgentId;
  displayName: string;
  confidence: Confidence;
  version?: string;
  executable?: string;
  /** Human-readable reasons, e.g. 'found ~/.cursor', 'cursor --version → 3.15.6'. */
  evidence: string[];
  status: 'verified' | 'experimental';
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Everything detection may touch. Read-only by construction. */
export interface DetectContext {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  which(command: string): Promise<string | null>;
  run(command: string, args: string[], timeoutMs: number): Promise<RunResult>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
}

export interface AgentAdapter {
  id: AgentId;
  displayName: string;
  status: 'verified' | 'experimental';
  paths: AgentPathTable;
  /** Shown after an install creates a new skills folder for this agent. */
  reloadHint?: string;
  detect(ctx: DetectContext): Promise<AgentEnvironment | null>;
  /** Does this agent read skills from `dir` (POSIX, relative to project root or home) at `scope`? */
  reads(scope: Scope, dir: string): boolean;
}

/** One folder to write a skill into, and the agents that will see it there. */
export interface TargetFolder {
  /** POSIX skills folder relative to project root or home, e.g. '.agents/skills'. */
  dir: string;
  agents: AgentId[];
}

// ---------------------------------------------------------------------------
// Lock and config
// ---------------------------------------------------------------------------

/** A recorded human decision: these capabilities of this digest, under this ruleset. */
export interface LockApproval {
  digest: string;
  capabilityDigest: string;
  rulesetDigest: string;
  approvedAt: string;
  /** Self-asserted (AGENTHUB_APPROVED_BY); the evidence is the commit that changes the lock. */
  approvedBy?: string;
  note?: string;
}

export interface LockEntry {
  version: string;
  digest: string;
  source: 'file' | 'dir' | 'registry';
  registry: string | null;
  installedTargets: AgentId[];
  /** Installed skill folder (relative to the project root, or '~/'-prefixed in the user lock) -> agents. */
  paths: Record<string, AgentId[]>;
  /** Relative file path inside the skill -> 'sha256:<hex>'. */
  files: Record<string, string>;
  installedAt: string;
  /**
   * Capability block (lock v2). All four are present or all absent; absent = an entry carried
   * over from a v1 lock that no command has touched since.
   */
  capabilities?: CapabilityTokens;
  capabilityDigest?: string;
  rulesetDigest?: string;
  externals?: ExternalRef[];
  /** Present only when a person approved this digest's capability set. */
  approval?: LockApproval;
  /** Reserved: round-tripped verbatim, never written by this release. Blocks digest changes. */
  signer?: Record<string, string>;
  /** Reserved: round-tripped verbatim. Present ⇒ install, update and restore are blocked. */
  quarantine?: Record<string, string>;
}

/** In memory every lock is v2; a v1 file is upgraded on the next write. */
export interface LockFile {
  lockfileVersion: 2;
  skills: Record<string, LockEntry>;
}

export interface AgentHubConfig {
  /** 'https://…' for a hosted registry, or 'file:<dir>' for a local folder registry. */
  registry?: string;
  agents?: AgentId[] | 'detected';
  channel?: 'stable' | 'beta';
  telemetry?: boolean;
}
