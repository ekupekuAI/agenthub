import { Badge } from './Badge';
import { CircleDashedIcon, OctagonXIcon, ShieldCheckIcon, TriangleAlertIcon } from './icons';

export type ScanOutcomeValue = 'allow' | 'confirm' | 'block';

export interface OutcomeBadgeProps {
  outcome?: ScanOutcomeValue | null;
  className?: string;
}

/** Scan verdict for a version. It reports evidence and never claims a skill is safe. */
export function OutcomeBadge({ outcome, className }: OutcomeBadgeProps) {
  if (!outcome) {
    return (
      <Badge tone="neutral" icon={<CircleDashedIcon size={13} />} className={className}>
        Not scanned
      </Badge>
    );
  }
  if (outcome === 'allow') {
    return (
      <Badge
        tone="signal"
        icon={<ShieldCheckIcon size={13} />}
        title="The scanner found nothing above INFO"
        className={className}
      >
        No warnings
      </Badge>
    );
  }
  if (outcome === 'confirm') {
    return (
      <Badge
        tone="warn"
        icon={<TriangleAlertIcon size={13} />}
        title="At least one finding needs your confirmation"
        className={className}
      >
        Review warnings
      </Badge>
    );
  }
  return (
    <Badge
      tone="block"
      icon={<OctagonXIcon size={13} />}
      title="At least one finding is blocked by policy"
      className={className}
    >
      Blocked
    </Badge>
  );
}
