/**
 * Strict parsing of hosted-registry JSON (MVP §12). The registry is remote input: every field
 * is checked for type, enumerations, string length and list size before a command sees it, and
 * unknown keys are dropped. `null` counts as "absent" for optional fields; any other mismatch is
 * a malformed response.
 */
import type {
  AgentId,
  CapabilitySet,
  EvaluatedFinding,
  ExternalRef,
  RegistryVersion,
  SearchResult,
  SkillInfo,
  SkillInfoVersion,
  SkillManifest,
  VersionCapabilities,
} from '@agenthub/core';
import {
  AGENT_IDS,
  CAPABILITY_KEYS,
  EXTERNAL_KINDS,
  EXTERNAL_PINS,
  EXTERNAL_ROLES,
} from '@agenthub/core';

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const LIMITS = {
  short: 200,
  text: 1000,
  notes: 20_000,
  list: 1000,
  findings: 500,
  results: 500,
} as const;

/** Thrown for any malformed value; the caller maps it to AgentHubError('REGISTRY'). */
export class MalformedError extends Error {
  constructor(readonly what: string) {
    super(`malformed ${what}`);
  }
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, what: string): Json {
  if (!isRecord(value)) throw new MalformedError(what);
  return value;
}

function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function str(value: unknown, what: string, max: number = LIMITS.short): string {
  if (typeof value !== 'string' || value.length > max) throw new MalformedError(what);
  return value;
}

function optStr(value: unknown, what: string, max: number = LIMITS.short): string | undefined {
  return present(value) ? str(value, what, max) : undefined;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new MalformedError(what);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new MalformedError(what);
  }
  return value;
}

function list(value: unknown, what: string, max: number = LIMITS.list): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new MalformedError(what);
  return value;
}

function strings(value: unknown, what: string): string[] {
  return list(value, what, 200).map((item) => str(item, what));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new MalformedError(what);
  }
  return value as T;
}

/** Agent ids; ids this CLI does not know are dropped rather than trusted. */
function agents(value: unknown, what: string): AgentId[] {
  return list(value, what, 50)
    .map((item) => str(item, what))
    .filter((id): id is AgentId => (AGENT_IDS as readonly string[]).includes(id));
}

function assign<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined) {
  if (value !== undefined) target[key] = value;
}

export function parseRegistryVersion(value: unknown): RegistryVersion {
  const raw = record(value, 'version entry');
  const version = str(raw.version, 'version', 256);
  if (!SEMVER.test(version)) throw new MalformedError('version');
  const digest = str(raw.digest, 'digest');
  if (!DIGEST.test(digest)) throw new MalformedError('digest');
  const out: RegistryVersion = {
    version,
    digest,
    status: oneOf(raw.status, ['active', 'quarantined', 'revoked'] as const, 'version status'),
  };
  if (present(raw.archiveDigest)) {
    const archive = str(raw.archiveDigest, 'archive digest');
    if (!DIGEST.test(archive)) throw new MalformedError('archive digest');
    out.archiveDigest = archive;
  }
  if (present(raw.channel))
    out.channel = oneOf(raw.channel, ['stable', 'beta'] as const, 'channel');
  if (present(raw.agents)) out.agents = agents(raw.agents, 'version agents');
  assign(out, 'revokedReason', optStr(raw.revokedReason, 'revoked reason', LIMITS.text));
  assign(out, 'createdAt', optStr(raw.createdAt, 'created time'));
  return out;
}

function parsePublisher(value: unknown): { name: string; verified: boolean } | undefined {
  if (!present(value)) return undefined;
  const raw = record(value, 'publisher');
  return { name: str(raw.name, 'publisher name'), verified: bool(raw.verified, 'publisher') };
}

function parsePermissions(value: unknown): SkillManifest['permissions'] | undefined {
  if (!present(value)) return undefined;
  const raw = record(value, 'permissions');
  const out: NonNullable<SkillManifest['permissions']> = {};
  if (present(raw.network)) {
    out.network =
      typeof raw.network === 'boolean' ? raw.network : strings(raw.network, 'network permission');
  }
  if (present(raw.exec)) out.exec = strings(raw.exec, 'exec permission');
  if (present(raw.env)) out.env = strings(raw.env, 'env permission');
  if (present(raw.secrets)) out.secrets = strings(raw.secrets, 'secrets permission');
  if (present(raw.fs)) {
    const fs = record(raw.fs, 'fs permission');
    if (present(fs.write)) {
      out.fs = {
        write: strings(fs.write, 'fs permission') as NonNullable<
          NonNullable<SkillManifest['permissions']>['fs']
        >['write'],
      };
    } else {
      out.fs = {};
    }
  }
  return out;
}

function parseFinding(value: unknown): EvaluatedFinding {
  const raw = record(value, 'finding');
  const finding: EvaluatedFinding = {
    ruleId: str(raw.ruleId, 'finding rule'),
    category: str(raw.category, 'finding category') as EvaluatedFinding['category'],
    severity: oneOf(raw.severity, ['medium', 'high'] as const, 'finding severity'),
    declarable: bool(raw.declarable, 'finding'),
    file: str(raw.file, 'finding file', LIMITS.text),
    line: count(raw.line, 'finding line'),
    evidence: str(raw.evidence, 'finding evidence', LIMITS.text),
    message: str(raw.message, 'finding message', LIMITS.text),
    declared: bool(raw.declared, 'finding'),
    decision: oneOf(raw.decision, ['INFO', 'WARN', 'BLOCK'] as const, 'finding decision'),
  };
  assign(finding, 'subject', optStr(raw.subject, 'finding subject', LIMITS.text));
  return finding;
}

function tokenList(value: unknown, what: string): string[] {
  return list(value ?? [], what, 1024).map((item) => str(item, what, 256));
}

function parseExternal(value: unknown): ExternalRef {
  const raw = record(value, 'external');
  const out: ExternalRef = {
    kind: oneOf(raw.kind, EXTERNAL_KINDS, 'external kind'),
    id: str(raw.id, 'external id', 512),
    pin: oneOf(raw.pin, EXTERNAL_PINS, 'external pin'),
    pinValue: present(raw.pinValue) ? str(raw.pinValue, 'external pin value', 128) : null,
    role: oneOf(raw.role, EXTERNAL_ROLES, 'external role'),
  };
  assign(out, 'host', optStr(raw.host, 'external host', 255));
  return out;
}

/** Capabilities reported by the registry: display only, never used for a gate. */
function parseCapabilities(value: unknown): VersionCapabilities {
  const raw = record(value, 'capabilities');
  const setRaw = record(raw.set, 'capability set');
  const set = {
    externals: list(setRaw.externals ?? [], 'externals', 256).map(parseExternal),
  } as CapabilitySet;
  for (const key of CAPABILITY_KEYS) set[key] = tokenList(setRaw[key], `capabilities.${key}`);
  const digest = str(raw.digest, 'capability digest');
  const rulesetDigest = str(raw.rulesetDigest, 'ruleset digest');
  if (!DIGEST.test(digest) || !DIGEST.test(rulesetDigest))
    throw new MalformedError('capability digest');
  return {
    set,
    digest,
    rulesetDigest,
    undeclared: tokenList(raw.undeclared, 'undeclared capabilities'),
    unobserved: tokenList(raw.unobserved, 'unobserved capabilities'),
  };
}

function parseInfoVersion(value: unknown): SkillInfoVersion {
  const raw = record(value, 'version entry');
  const out: SkillInfoVersion = parseRegistryVersion(raw);
  if (present(raw.sizeBytes)) out.sizeBytes = count(raw.sizeBytes, 'size');
  if (present(raw.requirements)) {
    out.requirements = list(raw.requirements, 'requirements', 200).map((item) => {
      const req = record(item, 'requirement');
      const parsed: NonNullable<SkillInfoVersion['requirements']>[number] = {
        kind: oneOf(req.kind, ['runtime', 'command', 'mcp'] as const, 'requirement kind'),
        name: str(req.name, 'requirement name'),
      };
      assign(parsed, 'constraint', optStr(req.constraint, 'requirement constraint'));
      return parsed;
    });
  }
  assign(out, 'permissions', parsePermissions(raw.permissions));
  if (present(raw.scan)) {
    const scan = record(raw.scan, 'scan');
    out.scan = {
      scannerVersion: str(scan.scannerVersion, 'scanner version'),
      outcome: oneOf(scan.outcome, ['allow', 'confirm', 'block'] as const, 'scan outcome'),
      findings: list(scan.findings ?? [], 'findings', LIMITS.findings).map(parseFinding),
    };
  }
  if (present(raw.releaseNotes))
    out.releaseNotes = str(raw.releaseNotes, 'release notes', LIMITS.notes);
  if (present(raw.capabilities)) out.capabilities = parseCapabilities(raw.capabilities);
  if (present(raw.skillMdLines)) out.skillMdLines = count(raw.skillMdLines, 'SKILL.md lines');
  return out;
}

export function parseSkillInfo(value: unknown): SkillInfo {
  const raw = record(value, 'skill detail');
  const slug = str(raw.slug, 'skill slug');
  if (!SLUG.test(slug)) throw new MalformedError('skill slug');
  const out: SkillInfo = {
    slug,
    name: str(raw.name, 'skill name'),
    summary: optStr(raw.summary, 'summary', LIMITS.text) ?? '',
    latest: present(raw.latest) ? parseInfoVersion(raw.latest) : null,
    versions: present(raw.versions) ? list(raw.versions, 'version list').map(parseInfoVersion) : [],
  };
  assign(out, 'category', optStr(raw.category, 'category'));
  assign(out, 'publisher', parsePublisher(raw.publisher));
  return out;
}

export function parseSearchResults(value: unknown): SearchResult[] {
  return list(value, 'search results', LIMITS.results).map((item) => {
    const raw = record(item, 'search result');
    const slug = str(raw.slug, 'search result');
    if (!SLUG.test(slug)) throw new MalformedError('search result');
    const out: SearchResult = {
      slug,
      name: str(raw.name, 'search result'),
      summary: optStr(raw.summary, 'summary', LIMITS.text) ?? '',
      latestVersion: optStr(raw.latestVersion, 'latest version') ?? null,
      agents: present(raw.agents) ? agents(raw.agents, 'search agents') : [],
    };
    assign(out, 'category', optStr(raw.category, 'category'));
    assign(out, 'publisher', parsePublisher(raw.publisher));
    if (present(raw.scanOutcome)) {
      out.scanOutcome = oneOf(
        raw.scanOutcome,
        ['allow', 'confirm', 'block'] as const,
        'scan outcome',
      );
    }
    assign(out, 'updatedAt', optStr(raw.updatedAt, 'updated time'));
    return out;
  });
}
