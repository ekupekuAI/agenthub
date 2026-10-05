/**
 * GitHub OAuth web flow for a confidential client (server side only), with plain fetch.
 *
 * Only the `read:user` scope is requested. The access token is used for exactly one call
 * (GET /user), then revoked at GitHub (best effort) and dropped: it is never stored, logged or
 * sent to the browser. Every response is size-capped, time-limited and validated; redirects are
 * not followed. Failures raise GitHubOAuthError with a fixed `kind` that is safe to log.
 */

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_USER_URL = 'https://api.github.com/user';
export const GITHUB_SCOPE = 'read:user';

const TIMEOUT_MS = 10_000;
const REVOKE_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const USER_AGENT = 'agenthub-registry';

/** GitHub logins: 1-39 alphanumerics or single hyphens, not starting or ending with one. */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const ACCESS_TOKEN_RE = /^[A-Za-z0-9_.~-]{8,512}$/;
/** What GitHub sends back as `code`; anything else is refused before it reaches GitHub. */
export const OAUTH_CODE_RE = /^[A-Za-z0-9_-]{1,256}$/;

export type GitHubOAuthErrorKind = 'exchange' | 'user' | 'network' | 'denied';

export class GitHubOAuthError extends Error {
  constructor(readonly kind: GitHubOAuthErrorKind) {
    super(`GitHub sign-in failed (${kind})`);
    this.name = 'GitHubOAuthError';
  }
}

export interface GitHubUser {
  id: number;
  login: string;
}

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', GITHUB_SCOPE);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) throw new Error('response too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchJson(
  url: string,
  init: RequestInit,
  kind: GitHubOAuthErrorKind,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new GitHubOAuthError('network');
  }
  let body: unknown;
  try {
    const type = response.headers.get('content-type') ?? '';
    if (!/^application\/(vnd\.github(\.[a-z0-9-]+)?\+)?json\b/i.test(type)) throw new Error();
    body = JSON.parse(await readCapped(response));
  } catch {
    throw new GitHubOAuthError(kind);
  }
  if (!response.ok || typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new GitHubOAuthError(kind);
  }
  return body as Record<string, unknown>;
}

/** Exchange the authorization code (with the PKCE verifier) for an access token. */
export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<string> {
  if (!OAUTH_CODE_RE.test(opts.code)) throw new GitHubOAuthError('exchange');
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  });
  const json = await fetchJson(
    GITHUB_TOKEN_URL,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body,
    },
    'exchange',
  );
  // GitHub answers 200 with { error } for a bad code, verifier or redirect URI.
  if (json.error !== undefined) throw new GitHubOAuthError('exchange');
  const token = json.access_token;
  const type = json.token_type;
  if (typeof token !== 'string' || !ACCESS_TOKEN_RE.test(token)) {
    throw new GitHubOAuthError('exchange');
  }
  if (typeof type !== 'string' || type.toLowerCase() !== 'bearer') {
    throw new GitHubOAuthError('exchange');
  }
  return token;
}

/** The signed-in GitHub account: numeric id and current login, strictly validated. */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const json = await fetchJson(
    GITHUB_USER_URL,
    {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
    'user',
  );
  const { id, login, type } = json;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new GitHubOAuthError('user');
  }
  if (typeof login !== 'string' || !GITHUB_LOGIN_RE.test(login)) {
    throw new GitHubOAuthError('user');
  }
  if (type !== undefined && type !== 'User') throw new GitHubOAuthError('user');
  return { id, login };
}

/**
 * Revoke the access token at GitHub (DELETE /applications/{client_id}/token). Best effort:
 * the token was only ever held in memory, so a failure here is not a sign-in failure.
 */
export async function revokeAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  accessToken: string;
}): Promise<void> {
  try {
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`, 'utf8').toString('base64');
    const response = await fetch(
      `https://api.github.com/applications/${encodeURIComponent(opts.clientId)}/token`,
      {
        method: 'DELETE',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ access_token: opts.accessToken }),
      },
    );
    await response.body?.cancel().catch(() => {});
  } catch {
    // Ignored: see above.
  }
}

/**
 * The whole server-side exchange: code → token → user, then the token is revoked and
 * forgotten. Only the numeric id and the login leave this function.
 */
export async function completeGitHubSignIn(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<GitHubUser> {
  const accessToken = await exchangeCode(opts);
  try {
    return await fetchGitHubUser(accessToken);
  } finally {
    await revokeAccessToken({
      clientId: opts.clientId,
      clientSecret: opts.clientSecret,
      accessToken,
    });
  }
}
