import { startGitHubSignIn } from '../../../../../src/lib/signin-routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/auth/github/start: begin GitHub sign-in (state + PKCE in a signed cookie). */
export const GET = startGitHubSignIn;
