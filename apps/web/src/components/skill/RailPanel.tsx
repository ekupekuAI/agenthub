import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface RailPanelProps {
  /** Id of the section; the heading gets `${id}-heading`. */
  id: string;
  /** Heading text; also the accessible name of the region. */
  title: string;
  /** Short mono note on the right of the heading, e.g. "3 of 4 agents". */
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** A quiet card for the side rail: serif heading, mono note, then the content. */
export function RailPanel({ id, title, meta, className, children }: RailPanelProps) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn('min-w-0 rounded-card border border-border bg-surface-1 p-5 sm:p-6', className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="font-display text-[1.375rem] text-text leading-[1.2]">
          {title}
        </h2>
        {meta ? <p className="font-mono text-[0.75rem] text-subtle leading-4">{meta}</p> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
