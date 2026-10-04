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
