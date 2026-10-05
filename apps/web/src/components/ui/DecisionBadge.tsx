import type { ReactNode } from 'react';
import { Badge, type BadgeTone } from './Badge';
import {
  CircleCheckIcon,
  CircleHelpIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from './icons';

export type Decision = 'INFO' | 'WARN' | 'BLOCK' | 'ALLOW' | 'CONFIRM';

const DECISIONS: Record<Decision, { tone: BadgeTone; icon: ReactNode }> = {
  INFO: { tone: 'info', icon: <InfoIcon size={13} /> },
  WARN: { tone: 'warn', icon: <TriangleAlertIcon size={13} /> },
  BLOCK: { tone: 'block', icon: <OctagonXIcon size={13} /> },
  ALLOW: { tone: 'signal', icon: <CircleCheckIcon size={13} /> },
  CONFIRM: { tone: 'warn', icon: <CircleHelpIcon size={13} /> },
};

export interface DecisionBadgeProps {
  decision: Decision;
  /** When set, renders "3 WARN" instead of "WARN". */
  count?: number;
  className?: string;
}

/** Finding decision (INFO / WARN / BLOCK) or install decision (ALLOW / CONFIRM). */
export function DecisionBadge({ decision, count, className }: DecisionBadgeProps) {
  const { tone, icon } = DECISIONS[decision];
  return (
    <Badge tone={tone} icon={icon} mono className={className}>
      {count === undefined ? decision : `${count} ${decision}`}
    </Badge>
  );
}
