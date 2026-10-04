import type { Metadata } from 'next';
import Link from 'next/link';
import {
  DecisionBadge,
  OutcomeBadge,
  StatusBadge,
  VerifiedBadge,
} from '../../src/components/Badges';
import { hasAdminSession } from '../../src/lib/action-guard';
import { adminEnabled } from '../../src/lib/auth';
import { findingKey, keyed } from '../../src/lib/keys';
import { getRegistry, type QueueItem } from '../../src/lib/registry';
import { CreatePublisherForm, LoginForm } from './AdminForms';
import {
  approveAction,
  logoutAction,
  quarantineAction,
  rescanAction,
  revokeAction,
} from './actions';

export const metadata: Metadata = {
  title: 'Registry admin',
  description: 'Moderate quarantined versions, revoke releases and manage publishers.',
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const NOTICES: Record<string, string> = {
  approve: 'Approved',
  quarantine: 'Quarantined',
  revoke: 'Revoked',
  rescan: 'Rescanned',
};
const ERRORS: Record<string, string> = {
  unauthorized: 'Your session expired or the request was not allowed. Sign in again.',
  invalid: 'That skill or version is not valid.',
  reason: 'A reason of at least 3 characters is required.',
};

const input = 'w-full rounded-md border border-line bg-canvas px-3 py-1.5 text-sm text-ink';
const btn =
  'rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-60';

function Hidden({ item }: { item: QueueItem }) {
  return (
    <>
      <input type="hidden" name="slug" value={item.slug} />
      <input type="hidden" name="version" value={item.version} />
    </>
  );
}

function QueueCard({ item, mode }: { item: QueueItem; mode: 'quarantined' | 'active' }) {
  const id = `${item.slug}-${item.version}`.replace(/[^a-z0-9-]/gi, '-');
  return (
    <li className="rounded-xl border border-line bg-canvas p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/skills/${item.slug}`} className="font-semibold">
          {item.slug}@{item.version}
        </Link>
        <StatusBadge status={item.status} />
        <OutcomeBadge outcome={item.scan?.outcome} />
        <span className="text-sm text-muted">by {item.publisher.name}</span>
        <VerifiedBadge verified={item.publisher.verified} />
      </div>
      {item.statusReason ? <p className="mt-1 text-sm text-muted">{item.statusReason}</p> : null}
      {mode === 'quarantined' && item.scan?.findings.length ? (
        <ul className="mt-3 grid gap-2">
          {keyed(item.scan.findings, findingKey).map(({ item: f, key }) => (
            <li key={key} className="rounded-md border border-line p-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <DecisionBadge decision={f.decision} />
                <span className="font-mono text-xs">{f.ruleId}</span>
                <span className="font-mono text-xs text-muted">
                  {f.file}
                  {f.line > 0 ? `:${f.line}` : ''}
                </span>
                <span className="text-xs text-muted">{f.declared ? 'declared' : 'undeclared'}</span>
              </div>
              <code className="mt-1 block break-all text-xs">{f.evidence}</code>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end">
        <form className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-end">
          <Hidden item={item} />
          <div className="flex flex-1 flex-col gap-1">
            <label htmlFor={`reason-${id}`} className="text-xs font-semibold text-muted">
              Reason (required)
            </label>
            <input
              id={`reason-${id}`}
              name="reason"
              required
              minLength={3}
              maxLength={500}
              className={input}
            />
          </div>
          <div className="flex gap-2">
            {mode === 'quarantined' ? (
              <button
                type="submit"
                formAction={approveAction}
                className={`${btn} border-ok-line bg-ok-bg text-ok-fg hover:opacity-90`}
              >
                Approve
              </button>
            ) : (
              <button
                type="submit"
                formAction={quarantineAction}
                className={`${btn} border-warn-line bg-warn-bg text-warn-fg hover:opacity-90`}
              >
                Quarantine
              </button>
            )}
            <button
              type="submit"
              formAction={revokeAction}
              className={`${btn} border-bad-line bg-bad-bg text-bad-fg hover:opacity-90`}
            >
              Revoke
            </button>
          </div>
        </form>
        <form action={rescanAction}>
          <Hidden item={item} />
          <button
            type="submit"
            className={`${btn} border-line bg-surface text-ink hover:bg-raised`}
          >
            Rescan
          </button>
        </form>
      </div>
    </li>
  );
}

export default async function AdminPage({ searchParams }: { searchParams: SearchParams }) {
  if (!adminEnabled()) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">Registry admin</h1>
        <p role="status" className="mt-4 rounded-lg border border-line bg-surface p-4 text-muted">
          Admin is disabled on this registry. Set <code>AGENTHUB_ADMIN_TOKEN</code> (at least 32
          characters) and restart the server to enable it.
        </p>
      </div>
    );
  }

  if (!(await hasAdminSession())) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight">Registry admin</h1>
        <p className="mt-3 text-muted">Sign in with the admin token to moderate the registry.</p>
        <div className="mt-6">
          <LoginForm />
        </div>
      </div>
    );
  }

  const params = await searchParams;
  const done = typeof params.done === 'string' ? NOTICES[params.done] : undefined;
  const target = typeof params.target === 'string' ? params.target.slice(0, 120) : '';
  const result = typeof params.result === 'string' ? params.result : 'ok';
  const error = typeof params.error === 'string' ? ERRORS[params.error] : undefined;

  const registry = await getRegistry();
  const [quarantined, active, revoked] = await Promise.all([
    registry.listByStatus('quarantined', 50),
    registry.listByStatus('active', 20),
    registry.listByStatus('revoked', 20),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Registry admin</h1>
        <form action={logoutAction}>
          <button
            type="submit"
            className={`${btn} border-line bg-surface text-ink hover:bg-raised`}
          >
            Sign out
          </button>
        </form>
      </div>

      {done ? (
        <p
          role="status"
          className={`mt-4 rounded-lg border p-3 text-sm ${
            result === 'ok'
              ? 'border-ok-line bg-ok-bg text-ok-fg'
              : 'border-bad-line bg-bad-bg text-bad-fg'
          }`}
        >
          {result === 'ok'
            ? `${done}: ${target}`
            : result === 'conflict'
              ? `${target} is revoked; revocation is final.`
              : `Could not complete "${done.toLowerCase()}" for ${target}.`}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-bad-line bg-bad-bg p-3 text-sm text-bad-fg"
        >
          {error}
        </p>
      ) : null}

      <section aria-labelledby="queue-heading" className="mt-8">
        <h2 id="queue-heading" className="text-xl font-semibold">
          Quarantine queue{' '}
          <span className="text-base font-normal text-muted">({quarantined.length})</span>
        </h2>
        <p className="mt-1 text-sm text-muted">
          Versions the scanner blocked, or that a moderator quarantined. Approving makes a version
          installable; revoking is permanent.
        </p>
        {quarantined.length === 0 ? (
          <p className="mt-4 rounded-lg border border-dashed border-line p-5 text-muted">
            Nothing is waiting for review.
          </p>
        ) : (
          <ul className="mt-4 grid gap-4">
            {quarantined.map((item) => (
              <QueueCard key={`${item.slug}@${item.version}`} item={item} mode="quarantined" />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="active-heading" className="mt-12">
        <h2 id="active-heading" className="text-xl font-semibold">
          Recently published
        </h2>
        <ul className="mt-4 grid gap-4">
          {active.map((item) => (
            <QueueCard key={`${item.slug}@${item.version}`} item={item} mode="active" />
          ))}
        </ul>
      </section>

      <section aria-labelledby="revoked-heading" className="mt-12">
        <h2 id="revoked-heading" className="text-xl font-semibold">
          Revoked
        </h2>
        {revoked.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No revoked versions.</p>
        ) : (
          <ul className="mt-3 grid gap-2 text-sm">
            {revoked.map((item) => (
              <li key={`${item.slug}@${item.version}`} className="flex flex-wrap gap-2">
                <span className="font-mono">
                  {item.slug}@{item.version}
                </span>
                <span className="text-muted">{item.statusReason}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="publisher-heading"
        className="mt-12 rounded-xl border border-line bg-canvas p-5"
      >
        <h2 id="publisher-heading" className="text-xl font-semibold">
          Create a publisher
        </h2>
        <p className="mt-1 mb-4 text-sm text-muted">
          Publishing requires an identity. Mark a publisher verified only after you have confirmed
          who they are.
        </p>
        <CreatePublisherForm />
      </section>
    </div>
  );
}
