import type { ReactNode } from 'react';
import { Eyebrow } from '../ui';

export interface LedgerSectionProps {
  /** Id of the section (anchor target); the heading gets `${id}-heading`. */
  id: string;
  eyebrow: ReactNode;
  /** Heading text; also the accessible name of the region. */
  title: string;
  lede?: ReactNode;
  /** Extra content under the lede in the label column: counts, scanner version. */
  aside?: ReactNode;
  children: ReactNode;
}

/**
 * One entry of the page ledger: a hairline, the label column on the left (it stays in view
 * while a long entry scrolls) and the content on the right. Stacks under 1024px.
 */
export function LedgerSection({ id, eyebrow, title, lede, aside, children }: LedgerSectionProps) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="grid grid-cols-1 gap-x-12 gap-y-6 border-border border-t py-10 lg:grid-cols-[16rem_minmax(0,1fr)] lg:py-14"
    >
      <div className="min-w-0 lg:sticky lg:top-[calc(var(--header-h)+1.5rem)] lg:self-start">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 id={headingId} className="mt-2 font-display text-[1.75rem] text-text leading-[1.15]">
          {title}
        </h2>
        {lede ? <p className="mt-2 max-w-md text-muted text-small">{lede}</p> : null}
        {aside ? <div className="mt-4">{aside}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
