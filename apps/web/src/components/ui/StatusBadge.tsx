import { Badge } from './Badge';
import { BanIcon, CircleCheckIcon, LockIcon } from './icons';

export type VersionStatusValue = 'active' | 'quarantined' | 'revoked';

export interface StatusBadgeProps {
  status: VersionStatusValue;
  className?: string;
}

/** Lifecycle status of a published version: icon, word and tint. */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  if (status === 'active') {
    return (
      <Badge tone="signal" icon={<CircleCheckIcon size={13} />} className={className}>
        Active
      </Badge>
    );
  }
  if (status === 'quarantined') {
    return (
      <Badge tone="warn" icon={<LockIcon size={13} />} className={className}>
        Quarantined
      </Badge>
    );
  }
  return (
    <Badge tone="block" icon={<BanIcon size={13} />} className={className}>
      Revoked
    </Badge>
  );
}
