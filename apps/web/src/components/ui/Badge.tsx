import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export type BadgeTone = 'neutral' | 'signal' | 'info' | 'warn' | 'block';

export interface BadgeProps {
  tone?: BadgeTone;
  /** Leading icon. Status is never carried by color alone: pair a tone with an icon or word. */
  icon?: ReactNode;
  /** Mono, uppercase, tracked: for machine vocabulary such as INFO or a release channel. */
  mono?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-border-strong bg-surface-2 text-muted',
  signal: 'border-signal-line bg-signal-tint text-signal-ink',
  info: 'border-info-line bg-info-tint text-info',
  warn: 'border-warn-line bg-warn-tint text-warn',
  block: 'border-block-line bg-block-tint text-block',
};

/** Generic chip: tinted background, 40% border, status-colored text. */
export function Badge({
  tone = 'neutral',
  icon,
  mono = false,
  title,
  className,
  children,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-chip border px-1.5 align-middle font-medium text-[0.75rem] leading-none',
        mono && 'font-mono uppercase tracking-[0.06em]',
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
