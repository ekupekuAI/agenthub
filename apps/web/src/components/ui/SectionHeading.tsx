import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Eyebrow } from './Eyebrow';

export interface SectionHeadingProps {
  eyebrow?: ReactNode;
  /** Heading content. Wrap the one emphasized word in <em> to set it in serif italic. */
  title: ReactNode;
  /** Supporting sentence under the heading. */
  lede?: ReactNode;
  /** Heading element. Default `h2`. */
  as?: 'h1' | 'h2' | 'h3';
  /** Type size: `display-1` for the home hero, `display-2` for sections and page titles. */
  size?: 'display-1' | 'display-2';
  align?: 'left' | 'center';
  /** Id for the heading, to reference from `aria-labelledby`. */
  id?: string;
  /** Buttons or links shown beside (desktop) or under (mobile) the text. */
  actions?: ReactNode;
  className?: string;
}

/** Eyebrow, serif heading and lede with consistent spacing. */
export function SectionHeading({
  eyebrow,
  title,
  lede,
  as: Tag = 'h2',
  size = 'display-2',
  align = 'left',
  id,
  actions,
  className,
}: SectionHeadingProps) {
  const centered = align === 'center';
  return (
    <div
      className={cn(
        'flex flex-col gap-6',
        centered ? 'items-center text-center' : 'sm:flex-row sm:items-end sm:justify-between',
        className,
      )}
    >
      <div className={cn('min-w-0', centered ? 'max-w-3xl' : 'max-w-2xl')}>
        {eyebrow ? <Eyebrow className="mb-3">{eyebrow}</Eyebrow> : null}
        <Tag id={id} className={cn(size, 'text-text')}>
          {title}
        </Tag>
        {lede ? (
          <p
            className={cn(
              'mt-4 text-muted',
              size === 'display-1' ? 'text-[1.125rem] leading-7' : 'text-body',
            )}
          >
            {lede}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div> : null}
    </div>
  );
}
