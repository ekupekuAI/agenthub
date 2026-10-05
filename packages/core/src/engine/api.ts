/**
 * Install engine contract (design §6, §8). Implemented in ./engine.ts, consumed by the CLI.
 * Core stays independent of the scanner and adapter packages: they are injected as ports.
 */
import type {
  AgentEnvironment,
  AgentHubConfig,
  AgentId,
  CapabilityDelta,
  CapabilityReport,
  CapabilitySet,
  EvaluatedFinding,
  FileChangeSummary,
  Finding,
  LockApproval,
  LockEntry,
  PolicyResult,
  ScanResult,
  Scope,
  SkillManifest,
  TargetFolder,
  ValidationIssue,
} from '../types';
import type { ApprovalState } from './approval';

export type { ApprovalState, ApprovalStatus } from './approval';

// ---------------------------------------------------------------------------
// Ports (injected by the CLI)
// ---------------------------------------------------------------------------

export interface AgentPort {
  detect(): Promise<AgentEnvironment[]>;
  selectTargets(scope: Scope, agents: AgentId[]): TargetFolder[];
  duplicates(scope: Scope, folders: TargetFolder[]): AgentId[];
  reads(agent: AgentId, scope: Scope, dir: string): boolean;
  reloadHint(agent: AgentId): string | undefined;
  /** Path-table version shown by doctor. */
  tableVersion: string;
  /**
   * Whether agenthub may install into `dir`: exact match against the write candidates for the
   * scope, no trimming or normalisation, never a legacy folder such as `.codex/skills`
   * (@agenthub/adapters `isWritableSkillsDir`). Lock-derived and fixed target folders must pass
   * it. Optional for compatibility; when absent only `reads()` and strict segment rules apply.
   */
  isWritable?(scope: Scope, dir: string): boolean;
}

export interface SecurityPort {
  /**
   * Identity of the scanner rules ('sha256:<hex>'), the same value scan() reports. Optional:
   * when absent the engine asks scan([]) and, failing that, derives one from scannerVersion.
   */
  readonly rulesetDigest?: string;
  scan(files: { path: string; content: Uint8Array; kind?: 'text' | 'binary' }[]): ScanResult;
  evaluate(
    findings: Finding[],
    manifest: SkillManifest | null,
    opts?: { dev?: boolean },
  ): PolicyResult;
}

export interface RequirementProbe {
  /** Installed version of a runtime (node, python, …) or null when absent. */
  runtime(name: string): Promise<string | null>;
  /** Whether a command is on PATH. */
  command(name: string): Promise<boolean>;
}

export interface RegistryVersion {
  version: string;
  digest: string;
  archiveDigest?: string;
  status: 'active' | 'quarantined' | 'revoked';
  channel?: 'stable' | 'beta';
  agents?: AgentId[];
  revokedReason?: string;
  createdAt?: string;
}

export interface SearchResult {
  slug: string;
  name: string;
  summary: string;
  category?: string;
  latestVersion: string | null;
  publisher?: { name: string; verified: boolean };
  agents: AgentId[];
  scanOutcome?: 'allow' | 'confirm' | 'block';
  updatedAt?: string;
}

/**
 * Capabilities as reported by a registry for one version (trust features §10.4). Display only:
 * every gate uses the report computed locally from verified bytes.
 */
export interface VersionCapabilities {
  set: CapabilitySet;
  digest: string;
  rulesetDigest: string;
  undeclared: string[];
  unobserved: string[];
}

/** A registry's capability diff between two stored versions (GET /skills/:slug/diff). */
export interface VersionDiff {
  slug: string;
  from: { version: string; digest: string };
  to: { version: string; digest: string };
  /** False when the two versions were analyzed under different rulesets. */
  comparable: boolean;
  delta: CapabilityDelta | null;
  files: FileChangeSummary;
}

export interface SkillInfoVersion extends RegistryVersion {
  /** Reported by the registry; recomputed locally at install. */
  capabilities?: VersionCapabilities;
  skillMdLines?: number;
  sizeBytes?: number;
  requirements?: {
    kind: 'runtime' | 'command' | 'mcp';
    name: string;
    constraint?: string | null;
  }[];
  permissions?: SkillManifest['permissions'];
  scan?: {
    scannerVersion: string;
    outcome: 'allow' | 'confirm' | 'block';
    findings: EvaluatedFinding[];
  };
  releaseNotes?: string | null;
}

export interface SkillInfo {
  slug: string;
  name: string;
  summary: string;
  category?: string;
  publisher?: { name: string; verified: boolean };
  latest: SkillInfoVersion | null;
  versions: SkillInfoVersion[];
}

/** A source of published packages: a local folder registry or a hosted registry. */
export interface RegistrySource {
  /** 'file:<dir>' or 'https://…' — recorded in the lock. */
  readonly id: string;
  /** All versions of a skill. Throws AgentHubError('NOT_FOUND') for unknown skills. */
  listVersions(name: string): Promise<RegistryVersion[]>;
  /** Raw .skillpkg bytes; implementations must verify the archive digest they were promised. */
  download(
    name: string,
    version: string,
  ): Promise<{ bytes: Uint8Array; archiveDigest: string; digest?: string }>;
  search?(query: string, opts?: { agent?: AgentId; category?: string }): Promise<SearchResult[]>;
  info?(name: string): Promise<SkillInfo>;
}

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

export type SourceSpec =
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string }
  | { kind: 'registry'; name: string; range?: string };

export interface InstallRequest {
  source: SourceSpec;
  scope: Scope;
  /** Explicit agents (--agent). Default: detected agents with high/medium confidence (design D3). */
  agents?: AgentId[];
  dev?: boolean;
  force?: boolean;
  channel?: 'stable' | 'beta';
}

export interface PlannedTarget {
  /** Skills folder, e.g. '.claude/skills'. */
  dir: string;
  /** Absolute path of the installed skill folder, e.g. '<root>/.claude/skills/web-testing'. */
  absDir: string;
  /** Key used in the lock `paths` map: relative to the project root, or '~/'-prefixed for user scope. */
  lockPath: string;
  agents: AgentId[];
  action: 'create' | 'replace' | 'unchanged';
  /** Files that differ from the lock (hand edits) when replacing a managed skill. */
  drift?: string[];
  /** True when the folder exists but is not managed by agenthub (or is a symlink/junction). */
  unmanaged?: boolean;
}

export interface RequirementCheck {
  kind: 'runtime' | 'command' | 'mcp';
  name: string;
  constraint?: string;
  found?: string | null;
  /** null = cannot be checked locally (MCP servers). */
  ok: boolean | null;
}

/** Who approved and why (all optional; the approval itself is the confirmed plan). */
export interface ApprovalInput {
  /** Self-asserted approver (AGENTHUB_APPROVED_BY). */
  by?: string;
  note?: string;
  /** How the approval was given; written to the audit log, never to the lock. */
  mode?: 'prompt' | 'yes' | 'flag' | 'command';
}

/**
 * The capability view of a plan (trust features §4). `candidate` is computed from the package
 * the plan applies; the baseline from the installed entry (intact copy or cache, never the
 * registry).
 */
export interface PlanCapabilities {
  rulesetDigest: string;
  candidate: CapabilityReport;
  /**
   * State of the installed entry: 'fresh' = nothing installed; 'same-digest' = the plan carries
   * the installed entry (restore, re-target); 'unavailable' = no intact copy or cache to rescan.
   */
  state: ApprovalState | 'fresh' | 'same-digest' | 'unavailable';
  /** Tokens the current ruleset sees that the existing approval does not cover. */
  stale: string[];
  /** Candidate vs. the installed version's current set ("what changes on disk"); null = fresh. */
  delta: CapabilityDelta | null;
  /** Candidate vs. the approved baseline; its `expansion` is the gate. */
  unapproved: CapabilityDelta;
  /** True when applying needs an explicit capability approval (an expansion on a replace). */
  approvalRequired: boolean;
  /** False when the strict policy outcome is block: no approval is ever written. */
  approvable: boolean;
  /** Strict policy outcome of the installed version (for `update --safe`); null when unknown. */
  previousOutcome: PolicyResult['outcome'] | null;
  /** File-level changes against the installed version (display only); null for a fresh install. */
  files: FileChangeSummary | null;
}

export interface InstallPlan {
  id: string;
  skill: { name: string; version: string; digest: string; archiveDigest?: string };
  source: SourceSpec & { registry?: string };
  scope: Scope;
  scopeRoot: string;
  agents: AgentEnvironment[];
  targets: PlannedTarget[];
  duplicates: AgentId[];
  policy: PolicyResult;
  requirements: RequirementCheck[];
  /** Validation warnings. */
  issues: ValidationIssue[];
  /** Reasons the plan cannot be applied (policy block, incompatible, drift/unmanaged without --force, revoked). */
  blockers: {
    code: 'POLICY_BLOCKED' | 'INCOMPATIBLE' | 'DRIFT' | 'CONFLICT' | 'REVOKED';
    message: string;
  }[];
  /** True when the user must confirm (any WARN finding, or replacing an installed version). */
  needsConfirmation: boolean;
  /** Capability inventory, delta and gate. Absent on plans that can never be applied. */
  capabilities?: PlanCapabilities;
  hints: string[];
  previous?: LockEntry;
  dev: boolean;
  force: boolean;
}

export interface InstallResult {
  name: string;
  version: string;
  digest: string;
  scope: Scope;
  targets: { dir: string; lockPath: string; agents: AgentId[] }[];
  snapshot?: string;
  hints: string[];
}

export interface RemoveResult {
  name: string;
  scope: Scope;
  removed: string[];
  kept: string[];
}

export interface VerifyFileStatus {
  path: string;
  status: 'ok' | 'modified' | 'missing' | 'extra';
}

export interface VerifyReport {
  name: string;
  scope: Scope;
  version: string;
  digest: string;
  ok: boolean;
  targets: { lockPath: string; ok: boolean; files: VerifyFileStatus[] }[];
  /**
   * Approval state from a rescan of the installed bytes (verify only). `lockMatches: false`
   * means the lock's capability record does not describe the bytes (exit 4).
   */
  capabilities?: {
    state: ApprovalState;
    stale: string[];
    lockMatches: boolean | null;
    /** False when there was no intact copy or cache entry to rescan. */
    checked: boolean;
    /** True for an entry without a capability block (written by an older agenthub). */
    missingBlock: boolean;
  };
}

export interface ListedSkill {
  name: string;
  version: string;
  scope: Scope;
  agents: AgentId[];
  source: LockEntry['source'];
  registry: string | null;
  status: 'ok' | 'drift' | 'missing';
  installedAt: string;
  /** From the lock alone (no rescan): 'recheck' = approved under another scanner ruleset. */
  approval: 'approved' | 'unapproved' | 'recheck';
  capabilityDigest?: string;
  approvedAt?: string;
  approvedBy?: string;
}

/** Result of Engine.approve(). */
export interface ApproveResult {
  name: string;
  scope: Scope;
  version: string;
  approval: LockApproval;
  /** State before this approval. */
  previousState: ApprovalState;
  /** What was not approved before ('key:token', 'external:kind:id'). */
  newlyApproved: string[];
  report: CapabilityReport;
  dryRun: boolean;
}

/** `agenthub diff`: the installed entry against a registry version (trust features §6.1). */
export interface SkillDiff {
  name: string;
  scope: Scope;
  from: { version: string; digest: string; capabilityDigest: string | null };
  to: { version: string; digest: string; capabilityDigest: string };
  rulesetDigest: string;
  /** Approval state of the installed entry, or 'unavailable' without an intact copy or cache. */
  baseline: ApprovalState | 'unavailable';
  /** Candidate vs. the installed version's current set (vs. its record when unavailable). */
  delta: CapabilityDelta;
  /** What would need approval: candidate vs. the approved baseline. */
  unapproved: string[];
  approvalRequired: boolean;
  /** Candidate inventory and mismatch lists. */
  candidate: CapabilityReport;
  files: FileChangeSummary;
}

export interface UpdateCandidate {
  name: string;
  scope: Scope;
  current: string;
  latest: string | null;
  latestCompatible: string | null;
  status:
    | 'up-to-date'
    | 'available'
    | 'current-revoked'
    | 'not-in-registry'
    | 'drift'
    /** The current version is quarantined by the registry. */
    | 'current-quarantined'
    /** Installed from another registry than the configured one: reinstall explicitly. */
    | 'registry-mismatch'
    /** The registry's copy of the installed version has different contents than the lock. */
    | 'digest-mismatch';
  reason?: string;
  /**
   * Capability change of the available version against the approved baseline (filled by
   * checkUpdates with `capabilities: true`, status 'available' only).
   */
  change?: {
    expansion: boolean;
    /** What would need approval, as 'key:token' / 'external:kind:id'. */
    unapproved: string[];
    /** Tokens the installed version had that the candidate drops. */
    removed: number;
    state: PlanCapabilities['state'];
  };
}

/** Options of restore() / planRestore() (`agenthub install` with no argument). */
export interface RestoreOptions {
  dev?: boolean;
  force?: boolean;
  /**
   * Asked once per plan with `needsConfirmation` (WARN findings, a --dev override, or folders that
   * would be replaced), after every plan was made and before anything is applied. Without it,
   * restore() refuses such plans with USAGE; answering false cancels the restore (CANCELLED).
   */
  confirm?: (plan: InstallPlan) => Promise<boolean>;
}

export interface DoctorProblem {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

export interface DoctorReport {
  agents: AgentEnvironment[];
  pathTableVersion: string;
  projectRoot: string | null;
  scopes: { scope: Scope; root: string; lockPath: string; lockExists: boolean; skills: number }[];
  problems: DoctorProblem[];
  pendingJournals: string[];
  cacheBytes: number;
}

export type ConfigSource = 'flag' | 'env' | 'project' | 'user' | 'default';

export interface ResolvedConfig {
  effective: AgentHubConfig;
  sources: Partial<Record<keyof AgentHubConfig, ConfigSource>>;
  /** Ignored project settings (e.g. an untrusted project registry), for plans and doctor. */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface EngineDeps {
  cwd: string;
  /** User home directory (user scope root). */
  home: string;
  /** Machine-local state directory, normally '<home>/.agenthub' or $AGENTHUB_HOME. */
  agenthubHome: string;
  agents: AgentPort;
  security: SecurityPort;
  probe: RequirementProbe;
  registry?: RegistrySource | null;
  now?: () => Date;
  /** Test hooks only. */
  hooks?: {
    /** Called after each target is swapped in, before validation. Throwing simulates a failure. */
    afterSwap?: (absDir: string) => void | Promise<void>;
    /** When a step fails, leave everything as a crashed process would (no undo, journal kept). */
    simulateCrash?: boolean;
  };
}

export interface Engine {
  readonly projectRoot: string | null;
  /** 'project' inside a repo (or a folder with .agenthub/), otherwise 'user'. */
  defaultScope(): Scope;
  /** Throws AgentHubError('USAGE') for project scope outside a project. */
  scopeRoot(scope: Scope): string;
  plan(req: InstallRequest): Promise<InstallPlan>;
  /**
   * Refuses (throws) when plan.blockers is non-empty. Recomputes the capability gate from the
   * lock as read here: a replace whose candidate expands beyond the approved baseline throws
   * APPROVAL_REQUIRED unless `opts.approve` is given. A fresh install records the approval
   * (the confirmed plan is the approval); an update without expansion carries it forward.
   */
  apply(plan: InstallPlan, opts?: { approve?: ApprovalInput }): Promise<InstallResult>;
  /**
   * Approve the installed digest's capability set under the current ruleset. The installed
   * bytes must verify (DRIFT otherwise); refused (POLICY_BLOCKED) when the strict outcome is
   * block or the entry is quarantined. Writes only the lock and the audit log; with
   * `dryRun` it writes nothing and returns what would be approved.
   */
  approve(
    name: string,
    scope: Scope,
    input?: ApprovalInput,
    opts?: { dryRun?: boolean },
  ): Promise<ApproveResult>;
  /** Capability and file diff of the installed entry against a registry version (read-only). */
  diff(
    name: string,
    scope: Scope,
    opts?: { to?: string; channel?: 'stable' | 'beta' },
  ): Promise<SkillDiff>;
  /**
   * `agenthub install` with no argument: reinstall/verify every lock entry of the scope. Every
   * entry is planned first; any blocker aborts before anything is written, and plans that need
   * confirmation go through `opts.confirm` (see RestoreOptions).
   */
  restore(scope: Scope, opts?: RestoreOptions): Promise<InstallResult[]>;
  /**
   * The plans restore() would apply, one per lock entry (sorted by name), for callers that show
   * and confirm each plan themselves and then call apply(). Plans may carry blockers (REVOKED,
   * CONFLICT, …); they are never applied by this call.
   */
  planRestore(scope: Scope, opts?: { dev?: boolean; force?: boolean }): Promise<InstallPlan[]>;
  remove(
    name: string,
    scope: Scope,
    opts?: { force?: boolean; dryRun?: boolean },
  ): Promise<RemoveResult>;
  verify(scope: Scope, name?: string): Promise<VerifyReport[]>;
  list(scope?: Scope): Promise<ListedSkill[]>;
  /**
   * Read-only. With `capabilities: true`, each available candidate is downloaded and verified
   * in memory and `change` reports whether it expands beyond the approved baseline.
   */
  checkUpdates(
    scope: Scope,
    names?: string[],
    opts?: { channel?: 'stable' | 'beta'; capabilities?: boolean },
  ): Promise<UpdateCandidate[]>;
  /** Plan an update to the highest compatible version; null when already up to date. */
  planUpdate(
    name: string,
    scope: Scope,
    opts?: { range?: string; dev?: boolean; force?: boolean; channel?: 'stable' | 'beta' },
  ): Promise<InstallPlan | null>;
  /** Restore the last snapshot through the transaction engine. */
  rollback(name: string, scope: Scope): Promise<InstallResult>;
  /** Finish or undo interrupted transactions; returns human-readable messages. */
  recover(): Promise<string[]>;
  doctor(): Promise<DoctorReport>;
}
