/**
 * Route handlers of publisher sign-in (app/api/auth/**). They work on plain Request/Response
 * objects so tests can call them directly.
 *
 * Redirect targets are fixed paths ('/', '/dashboard', '/publish', '/signin?error=<code>') or
 * GitHub's authorize URL; nothing from the request is ever used as a redirect target.
 */
import { githubOAuth, oauthBaseUrl } from '../config';
import { getAccounts } from './accounts';
import {
  buildAuthorizeUrl,
  completeGitHubSignIn,
  GitHubOAuthError,
  OAUTH_CODE_RE,
} from './github-oauth';
import { isSameOriginStrict } from './http';
import {
  clearCookie,
  createOAuthAttempt,
  createPublisherSession,
  oauthCookieName,
  parseSignInTarget,
  pkceChallenge,
  publisherSessionCookieName,
  readCookie,
  readOAuthAttempt,
  readPublisherSession,
  SIGN_IN_TARGETS,
  safeEqual,
  serializeCookie,
  signInCookieOptions,
} from './publisher-session';
import { checkClientLimit } from './rate-limit';

export const CALLBACK_PATH = '/api/auth/github/callback';
export const START_PATH = '/api/auth/github/start';

/** Error codes shown by /signin. Keep in sync with app/signin/page.tsx. */
export type SignInError =
  | 'denied'
  | 'state'
  | 'github'
  | 'suspended'
  | 'rate_limited'
  | 'unavailable';

const NO_STORE = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(`${text}\n`, {
    status,
    headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8', ...extra },
  });
}

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ ...NO_STORE, Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status, headers });
}

function failed(code: SignInError, cookies: string[] = []): Response {
  return redirect(`/signin?error=${code}`, cookies);
}

export const NOT_CONFIGURED = 'GitHub sign-in is not configured on this registry.';

/** GET /api/auth/github/start[?next=publish] */
export async function startGitHubSignIn(request: Request): Promise<Response> {
  const oauth = githubOAuth();
  const base = oauthBaseUrl(request);
  if (!oauth || !base) return plain(503, NOT_CONFIGURED);
  if (!checkClientLimit('signin', request.headers).ok) return failed('rate_limited');

  const requestUrl = new URL(request.url);
  const next = parseSignInTarget(requestUrl.searchParams.get('next'));
  // The state cookie must be set on the host GitHub sends the visitor back to.
  if (requestUrl.host !== base.host) {
    return redirect(new URL(`${START_PATH}?next=${next}`, base).toString());
  }
  const created = createOAuthAttempt(next);
  if (!created) return plain(503, NOT_CONFIGURED);
  const location = buildAuthorizeUrl({
    clientId: oauth.clientId,
    redirectUri: new URL(CALLBACK_PATH, base).toString(),
    state: created.attempt.state,
    codeChallenge: pkceChallenge(created.attempt.verifier),
  });
  return redirect(location, [
    serializeCookie(oauthCookieName(), created.value, signInCookieOptions(created.attempt.expires)),
  ]);
}

/** GET /api/auth/github/callback?code=…&state=… */
export async function finishGitHubSignIn(request: Request): Promise<Response> {
  const oauth = githubOAuth();
  const base = oauthBaseUrl(request);
  if (!oauth || !base) return plain(503, NOT_CONFIGURED);
  // The attempt cookie is single use: it is cleared on every outcome.
  const clear = clearCookie(oauthCookieName());
  if (!checkClientLimit('signin', request.headers).ok) return failed('rate_limited', [clear]);

  const params = new URL(request.url).searchParams;
  if (params.get('error')) return failed('denied', [clear]);
  const code = params.get('code') ?? '';
  const state = params.get('state') ?? '';
  const attempt = readOAuthAttempt(readCookie(request.headers.get('cookie'), oauthCookieName()));
  if (!attempt || !OAUTH_CODE_RE.test(code) || !safeEqual(state, attempt.state)) {
    return failed('state', [clear]);
  }

  try {
    const accounts = await getAccounts();
    if (!(await accounts.consumeOAuthState(attempt.state, attempt.expires))) {
      return failed('state', [clear]);
    }
    const user = await completeGitHubSignIn({
      clientId: oauth.clientId,
      clientSecret: oauth.clientSecret,
      code,
      redirectUri: new URL(CALLBACK_PATH, base).toString(),
      codeVerifier: attempt.verifier,
    });
    const { publisher } = await accounts.signInWithGitHub(user);
    if (publisher.disabledAt !== null) return failed('suspended', [clear]);
    const session = createPublisherSession(publisher.id);
    if (!session) return failed('unavailable', [clear]);
    return redirect(SIGN_IN_TARGETS[attempt.next], [
      clear,
      serializeCookie(
        publisherSessionCookieName(),
        session.value,
        signInCookieOptions(session.expires),
      ),
    ]);
  } catch (error) {
    // Only a fixed kind is logged: never codes, tokens or GitHub's response bodies.
    const kind = error instanceof GitHubOAuthError ? error.kind : 'internal';
    console.error(`[agenthub] GitHub sign-in failed: ${kind}`);
    return failed('github', [clear]);
  }
}

/** POST /api/auth/signout (same-origin form post). */
export async function signOut(request: Request): Promise<Response> {
  if (!isSameOriginStrict(request.headers)) {
    return plain(403, 'This form must be submitted from the agenthub site.');
  }
  const session = readPublisherSession(
    readCookie(request.headers.get('cookie'), publisherSessionCookieName()),
  );
  if (session) {
    try {
      await (await getAccounts()).revokeSession(session.nonce, session.expires);
    } catch {
      console.error('[agenthub] sign-out could not be recorded');
      return plain(500, 'Sign-out failed. Try again.');
    }
  }
  return redirect('/', [clearCookie(publisherSessionCookieName())], 303);
}
