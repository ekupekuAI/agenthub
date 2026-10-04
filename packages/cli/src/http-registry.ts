/**
 * Client for a hosted agenthub registry (`/api/v1`, MVP §12).
 *
 * Security: https only (plain http is accepted for loopback hosts), no redirects, a request
 * timeout, a response size cap enforced while streaming, and every download is re-hashed and
 * compared with both the `X-Archive-Digest` header and the digest advertised in the version
 * list before the bytes are handed to the install engine.
 */
import type {
  AgentId,
  RegistrySource,
  RegistryVersion,
  SearchResult,
  SkillInfo,
} from '@agenthub/core';
import { AgentHubError, archiveDigest } from '@agenthub/core';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface HttpRegistryOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Validates a registry base URL and returns it without a trailing slash. */
export function normalizeRegistryUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AgentHubError('USAGE', `invalid registry URL: ${input}`);
  }
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      throw new AgentHubError(
        'USAGE',
        `registry URL must use https: (plain http is only allowed for localhost): ${input}`,
      );
    }
  } else if (url.protocol !== 'https:') {
    throw new AgentHubError('USAGE', `registry URL must use https: ${input}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new AgentHubError('USAGE', 'registry URL must not contain credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new AgentHubError('USAGE', `registry URL must not contain a query or fragment: ${input}`);
  }
  return url.toString().replace(/\/+$/, '');
}

export function assertSlug(name: string): void {
  if (!SLUG.test(name) || name.length > 64) {
    throw new AgentHubError('USAGE', `invalid skill name "${name}"`);
  }
}

export function assertVersion(version: string): void {
  if (!SEMVER.test(version) || version.length > 256) {
    throw new AgentHubError('USAGE', `invalid version "${version}"`);
  }
}

interface ApiResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export class HttpRegistry implements RegistrySource {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly versionCache = new Map<string, RegistryVersion[]>();

  constructor(baseUrl: string, opts: HttpRegistryOptions = {}) {
    this.id = normalizeRegistryUrl(baseUrl);
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  }

  async listVersions(name: string): Promise<RegistryVersion[]> {
    assertSlug(name);
    const data = await this.getJson(`/api/v1/skills/${encodeURIComponent(name)}/versions`, {
      skill: name,
    });
    const raw = (data as { versions?: unknown } | null)?.versions;
    if (!Array.isArray(raw)) throw this.malformed('version list');
    const versions = raw.map((entry) => this.parseVersion(entry));
    this.versionCache.set(name, versions);
    return versions;
  }

  async download(
    name: string,
    version: string,
  ): Promise<{ bytes: Uint8Array; archiveDigest: string; digest?: string }> {
    assertSlug(name);
    assertVersion(version);
    const versions = this.versionCache.get(name) ?? (await this.listVersions(name));
    const advertised = versions.find((entry) => entry.version === version);
    if (advertised === undefined) {
      throw new AgentHubError('NOT_FOUND', `${name}@${version} is not published in ${this.id}`);
    }
    if (advertised.status === 'revoked') {
      throw new AgentHubError('CONFLICT', `version revoked: ${name}@${version}`, {
        reason: advertised.revokedReason,
      });
    }
    if (advertised.status === 'quarantined') {
      throw new AgentHubError('POLICY_BLOCKED', `version quarantined: ${name}@${version}`);
    }
    if (advertised.archiveDigest === undefined) {
      throw new AgentHubError(
        'INTEGRITY',
        `the registry did not advertise an archive digest for ${name}@${version}`,
      );
    }

    const path = `/api/v1/skills/${encodeURIComponent(name)}/download/${encodeURIComponent(version)}`;
    const response = await this.request(path, 'application/octet-stream');
    if (response.status < 200 || response.status >= 300) {
      throw this.errorFor(response, { skill: name, version });
    }
    const header = response.headers.get('x-archive-digest')?.trim().toLowerCase();
    if (header === undefined || header === '') {
      throw new AgentHubError(
        'INTEGRITY',
        `download of ${name}@${version} has no X-Archive-Digest header`,
      );
    }
    const actual = archiveDigest(response.body);
    if (actual !== header || actual !== advertised.archiveDigest) {
      throw new AgentHubError('INTEGRITY', `archive digest mismatch for ${name}@${version}`, {
        expected: advertised.archiveDigest,
        header,
        actual,
      });
    }
    const result: { bytes: Uint8Array; archiveDigest: string; digest?: string } = {
      bytes: response.body,
      archiveDigest: actual,
    };
    if (advertised.digest !== '') result.digest = advertised.digest;
    return result;
  }

  async search(
    query: string,
    opts: { agent?: AgentId; category?: string } = {},
  ): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query });
    if (opts.agent !== undefined) params.set('agent', opts.agent);
    if (opts.category !== undefined) params.set('category', opts.category);
    const data = await this.getJson(`/api/v1/skills?${params.toString()}`, {});
    const results = (data as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) throw this.malformed('search results');
    return results.filter(isRecord).map((entry) => {
      if (typeof entry.slug !== 'string' || typeof entry.name !== 'string') {
        throw this.malformed('search result');
      }
      return {
        ...entry,
        agents: Array.isArray(entry.agents) ? entry.agents : [],
        summary: typeof entry.summary === 'string' ? entry.summary : '',
        latestVersion: typeof entry.latestVersion === 'string' ? entry.latestVersion : null,
      } as SearchResult;
    });
  }

  async info(name: string): Promise<SkillInfo> {
    assertSlug(name);
    const data = await this.getJson(`/api/v1/skills/${encodeURIComponent(name)}`, { skill: name });
    if (!isRecord(data) || typeof data.slug !== 'string' || typeof data.name !== 'string') {
      throw this.malformed('skill detail');
    }
    const versions = Array.isArray(data.versions) ? data.versions : [];
    return { ...data, versions, latest: data.latest ?? null } as unknown as SkillInfo;
  }

  // -------------------------------------------------------------------------

  private parseVersion(entry: unknown): RegistryVersion {
    if (!isRecord(entry)) throw this.malformed('version entry');
    const { version, digest, status, archiveDigest: archive } = entry;
    if (typeof version !== 'string' || !SEMVER.test(version)) throw this.malformed('version');
    if (typeof digest !== 'string' || !DIGEST.test(digest)) throw this.malformed('digest');
    if (status !== 'active' && status !== 'quarantined' && status !== 'revoked') {
      throw this.malformed('version status');
    }
    if (archive !== undefined && (typeof archive !== 'string' || !DIGEST.test(archive))) {
      throw this.malformed('archive digest');
    }
    return entry as unknown as RegistryVersion;
  }

  private async getJson(path: string, context: { skill?: string }): Promise<unknown> {
    const response = await this.request(path, 'application/json');
    if (response.status < 200 || response.status >= 300) {
      throw this.errorFor(response, context);
    }
    const body = parseBody(response.body);
    if (!isRecord(body) || body.ok !== true) throw this.malformed('response');
    return body.data;
  }

  private async request(path: string, accept: string): Promise<ApiResponse> {
    const url = `${this.id}${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { accept },
      });
    } catch (error) {
      throw this.networkError(error);
    }
    const length = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(length) && length > this.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw this.tooLarge();
    }
    let body: Uint8Array;
    try {
      body = await readCapped(response, this.maxBytes);
    } catch (error) {
      if (error instanceof AgentHubError) throw error;
      throw this.networkError(error);
    }
    return { status: response.status, headers: response.headers, body };
  }

  private errorFor(
    response: ApiResponse,
    context: { skill?: string; version?: string },
  ): AgentHubError {
    const parsed = parseBody(response.body);
    const remote =
      isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === 'string'
        ? parsed.error.message.slice(0, 300)
        : undefined;
    const subject =
      context.skill === undefined
        ? 'resource'
        : context.version === undefined
          ? `skill "${context.skill}"`
          : `${context.skill}@${context.version}`;
    const details = { status: response.status, registry: this.id, remote };
    switch (response.status) {
      case 404:
        return new AgentHubError('NOT_FOUND', `${subject} not found in ${this.id}`, details);
      case 410:
        return new AgentHubError(
          'CONFLICT',
          `version revoked: ${subject}${remote ? ` (${remote})` : ''}`,
          details,
        );
      case 403:
        return new AgentHubError('POLICY_BLOCKED', `version quarantined: ${subject}`, details);
      default:
        return new AgentHubError(
          'REGISTRY',
          `registry error (HTTP ${response.status})${remote ? `: ${remote}` : ''}`,
          details,
        );
    }
  }

  private networkError(error: unknown): AgentHubError {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return new AgentHubError(
        'REGISTRY',
        `registry request timed out after ${Math.round(this.timeoutMs / 1000)} s (${this.id})`,
      );
    }
    const cause = (error as { cause?: { message?: string } } | null)?.cause?.message;
    const message = error instanceof Error ? error.message : String(error);
    return new AgentHubError('REGISTRY', `cannot reach registry ${this.id}: ${cause ?? message}`);
  }

  private tooLarge(): AgentHubError {
    return new AgentHubError(
      'REGISTRY',
      `registry response exceeds ${this.maxBytes} bytes (${this.id})`,
    );
  }

  private malformed(what: string): AgentHubError {
    return new AgentHubError('REGISTRY', `malformed ${what} from registry ${this.id}`);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AgentHubError('REGISTRY', `registry response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function parseBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
