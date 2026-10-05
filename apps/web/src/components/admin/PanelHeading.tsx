import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface PanelHeadingProps {
  /** Id of the <h2>, for `aria-labelledby` on the surrounding section. */
  id: string;
  title: string;
  /** Number of entries, shown in mono after the title, e.g. `3` or `50+`. */
  count?: string;
  /** One or two sentences that say what the list is and what the actions do. */
  children?: ReactNode;
  className?: string;
}

/** Heading of one console section: serif title, mono count and a short explanation. */
export function PanelHeading({ id, title, count, children, className }: PanelHeadingProps) {
  return (
    <div className={cn('mb-5 max-w-2xl', className)}>
      <h2 id={id} className="font-display text-[1.75rem] text-text leading-[1.15]">
        {title}
        {count !== undefined ? (
          <span className="ml-2.5 align-[0.2em] font-mono text-mono text-subtle">({count})</span>
        ) : null}
      </h2>
      {children ? <p className="mt-2 text-muted text-small">{children}</p> : null}
    </div>
  );
}

/** `7`, or `20+` when the list was cut off at its limit. */
export function countLabel(length: number, limit: number): string {
  return length >= limit ? `${limit}+` : String(length);
}
