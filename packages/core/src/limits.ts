import type { PackageLimits } from './types';

const MiB = 1024 * 1024;

/** Package size limits (design §5.3). Callers may pass smaller limits for tests or dev. */
export const DEFAULT_LIMITS: Readonly<PackageLimits> = Object.freeze({
  maxFiles: 500,
  maxTotalBytes: 10 * MiB,
  maxFileBytes: 5 * MiB,
  maxPathLength: 200,
  maxDepth: 10,
});

/**
 * Limits for untrusted YAML (SKILL.md frontmatter and agenthub.yaml), enforced before and while
 * parsing so a small package cannot exhaust CPU or memory: `maxBytes` of UTF-8 source,
 * `maxDepth` levels of nested collections and `maxNodes` nodes in total.
 */
export const YAML_LIMITS: Readonly<{ maxBytes: number; maxDepth: number; maxNodes: number }> =
  Object.freeze({
    maxBytes: 64 * 1024,
    maxDepth: 32,
    maxNodes: 10_000,
  });
