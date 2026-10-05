import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ActionNotice } from '../../src/components/admin/ActionNotice';
import { AdminTabs } from '../../src/components/admin/AdminTabs';
import { GateCard, GateFact } from '../../src/components/admin/GateCard';
import { countLabel, PanelHeading } from '../../src/components/admin/PanelHeading';
import { countFindings, ReviewCard } from '../../src/components/admin/ReviewCard';
import {
  ActiveVersionsTable,
  RevokedVersionsTable,
} from '../../src/components/admin/VersionTables';
import {
  BanIcon,
  CircleCheckIcon,
  ClockIcon,
  Container,
  CopyCommand,
  EmptyState,
  Eyebrow,
  KeyIcon,
  LockIcon,
  ShieldCheckIcon,
} from '../../src/components/ui';
import { hasAdminSession } from '../../src/lib/action-guard';
import { adminEnabled, SESSION_TTL_MS } from '../../src/lib/auth';
import { getRegistry, type QueueItem } from '../../src/lib/registry';
import { CreatePublisherForm, LoginForm, SignOutForm } from './AdminForms';
import { ModerationActions, type ModerationTarget } from './ModerationActions';

export const metadata: Metadata = {
  title: 'Registry admin',
  description: 'Moderate quarantined versions, revoke releases and manage publishers.',
  robots: { index: false, follow: false },
};

type Params = Record<string, string | string[] | undefined>;

const QUEUE_LIMIT = 50;
const ACTIVE_LIMIT = 20;
const REVOKED_LIMIT = 20;

const SESSION_HOURS = Math.round(SESSION_TTL_MS / 3_600_000);

type Op = 'approve' | 'quarantine' | 'revoke' | 'rescan';

/** What each completed action did, in the words of the result notice. */
const DONE: Record<Op, { past: string; verb: string; effect: string }> = {
  approve: {
    past: 'Approved',
    verb: 'approve',
    effect: 'The version left quarantine and can be installed again.',
  },
  quarantine: {
    past: 'Quarantined',
    verb: 'quarantine',
    effect: 'Installs and downloads are refused until a moderator approves it again.',
  },
  revoke: {
    past: 'Revoked',
    verb: 'revoke',
    effect: 'Installs and downloads of this version are refused from now on.',
  },
  rescan: {
    past: 'Rescanned',
    verb: 'rescan',
    effect: 'The findings shown now come from the current scanner.',
  },
};

const ERRORS: Record<string, string> = {
  unauthorized: 'Your session expired or the request was not allowed. Sign in again.',
  invalid: 'That skill or version is not valid.',
  reason: 'A reason of at least 3 characters is required.',
};

function isOp(value: unknown): value is Op {
  return typeof value === 'string' && Object.hasOwn(DONE, value);
}

/** The facts the decision controls need, taken from a queue item. */
function targetOf(item: QueueItem): ModerationTarget {
  return {
    slug: item.slug,
    version: item.version,
    publisher: item.publisher.name,
    outcome: item.scan?.outcome ?? null,
    blockCount: item.scan ? countFindings(item.scan.findings).BLOCK : 0,
  };
}

/** The result of the last action, read from the redirect's query string. */
function noticeFor(params: Params): ReactNode {
  const error =
    typeof params.error === 'string' && Object.hasOwn(ERRORS, params.error)
      ? ERRORS[params.error]
      : undefined;
  if (error) return <ActionNotice tone="danger" title={error} dismissHref="/admin" />;
  if (!isOp(params.done)) return null;

  const done = DONE[params.done];
  const target = typeof params.target === 'string' ? params.target.slice(0, 120) : '';
  const subject = <span className="font-mono">{target}</span>;
  const result = typeof params.result === 'string' ? params.result : 'ok';

  if (result === 'ok') {
    return (
      <ActionNotice
        tone="success"
        dismissHref="/admin"
        title={
          <>
            {done.past} {subject}
          </>
        }
      >
        {done.effect}
      </ActionNotice>
    );
  }
  if (result === 'conflict') {
    return (
      <ActionNotice tone="danger" dismissHref="/admin" title={<>{subject} is revoked</>}>
        Revocation is final, so this version can no longer change status.
      </ActionNotice>
    );
  }
  return (
    <ActionNotice
      tone="danger"
      dismissHref="/admin"
      title={
        <>
          Could not {done.verb} {subject}
        </>
      }
    >
      The registry reported an error. Reload to see the current state before you try again.
    </ActionNotice>
  );
}

/** One figure in the console header: a mono number under a small label. */
function Stat({ label, value, attention }: { label: string; value: string; attention?: boolean }) {
  return (
    <div className="min-w-0 border-border border-l pl-4 first:border-l-0 first:pl-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="m-0 mt-1.5 flex items-center gap-2 font-mono text-[1.375rem] text-text leading-7 tabular-nums">
        {value}
        {attention ? (
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warn" />
        ) : null}
      </dd>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-chip border border-border-strong bg-surface-2 font-mono text-[0.75rem] text-muted"
    >
      {n}
    </span>
  );
}

function DisabledState() {
  return (
    <GateCard
      tone="warn"
      icon={<BanIcon size={20} />}
      eyebrow="Registry admin"
      title="Admin is turned off"
      lede="This registry was started without an admin token, so moderation and publisher management are unavailable. Browsing, installing and publishing with an existing token still work."
    >
      <div role="status" aria-label="How to turn on admin">
        <ol className="m-0 grid list-none gap-5 p-0 text-small">
          <li className="flex gap-3.5">
            <StepNumber n={1} />
            <div className="min-w-0 flex-1">
              <p className="text-text">
                Set <code className="font-mono text-mono">AGENTHUB_ADMIN_TOKEN</code> to a random
                value of at least 32 characters.
              </p>
              <p className="mt-1 text-muted">Shorter values are ignored. One way to make one:</p>
              <CopyCommand
                className="mt-3"
                label="Command that prints a random token"
                command={`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`}
              />
            </div>
          </li>
          <li className="flex gap-3.5">
            <StepNumber n={2} />
            <p className="min-w-0 flex-1 text-text">Restart the registry server.</p>
          </li>
          <li className="flex gap-3.5">
            <StepNumber n={3} />
            <p className="min-w-0 flex-1 text-text">
              Come back to this page and sign in with that value.
            </p>
          </li>
        </ol>
      </div>
    </GateCard>
  );
}

function SignInState() {
  return (
    <GateCard
      icon={<KeyIcon size={20} />}
      eyebrow="Moderation"
      title={
        <>
          Registry <em>admin</em>
        </>
      }
      lede="Sign in with the admin token to review quarantined versions and manage publishers."
      footer={
        <>
          <GateFact icon={<ClockIcon size={14} />}>Sessions last {SESSION_HOURS} hours</GateFact>
          <GateFact icon={<LockIcon size={14} />}>Signed, HTTP-only cookie</GateFact>
        </>
      }
    >
      <LoginForm />
    </GateCard>
  );
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!adminEnabled()) return <DisabledState />;
  if (!(await hasAdminSession())) return <SignInState />;

  const params = await searchParams;
  const registry = await getRegistry();
  const [quarantined, active, revoked] = await Promise.all([
    registry.listByStatus('quarantined', QUEUE_LIMIT),
    registry.listByStatus('active', ACTIVE_LIMIT),
    registry.listByStatus('revoked', REVOKED_LIMIT),
  ]);

  const queueCount = countLabel(quarantined.length, QUEUE_LIMIT);
  const activeCount = countLabel(active.length, ACTIVE_LIMIT);
  const revokedCount = countLabel(revoked.length, REVOKED_LIMIT);
  const notice = noticeFor(params);

  const queue = (
    <section aria-labelledby="queue-heading">
      <PanelHeading id="queue-heading" title="Quarantine queue" count={queueCount}>
        Versions the scanner blocked, or that a moderator quarantined. Nobody can download them
        until you decide. Approving makes a version installable again; revoking is permanent.
      </PanelHeading>
      {quarantined.length === 0 ? (
        <EmptyState
          icon={<CircleCheckIcon size={22} />}
          title="Nothing waiting for review"
          description="Uploads with a BLOCK finding land here, together with versions a moderator quarantined."
        />
      ) : (
        <ul className="m-0 grid list-none gap-6 p-0">
          {quarantined.map((item) => (
            <li key={`${item.slug}@${item.version}`}>
              <ReviewCard
                item={item}
                actions={<ModerationActions target={targetOf(item)} mode="quarantined" />}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );

  const versions = (
    <div className="grid gap-14">
      <section aria-labelledby="active-heading">
        <PanelHeading id="active-heading" title="Recently published" count={activeCount}>
          The newest installable versions. Quarantine one to stop installs while you look into it;
          rescan to run the current scanner over the stored package.
        </PanelHeading>
        {active.length === 0 ? (
          <EmptyState
            icon={<CircleCheckIcon size={22} />}
            title="No active versions"
            description="Versions appear here once they are published and pass the scanner."
          />
        ) : (
          <ActiveVersionsTable
            items={active}
            actionsFor={(item) => (
              <ModerationActions target={targetOf(item)} mode="active" layout="row" />
            )}
          />
        )}
      </section>
      <section aria-labelledby="revoked-heading">
        <PanelHeading id="revoked-heading" title="Revoked" count={revokedCount}>
          Revocation is final. These versions return HTTP 410, and{' '}
          <code className="font-mono text-mono text-text">agenthub update --check</code> flags
          installs that still use them.
        </PanelHeading>
        {revoked.length === 0 ? (
          <p className="rounded-card border border-border-strong border-dashed px-5 py-4 text-muted text-small">
            No revoked versions.
          </p>
        ) : (
          <RevokedVersionsTable items={revoked} />
        )}
      </section>
    </div>
  );

  const publishers = (
    <section aria-labelledby="publisher-heading">
      <PanelHeading id="publisher-heading" title="Create a publisher">
        Publishing needs an identity. Each publisher gets one token, which authorizes their uploads.
      </PanelHeading>
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-12">
        <div className="rounded-card border border-border bg-surface-1 p-5 shadow-panel sm:p-6">
          <CreatePublisherForm />
        </div>
        <aside aria-label="About publisher tokens" className="grid gap-5 text-small">
          <div className="flex gap-3">
            <KeyIcon size={16} className="mt-[3px] shrink-0 text-subtle" />
            <p className="text-muted">
              <span className="font-medium text-text">Shown once.</span> The registry keeps only a
              hash of the token, so it cannot be displayed again. Hand it to the publisher over a
              private channel.
            </p>
          </div>
          <div className="flex gap-3">
            <ShieldCheckIcon size={16} className="mt-[3px] shrink-0 text-subtle" />
            <p className="text-muted">
              <span className="font-medium text-text">Verified means identity.</span> The seal says
              you confirmed who the publisher is. It says nothing about the safety of any particular
              version.
            </p>
          </div>
          <p className="border-border border-t pt-4 text-muted">
            Publishers agree to the{' '}
            <Link href="/guidelines#publishing-rules">publishing rules</Link>.
          </p>
        </aside>
      </div>
    </section>
  );

  return (
    <>
      <header className="dot-grid border-border border-b">
        <Container className="pt-10 pb-8 sm:pt-12 sm:pb-10">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <Eyebrow className="mb-3">Moderation console</Eyebrow>
              <h1 className="display-2 text-text">
                Registry <em>admin</em>
              </h1>
              <p className="mt-3 max-w-xl text-body text-muted">
                Review quarantined versions, revoke releases and issue publisher tokens.
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
              <SignOutForm />
              <p className="inline-flex items-center gap-1.5 font-mono text-[0.75rem] text-subtle">
                <ClockIcon size={13} />
                Sessions last {SESSION_HOURS} hours
              </p>
            </div>
          </div>
          <dl className="m-0 mt-8 grid max-w-md grid-cols-3 gap-4">
            <Stat label="In review" value={queueCount} attention={quarantined.length > 0} />
            <Stat label="Active" value={activeCount} />
            <Stat label="Revoked" value={revokedCount} />
          </dl>
        </Container>
      </header>

      <Container className="pt-6 pb-16 sm:pt-8 sm:pb-24">
        {notice ? <div className="mb-6">{notice}</div> : null}
        <AdminTabs
          label="Admin sections"
          tabs={[
            {
              id: 'queue',
              label: 'Review queue',
              count: queueCount,
              countLabel: 'waiting for review',
              attention: quarantined.length > 0,
              content: queue,
            },
            { id: 'versions', label: 'Versions', content: versions },
            { id: 'publishers', label: 'Publishers', content: publishers },
          ]}
        />
      </Container>
    </>
  );
}
