import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface KbdProps {
  children: ReactNode;
  className?: string;
}

/** A key cap, e.g. <Kbd>Ctrl</Kbd> <Kbd>K</Kbd>. */
export function Kbd({ children, className }: KbdProps) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border-strong bg-surface-2 px-1 font-medium font-mono text-[0.6875rem] text-muted leading-none',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
