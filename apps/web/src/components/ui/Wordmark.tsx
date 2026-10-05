import Link from 'next/link';
import { cn } from '../../lib/cn';
import { Seal } from './Seal';

export interface WordmarkProps {
  /** Render as a link to the home page. Default true. */
  link?: boolean;
  className?: string;
}

/** The seal glyph and "agenthub" set in mono. */
export function Wordmark({ link = true, className }: WordmarkProps) {
  const classes = cn(
    'inline-flex shrink-0 items-center gap-2 font-medium font-mono text-[0.9375rem] text-text leading-none tracking-[-0.01em] no-underline',
    className,
  );
  const content = (
    <>
      <Seal size={20} />
      <span>agenthub</span>
    </>
  );
  if (!link) return <span className={classes}>{content}</span>;
  return (
    <Link href="/" aria-label="agenthub home" className={cn(classes, 'tap-target')}>
      {content}
    </Link>
  );
}
