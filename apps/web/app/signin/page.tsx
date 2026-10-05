import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { GitHubSignInButton } from '../../src/components/auth/GitHubSignIn';
import { Callout, Container, LockIcon, PageHeader, ShieldCheckIcon } from '../../src/components/ui';
import { githubOAuth } from '../../src/config';
import { currentPublisher } from '../../src/lib/action-guard';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in with GitHub to publish skills and manage your CLI tokens.',
};

/** Messages for the fixed error codes the sign-in routes redirect with. */
const ERRORS: Record<string, string> = {
  denied: 'GitHub sign-in was cancelled. Nothing was changed.',
  state: 'That sign-in link expired or was already used. Start again.',
  github: 'GitHub did not complete the sign-in. Try again in a moment.',
  suspended: 'This publisher account is suspended. Contact the registry administrator.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
  unavailable: 'GitHub sign-in is not available right now.',
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  if (await currentPublisher()) redirect('/dashboard');
  const { error } = await searchParams;
  const message = typeof error === 'string' ? ERRORS[error] : undefined;
  const enabled = githubOAuth() !== null;

  return (
    <>
      <PageHeader
        eyebrow="Publishers"
        title={
          <>
            Sign in to <em>publish</em>
          </>
        }
        lede="Use your GitHub account. Your first sign-in creates a publisher named after your GitHub login; an administrator can verify it later."
      />
      <Container className="py-10 lg:py-16">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
          {message ? (
            <Callout tone="danger" role="alert" title="You are not signed in">
              {message}
            </Callout>
          ) : null}
          <section
            aria-labelledby="signin-title"
            className="flex flex-col gap-5 rounded-panel border border-border bg-surface-1 p-5 shadow-panel sm:p-7"
          >
            <h2 id="signin-title" className="font-display text-[1.6rem] text-text leading-[1.15]">
              Continue with GitHub
            </h2>
            <GitHubSignInButton enabled={enabled} />
            <ul className="m-0 grid list-none gap-2.5 p-0 text-muted text-small">
              <li className="flex items-start gap-2">
                <ShieldCheckIcon size={16} className="mt-0.5 text-signal-ink" />
                Only your public profile is requested (scope <code>read:user</code>).
              </li>
              <li className="flex items-start gap-2">
                <LockIcon size={16} className="mt-0.5 text-signal-ink" />
                The GitHub access token is used once to read your account id, then revoked. It is
                never stored.
              </li>
            </ul>
          </section>
          <p className="text-center text-muted text-small">
            Have a publisher token from an administrator?{' '}
            <Link href="/dashboard">Open the dashboard with it</Link>.
          </p>
        </div>
      </Container>
    </>
  );
}
