import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps {
  /** A 20–24px icon from ./icons. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** A Button or link. */
  action?: ReactNode;
  className?: string;
}

/** Dashed panel for "nothing here yet" and "no results". */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-card border border-border-strong border-dashed px-6 py-10 text-center',
        className,
      )}
    >
      {icon ? (
        <span className="inline-flex size-11 items-center justify-center rounded-control border border-border bg-surface-2 text-muted">
          {icon}
        </span>
      ) : null}
      <p className="font-semibold text-text">{title}</p>
      {description ? <p className="max-w-md text-muted text-small">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
