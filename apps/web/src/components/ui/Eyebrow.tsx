import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface EyebrowProps {
  children: ReactNode;
  as?: 'p' | 'span' | 'div';
  /** Leading signal dot: use only where the label means "verified / trusted". */
  dot?: boolean;
  className?: string;
}

/** Mono, 12px, uppercase, tracked label above a heading. */
export function Eyebrow({ children, as: Tag = 'p', dot = false, className }: EyebrowProps) {
  return (
    <Tag className={cn('eyebrow', dot && 'inline-flex items-center gap-2', className)}>
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-signal" /> : null}
      {children}
    </Tag>
  );
}
