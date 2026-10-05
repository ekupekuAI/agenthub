import { cn } from '../../lib/cn';
import { Seal } from './Seal';

export interface VerifiedMarkProps {
  /** Tooltip and accessible text. */
  label?: string;
  /** Show the label next to the seal instead of only as a tooltip. */
  showLabel?: boolean;
  /** Seal size in pixels. */
  size?: number;
  className?: string;
}

/** The signal check-seal shown next to verified publishers. */
export function VerifiedMark({
  label = 'Verified publisher',
  showLabel = false,
  size = 16,
  className,
}: VerifiedMarkProps) {
  return (
    <span
      title={showLabel ? "The registry has verified this publisher's identity" : label}
      className={cn('inline-flex items-center gap-1.5 align-middle', className)}
    >
      <Seal size={size} />
      {showLabel ? (
        <span className="font-medium text-[0.8125rem] text-signal-ink leading-none">{label}</span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </span>
  );
}
