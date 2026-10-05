import type { Metadata } from 'next';
import { GitHubSignInButton } from '../../src/components/auth/GitHubSignIn';
import { Container, PageHeader } from '../../src/components/ui';
import { githubOAuth } from '../../src/config';
import { getAccounts } from '../../src/lib/accounts';
import { currentPublisher } from '../../src/lib/action-guard';
import { getRegistry } from '../../src/lib/registry';
import { DashboardView, PublisherSkills } from './DashboardView';
import { TokensPanel } from './TokensPanel';

export const metadata: Metadata = {
  title: 'Publisher dashboard',
  description: 'See your published skills, their versions, statuses and scan outcomes.',
};

export default async function DashboardPage() {
  const me = await currentPublisher();

  if (me) {
    const [skills, tokens] = await Promise.all([
      (await getRegistry()).listPublisherSkills(me.publisher.id),
      (await getAccounts()).listTokens(me.publisher.id),
    ]);
    return (
      <>
        <PageHeader
          eyebrow="Dashboard"
          title={
            <>
              Everything you have <em>published</em>
            </>
          }
          lede="Your skills, every version you have published, what the scanner found, and the tokens your command line uses."
        />
        <Container className="flex flex-col gap-16 py-10 lg:py-16">
          <PublisherSkills
            eyebrow={`Signed in with GitHub as ${me.publisher.githubLogin ?? me.publisher.displayName}`}
            state={{
              publisher: {
                name: me.publisher.displayName,
                verified: me.publisher.verifiedAt !== null,
              },
              skills,
            }}
          />
          <TokensPanel initialTokens={tokens} />
        </Container>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title={
          <>
            Everything you have <em>published</em>
          </>
        }
        lede="Sign in with GitHub, or enter a publisher token to see your skills, every version you have published and what the scanner found. A token is checked on the server for this request only."
      />
      <Container className="flex flex-col gap-8 py-10 lg:py-16">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
          <GitHubSignInButton enabled={githubOAuth() !== null} />
          <p className="eyebrow text-center" aria-hidden="true">
            or use a publisher token
          </p>
        </div>
        <DashboardView />
      </Container>
    </>
  );
}
