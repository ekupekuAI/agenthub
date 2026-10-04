import type { ReactNode } from 'react';

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

const TONES: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok-fg border-ok-line',
  warn: 'bg-warn-bg text-warn-fg border-warn-line',
  bad: 'bg-bad-bg text-bad-fg border-bad-line',
  info: 'bg-info-bg text-info-fg border-info-line',
  neutral: 'bg-raised text-ink border-line',
};

export function Badge({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: 'active' | 'quarantined' | 'revoked' }) {
  if (status === 'active') return <Badge tone="ok">Active</Badge>;
  if (status === 'quarantined') return <Badge tone="warn">Quarantined</Badge>;
  return <Badge tone="bad">Revoked</Badge>;
}

export function DecisionBadge({ decision }: { decision: 'INFO' | 'WARN' | 'BLOCK' }) {
  const tone: Tone = decision === 'BLOCK' ? 'bad' : decision === 'WARN' ? 'warn' : 'info';
  return <Badge tone={tone}>{decision}</Badge>;
}

/** Trust badge for a scan outcome. It never claims a skill is safe. */
export function OutcomeBadge({ outcome }: { outcome?: 'allow' | 'confirm' | 'block' | null }) {
  if (!outcome) return <Badge tone="neutral">Not scanned</Badge>;
  if (outcome === 'allow') {
    return (
      <Badge tone="ok" title="The scanner found nothing above INFO">
        No warnings
      </Badge>
    );
  }
  if (outcome === 'confirm') {
    return (
      <Badge tone="warn" title="At least one finding needs your confirmation">
        Review warnings
      </Badge>
    );
  }
  return (
    <Badge tone="bad" title="At least one finding is blocked by policy">
      Blocked
    </Badge>
  );
}

export function VerifiedBadge({ verified }: { verified: boolean }) {
  if (!verified) return <Badge tone="neutral">Unverified publisher</Badge>;
  return (
    <Badge tone="info" title="The registry has verified this publisher's identity">
      <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
        <path d="M6.6 11.3 3.3 8l1.1-1.1 2.2 2.2 5-5L12.7 5.2z" />
      </svg>
      Verified publisher
    </Badge>
  );
}
