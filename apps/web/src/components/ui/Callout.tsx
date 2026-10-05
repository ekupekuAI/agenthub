import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { CircleCheckIcon, InfoIcon, OctagonXIcon, TriangleAlertIcon } from './icons';

export type CalloutTone = 'note' | 'warning' | 'danger' | 'success';

export interface CalloutProps {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Use `alert` when the callout reports the result of an action. Default `note`. */
  role?: 'note' | 'alert' | 'status';
  className?: string;
}

const TONES: Record<CalloutTone, { frame: string; accent: string; icon: ReactNode }> = {
  note: {
    frame: 'border-info-line bg-info-tint',
    accent: 'text-info',
    icon: <InfoIcon size={18} />,
  },
  warning: {
    frame: 'border-warn-line bg-warn-tint',
    accent: 'text-warn',
    icon: <TriangleAlertIcon size={18} />,
  },
  danger: {
    frame: 'border-block-line bg-block-tint',
    accent: 'text-block',
    icon: <OctagonXIcon size={18} />,
  },
  success: {
    frame: 'border-signal-line bg-signal-tint',
    accent: 'text-signal-ink',
    icon: <CircleCheckIcon size={18} />,
  },
};

/** Tinted aside with an icon and a title. The tone is carried by icon and words too. */
export function Callout({
  tone = 'note',
  title,
  children,
  role = 'note',
  className,
}: CalloutProps) {
  const { frame, accent, icon } = TONES[tone];
  return (
    <aside
      role={role}
      className={cn('flex gap-3 rounded-card border p-4 text-small text-text', frame, className)}
    >
      <span className={cn('mt-0.5 shrink-0', accent)}>{icon}</span>
      <div className="min-w-0 flex-1">
        {title ? <p className={cn('font-semibold', accent)}>{title}</p> : null}
        {children ? (
          <div className={cn('text-text [&_a]:text-inherit', title ? 'mt-1' : '')}>{children}</div>
        ) : null}
      </div>
    </aside>
  );
}
