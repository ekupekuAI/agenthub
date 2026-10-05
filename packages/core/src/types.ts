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
  | 'binary';

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
}

export interface LockFile {
  lockfileVersion: 1;
  skills: Record<string, LockEntry>;
}

export interface AgentHubConfig {
  /** 'https://…' for a hosted registry, or 'file:<dir>' for a local folder registry. */
  registry?: string;
  agents?: AgentId[] | 'detected';
  channel?: 'stable' | 'beta';
  telemetry?: boolean;
}
