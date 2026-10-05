import { cn } from '../../lib/cn';

export interface SkeletonProps {
  /** Size and shape, e.g. `h-4 w-40` or `h-24 w-full rounded-card`. */
  className?: string;
}

/** Placeholder block shown while content loads. Decorative: pair it with an aria-busy region. */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cn('block animate-skeleton rounded-chip bg-surface-3', className)}
    />
  );
}
