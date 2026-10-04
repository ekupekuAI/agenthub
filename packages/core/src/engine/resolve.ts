/**
 * Version resolution against a registry's version list (design §8.1, MVP §6).
 */
import semver from 'semver';
import { AgentHubError } from '../errors';
import type { AgentId } from '../types';
import type { RegistryVersion } from './api';

export interface ResolveOptions {
  /** semver range or exact version; default '*'. */
  range?: string;
  channel?: 'stable' | 'beta';
  /** Selected agents; versions that declare `agents` must support at least one of them. */
  agents?: AgentId[];
}

export type ResolveOutcome =
  | { kind: 'ok'; version: RegistryVersion }
  | { kind: 'revoked'; version: RegistryVersion; reason: string }
  | { kind: 'none'; reason: string };

function supportsAgents(version: RegistryVersion, agents: AgentId[] | undefined): boolean {
  if (!agents || agents.length === 0 || !version.agents || version.agents.length === 0) return true;
  return agents.some((agent) => version.agents?.includes(agent));
}

function isBeta(version: RegistryVersion): boolean {
  return version.channel === 'beta' || semver.prerelease(version.version) !== null;
}

/**
 * Highest 'active' version satisfying the range. Stable only unless channel is 'beta'.
 * An exact pin to a revoked version reports 'revoked' so the plan can show why.
 */
export function resolveVersion(
  versions: RegistryVersion[],
  opts: ResolveOptions = {},
): ResolveOutcome {
  const range = (opts.range ?? '*').trim() || '*';
  const channel = opts.channel ?? 'stable';
  const exact = semver.valid(range);

  if (exact !== null) {
    const match = versions.find(
      (v) => semver.valid(v.version) !== null && semver.eq(v.version, exact),
    );
    if (!match) return { kind: 'none', reason: `version ${exact} does not exist` };
    if (match.status === 'revoked') {
      return {
        kind: 'revoked',
        version: match,
        reason: `version ${match.version} is revoked${match.revokedReason ? `: ${match.revokedReason}` : ''}`,
      };
    }
    if (match.status !== 'active') {
      return { kind: 'none', reason: `version ${match.version} is ${match.status}` };
    }
    if (!supportsAgents(match, opts.agents)) {
      return {
        kind: 'none',
        reason: `version ${match.version} supports ${match.agents?.join(', ')}, not ${opts.agents?.join(', ')}`,
      };
    }
    return { kind: 'ok', version: match };
  }

  if (semver.validRange(range) === null) {
    throw new AgentHubError('USAGE', `invalid version range "${range}"`);
  }

  const includePrerelease = channel === 'beta';
  const candidates = versions
    .filter((v) => semver.valid(v.version) !== null)
    .filter((v) => v.status === 'active')
    .filter((v) => includePrerelease || !isBeta(v))
    .filter((v) => semver.satisfies(v.version, range, { includePrerelease }))
    .filter((v) => supportsAgents(v, opts.agents))
    .sort((a, b) => semver.rcompare(a.version, b.version));

  const best = candidates[0];
  if (best) return { kind: 'ok', version: best };

  const matching = versions.filter(
    (v) =>
      semver.valid(v.version) !== null &&
      semver.satisfies(v.version, range, { includePrerelease: true }),
  );
  const unavailable = matching.filter((v) => v.status !== 'active');
  let reason = `no ${includePrerelease ? '' : 'stable '}version matches "${range}"`;
  if (unavailable.length > 0) {
    reason += ` (${unavailable.map((v) => `${v.version} ${v.status}`).join(', ')})`;
  } else if (!includePrerelease && matching.some(isBeta)) {
    reason += ' (only beta versions match; use the beta channel)';
  } else if (opts.agents && matching.some((v) => !supportsAgents(v, opts.agents))) {
    reason += ` for ${opts.agents.join(', ')}`;
  }
  return { kind: 'none', reason };
}

/** Highest active version regardless of agents (for `update --check`). */
export function latestVersion(
  versions: RegistryVersion[],
  channel: 'stable' | 'beta' = 'stable',
): string | null {
  const outcome = resolveVersion(versions, { range: '*', channel });
  return outcome.kind === 'ok' ? outcome.version.version : null;
}
