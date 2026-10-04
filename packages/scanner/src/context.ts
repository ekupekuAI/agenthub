import type { Finding } from '@agenthub/core';
import { RULES, type RuleId } from './rules';
import { makeEvidence } from './text';

export interface Hit {
  ruleId: RuleId;
  /** 1-based line; 0 for whole-file findings. */
  line: number;
  message: string;
  subject?: string;
  /** UTF-16 index into the line that the excerpt should include. */
  focus?: number;
  /** Explicit excerpt, used for whole-file findings. */
  evidence?: string;
  /** Analysis unit; set by `add` from `FileScan.scope`. */
  scope?: number;
}

/** Leading path variables that point at the skill folder or the script's own folder. */
const ROOT_PREFIX_RE = /^(?:\$\{?\w+\}?|%~?\w+%|\$PSScriptRoot|__SUBST__)\/+/i;

/** Per-file scanning state shared by the analyzers. */
export class FileScan {
  readonly hits: Hit[] = [];
  /**
   * Current analysis unit. The whole file is one unit, except in Markdown where each fenced
   * block is its own unit: `code.dynamic` is raised to high only when network access or
   * decoded data appears in the same unit.
   */
  scope = 0;
  private readonly decodeScopes = new Set<number>();

  constructor(
    readonly path: string,
    /** Raw lines (line endings removed); used for evidence. */
    readonly lines: readonly string[],
    /** Every path in the package, for recognizing bundled scripts. */
    readonly packagePaths: ReadonlySet<string>,
  ) {}

  add(hit: Hit): void {
    this.hits.push({ ...hit, scope: this.scope });
  }

  has(ruleId: RuleId, scope?: number): boolean {
    return this.hits.some((h) => h.ruleId === ruleId && (scope === undefined || h.scope === scope));
  }

  /** Records that the current unit decodes base64/hex data at runtime. */
  markDecodes(): void {
    this.decodeScopes.add(this.scope);
  }

  /** True when `ref` names a file shipped in the package (relative to the root or this file). */
  isBundled(ref: string): boolean {
    const p = ref
      .replace(/\\/g, '/')
      .replace(ROOT_PREFIX_RE, '')
      .replace(/^(?:\.\/)+/, '');
    if (p === '' || p.startsWith('/') || /^[a-z]+:/i.test(p)) return false;
    const slash = this.path.lastIndexOf('/');
    const fromRoot = normalize(p);
    const fromDir = slash < 0 ? null : normalize(`${this.path.slice(0, slash)}/${p}`);
    return (
      (fromRoot !== null && this.packagePaths.has(fromRoot)) ||
      (fromDir !== null && this.packagePaths.has(fromDir))
    );
  }

  toFindings(): Finding[] {
    const seen = new Set<string>();
    const out: Finding[] = [];
    const hits = [...this.hits].sort((a, b) => a.line - b.line);
    for (const hit of hits) {
      // Repeated reads of one variable add nothing: keep the first env.read per subject.
      const key =
        hit.ruleId === 'env.read'
          ? `${hit.ruleId}|${hit.subject ?? ''}`
          : `${hit.ruleId}|${hit.line}|${hit.subject ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rule = RULES[hit.ruleId];
      let severity: 'medium' | 'high' = rule.severity;
      let declarable: boolean = rule.declarable;
      let message = hit.message;
      const scope = hit.scope ?? 0;
      const net =
        hit.ruleId === 'code.dynamic' &&
        (this.has('net.access', scope) || this.has('net.download-exec', scope));
      const encoded =
        hit.ruleId === 'code.dynamic' &&
        (this.decodeScopes.has(scope) || this.has('code.obfuscated', scope));
      if (net || encoded) {
        severity = 'high';
        declarable = false;
        message += net
          ? ' in a file that also accesses the network'
          : ' in a file that decodes encoded data';
      }
      const finding: Finding = {
        ruleId: hit.ruleId,
        category: rule.category,
        severity,
        declarable,
        file: this.path,
        line: hit.line,
        evidence: hit.evidence ?? makeEvidence(this.lines[hit.line - 1] ?? '', hit.focus ?? 0),
        message,
      };
      if (hit.subject !== undefined) finding.subject = hit.subject;
      out.push(finding);
    }
    return out;
  }
}

/** Resolves `.` and `..` segments; null when the path climbs above the root. */
function normalize(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}
