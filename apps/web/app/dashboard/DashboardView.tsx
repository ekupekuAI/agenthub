'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { PublisherSkillCard } from '../../src/components/dashboard/PublisherSkillCard';
import { TokenField } from '../../src/components/publish/TokenField';
import {
  ArrowRightIcon,
  Button,
  EmptyState,
  KeyIcon,
  LockIcon,
  PackageIcon,
  PlusIcon,
  Stagger,
  StaggerItem,
  VerifiedMark,
} from '../../src/components/ui';
import { type DashboardState, dashboardAction } from './actions';

type Ready = Extract<DashboardState, { status: 'ready' }>;

function TokenGate({
  action,
  pending,
  error,
  onCancel,
}: {
  action: (data: FormData) => void;
  pending: boolean;
  error?: string;
  /** Set while a publisher is already shown: the gate then offers to go back. */
  onCancel?: () => void;
}) {
  const compact = Boolean(onCancel);
  return (
    <form
      action={action}
      aria-labelledby="token-gate-title"
      className="relative mx-auto flex w-full max-w-xl flex-col gap-5 overflow-hidden rounded-panel border border-border bg-surface-1 p-5 shadow-panel sm:p-7"
    >
      <div className="flex items-start gap-4">
        <span
          aria-hidden="true"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-control border border-signal-line bg-signal-tint text-signal-ink"
        >
          <KeyIcon size={20} />
        </span>
        <div className="min-w-0">
          <h2 id="token-gate-title" className="font-display text-[1.6rem] text-text leading-[1.15]">
            {compact ? 'Use another token' : 'Open your dashboard'}
          </h2>
          <p className="mt-1 text-muted text-small">
            Paste the publisher token you received when your publisher account was created.
          </p>
        </div>
      </div>

      <TokenField
        id="token"
        name="token"
        label="Publisher token"
        required
        disabled={pending}
        placeholder="ahp_…"
        error={error}
      />

      <p className="flex items-start gap-2 rounded-control border border-border bg-surface-2 px-3 py-2.5 text-[0.8125rem] text-muted leading-5">
        <LockIcon size={15} className="mt-0.5 text-signal-ink" />
        <span>Your token is sent once to the server and never stored in this browser.</span>
      </p>

      <Button
        variant="primary"
        size="lg"
        type="submit"
        loading={pending}
        fullWidth
        trailingIcon={pending ? undefined : <ArrowRightIcon />}
      >
        {pending ? 'Checking token…' : 'Show my skills'}
      </Button>
      {onCancel ? (
        <Button variant="ghost" onClick={onCancel} disabled={pending} fullWidth>
          Back to my skills
        </Button>
      ) : null}
    </form>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'block' }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-surface-1 px-4 py-3.5 sm:px-5">
      <dt className="eyebrow">{label}</dt>
      <dd
        className={
          tone === 'warn' && value > 0
            ? 'm-0 font-mono text-[1.6rem] text-warn leading-8'
            : tone === 'block' && value > 0
              ? 'm-0 font-mono text-[1.6rem] text-block leading-8'
              : 'm-0 font-mono text-[1.6rem] text-text leading-8'
        }
      >
        {value}
      </dd>
    </div>
  );
}

function PublisherSkills({ state, onChangeToken }: { state: Ready; onChangeToken: () => void }) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const versions = state.skills.flatMap((skill) => skill.versions);
  const quarantined = versions.filter((v) => v.status === 'quarantined').length;
  const revoked = versions.filter((v) => v.status === 'revoked').length;

  // Land keyboard and screen-reader users on the result.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section aria-labelledby="mine-heading" className="flex min-w-0 flex-col gap-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="eyebrow">Signed in for this page</p>
          <h2
            id="mine-heading"
            ref={headingRef}
            tabIndex={-1}
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-chip font-display text-[2rem] text-text leading-[1.1] [overflow-wrap:anywhere]"
          >
            {state.publisher.name}
            {state.publisher.verified ? <VerifiedMark showLabel size={18} /> : null}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={onChangeToken} leadingIcon={<KeyIcon />}>
            Use another token
          </Button>
          <Button href="/publish" size="sm" leadingIcon={<PlusIcon />}>
            Publish a version
          </Button>
        </div>
      </div>

      <dl className="m-0 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-4">
        <Stat label="Skills" value={state.skills.length} />
        <Stat label="Versions" value={versions.length} />
        <Stat label="Quarantined" value={quarantined} tone="warn" />
        <Stat label="Revoked" value={revoked} tone="block" />
      </dl>

      {state.skills.length === 0 ? (
        <EmptyState
          icon={<PackageIcon size={22} />}
          title="Nothing published yet"
          description="Pack a skill folder with agenthub pack, then upload it. Every version you publish shows up here with its scan verdict."
          action={
            <Button href="/publish" variant="primary" trailingIcon={<ArrowRightIcon />}>
              Publish your first skill
            </Button>
          }
        />
      ) : (
        <Stagger as="ul" className="m-0 grid list-none gap-5 p-0 xl:grid-cols-2">
          {state.skills.map((skill) => (
            <StaggerItem as="li" key={skill.slug} className="min-w-0">
              <PublisherSkillCard skill={skill} />
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </section>
  );
}

export function DashboardView() {
  const [state, action, pending] = useActionState<DashboardState, FormData>(dashboardAction, {
    status: 'idle',
  });
  const [changingToken, setChangingToken] = useState(false);

  // A new answer from the server replaces the "use another token" form.
  useEffect(() => {
    if (state.status === 'ready') setChangingToken(false);
  }, [state]);

  // Opening the gate again puts the cursor in the token field.
  useEffect(() => {
    if (changingToken) document.getElementById('token')?.focus();
  }, [changingToken]);

  const ready = state.status === 'ready' ? state : null;
  const showGate = !ready || changingToken;
  const error = state.status === 'error' && !pending ? state.message : undefined;

  return (
    <div className="flex flex-col gap-10">
      {showGate ? (
        <TokenGate
          action={action}
          pending={pending}
          error={error}
          onCancel={ready ? () => setChangingToken(false) : undefined}
        />
      ) : null}
      {ready && !changingToken ? (
        <PublisherSkills state={ready} onChangeToken={() => setChangingToken(true)} />
      ) : null}
    </div>
  );
}
