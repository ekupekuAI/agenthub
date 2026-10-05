import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { BanIcon, LockIcon } from '../ui';

export interface StatusBannerProps {
  status: 'quarantined' | 'revoked';
  version: string;
  /** Moderator or scanner reason; untrusted text, rendered as text. */
  reason?: string | null;
  className?: string;
}

const TONES: Record<
  StatusBannerProps['status'],
  { word: string; frame: string; ink: string; icon: ReactNode; body: ReactNode }
> = {
  revoked: {
    word: 'Revoked',
    frame: 'border-block-line bg-block-tint',
    ink: 'text-block',
    icon: <BanIcon size={20} />,
    body: (
      <>
        Revoked versions are never resolved for new installs, and{' '}
        <code>agenthub update --check</code> flags existing installs that use them. Revocation is
        final.
      </>
    ),
  },
  quarantined: {
    word: 'Quarantined',
    frame: 'border-warn-line bg-warn-tint',
    ink: 'text-warn',
    icon: <LockIcon size={20} />,
    body: 'It is stored but cannot be downloaded or installed until a moderator has reviewed it.',
  },
};

/**
 * The banner shown when the version on the page is not installable. The state is carried by
 * the word, the icon and the sentence, not only by the tint.
 */
export function StatusBanner({ status, version, reason, className }: StatusBannerProps) {
  const { word, frame, ink, icon, body } = TONES[status];
  return (
    <div
      role="alert"
      className={cn('flex gap-3.5 rounded-card border p-4 sm:gap-4 sm:p-5', frame, className)}
    >
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex size-10 shrink-0 items-center justify-center rounded-control border border-current',
          ink,
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p className={cn('font-medium font-mono text-eyebrow uppercase', ink)}>{word}</p>
        <p className="mt-1 font-semibold text-text">
          Version {version}{' '}
          {status === 'revoked'
            ? 'has been revoked and must not be installed.'
            : 'is quarantined and cannot be installed.'}
        </p>
        {reason ? (
          <p className="mt-1 text-small text-text">
            <span className="font-semibold">Reason:</span> {reason}
          </p>
        ) : null}
        <p className="mt-2 text-muted text-small">
          {body}{' '}
          <Link href="/guidelines#publishing-rules" className="text-text">
            Publishing rules
          </Link>
        </p>
      </div>
    </div>
  );
}
