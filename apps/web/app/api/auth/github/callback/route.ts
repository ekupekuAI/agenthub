import { finishGitHubSignIn } from '../../../../../src/lib/signin-routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/auth/github/callback: GitHub redirects here with ?code and ?state. */
export const GET = finishGitHubSignIn;
