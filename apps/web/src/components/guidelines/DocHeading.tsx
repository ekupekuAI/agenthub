import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { CopyLinkButton } from './CopyButtons';
import { headingLabel, type SectionId, type SubsectionId, sectionNumber } from './toc';

/*
 * Headings sit under the sticky site header, and under 1024px also under the sticky
 * "On this page" bar, so an in-page link must stop a little lower there. The html element
 * already reserves the header's height (scroll-padding-top); this adds the bar.
 */
const SCROLL_MARGIN = 'scroll-mt-14 lg:scroll-mt-0';

export interface SectionHeadingProps {
  id: SectionId;
}

/** A numbered section heading ("5. Security model") with a copy-link button. */
export function DocSectionHeading({ id }: SectionHeadingProps) {
  const label = headingLabel(id);
  return (
    <div className="group mb-5 flex items-start gap-2">
      <h2
        id={id}
        className={cn(
          'min-w-0 flex-1 font-display text-[clamp(1.9rem,3.4vw,2.6rem)] text-text leading-[1.1] tracking-[-0.015em] [text-wrap:balance]',
          SCROLL_MARGIN,
        )}
      >
        <span className="font-mono text-[0.5em] text-subtle tracking-normal [vertical-align:0.4em]">
          {sectionNumber(id)}.
        </span>{' '}
        {label}
      </h2>
      <CopyLinkButton id={id} label={label} className="mt-1.5 sm:mt-2.5" />
    </div>
  );
}

export interface DocSubheadingProps {
  id: SubsectionId;
  /** Extra words after the label, e.g. a badge. */
  aside?: ReactNode;
}

/** A subsection heading with a copy-link button. Its text comes from the outline. */
export function DocSubheading({ id, aside }: DocSubheadingProps) {
  const label = headingLabel(id);
  return (
    <div className="group mt-12 mb-3 flex items-start gap-2">
      <h3 id={id} className={cn('min-w-0 flex-1 text-h3 text-text', SCROLL_MARGIN)}>
        {label}
        {aside}
      </h3>
      <CopyLinkButton id={id} label={label} className="-mt-0.5" />
    </div>
  );
}
