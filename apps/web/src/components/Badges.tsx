import type { ReactNode } from 'react';
import { type BadgeTone, Badge as KitBadge } from './ui/Badge';
import { VerifiedMark } from './ui/VerifiedMark';

/*
 * Compatibility layer for pages written before the ledger kit. New code imports from
 * './ui' directly; this file only maps the old tone names onto the kit.
 */

export { DecisionBadge } from './ui/DecisionBadge';
export { OutcomeBadge } from './ui/OutcomeBadge';
export { StatusBadge } from './ui/StatusBadge';

type LegacyTone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

const TONE: Record<LegacyTone, BadgeTone> = {
  ok: 'signal',
  warn: 'warn',
  bad: 'block',
  info: 'info',
  neutral: 'neutral',
};

export function Badge({
  tone,
  children,
  title,
}: {
  tone: LegacyTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <KitBadge tone={TONE[tone]} title={title}>
      {children}
    </KitBadge>
  );
}

export function VerifiedBadge({ verified }: { verified: boolean }) {
  if (!verified) return <KitBadge tone="neutral">Unverified publisher</KitBadge>;
  return <VerifiedMark showLabel />;
}
