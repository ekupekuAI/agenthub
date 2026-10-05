import { signOut } from '../../../../src/lib/signin-routes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/auth/signout: end the publisher session (also on the server). */
export const POST = signOut;
