import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Eyebrow } from '../ui';

export interface GateCardProps {
  /** A 20px icon from the kit, shown in a tile above the title. */
  icon: ReactNode;
  eyebrow: string;
  /** The page <h1>. */
  title: ReactNode;
  lede: ReactNode;
  children: ReactNode;
  /** Quiet facts under the card body, e.g. how long a session lasts. */
  footer?: ReactNode;
  /** `warn` tints the icon tile, for the disabled state. */
  tone?: 'default' | 'warn';
}

/**
 * The single, focused card shown before the console opens: the sign-in form, or the notice
 * that admin is turned off. It sits on the dot grid like a page header, centered and narrow.
 */
export function GateCard({
  icon,
  eyebrow,
  title,
  lede,
  children,
  footer,
  tone = 'default',
}: GateCardProps) {
  return (
    <div className="dot-grid border-border border-b">
      <div className="mx-auto w-full max-w-[30rem] px-4 py-12 sm:px-6 sm:py-20">
        <div className="overflow-hidden rounded-panel border border-border bg-surface-1 shadow-panel">
          <div className="px-5 pt-7 pb-6 sm:px-8 sm:pt-9 sm:pb-8">
            <span
              className={cn(
                'mb-6 inline-flex size-11 items-center justify-center rounded-control border',
                tone === 'warn'
                  ? 'border-warn-line bg-warn-tint text-warn'
                  : 'border-border-strong bg-surface-2 text-text',
              )}
            >
              {icon}
            </span>
            <Eyebrow className="mb-2">{eyebrow}</Eyebrow>
            <h1 className="font-display text-[2.5rem] text-text leading-[1.05] tracking-[-0.02em] [text-wrap:balance]">
              {title}
            </h1>
            <p className="mt-3 text-muted text-small">{lede}</p>
            <div className="mt-7">{children}</div>
          </div>
          {footer ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-border border-t bg-surface-2 px-5 py-3.5 font-mono text-[0.75rem] text-muted leading-5 sm:px-8">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** One fact in the gate card footer: an icon and a few words. */
export function GateFact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-subtle">{icon}</span>
      {children}
    </span>
  );
}
