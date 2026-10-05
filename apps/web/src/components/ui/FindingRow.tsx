import { cn } from '../../lib/cn';
import { findingKey, keyed } from '../../lib/keys';
import { DecisionBadge } from './DecisionBadge';
import { CheckIcon, MinusIcon } from './icons';

/** The fields of a scanner finding that the UI shows (a subset of EvaluatedFinding). */
export interface FindingLike {
  decision: 'INFO' | 'WARN' | 'BLOCK';
  ruleId: string;
  file: string;
  /** 1-based; 0 when the finding concerns the whole file. */
  line: number;
  evidence: string;
  message?: string;
  declared: boolean;
}

export interface FindingRowProps {
  finding: FindingLike;
  /** Element to render. Use `div` outside a list. */
  as?: 'li' | 'div';
  className?: string;
}

/**
 * One finding: decision chip, rule id, `file:line`, the evidence in a code strip and whether
 * the behavior was declared. Evidence is untrusted text and is rendered as text only.
 */
export function FindingRow({ finding, as: Tag = 'li', className }: FindingRowProps) {
  const location = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  return (
    <Tag className={cn('rounded-card border border-border bg-surface-1 p-3.5', className)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <DecisionBadge decision={finding.decision} />
        <span className="font-mono text-mono text-text">{finding.ruleId}</span>
        <span className="min-w-0 break-all font-mono text-mono text-subtle">{location}</span>
        <span
          className={cn(
            'ml-auto inline-flex items-center gap-1 text-[0.8125rem] leading-5',
            finding.declared ? 'text-signal-ink' : 'text-muted',
          )}
        >
          {finding.declared ? <CheckIcon size={14} /> : <MinusIcon size={14} />}
          {finding.declared ? 'Declared' : 'Not declared'}
        </span>
      </div>
      {finding.message ? <p className="mt-2 text-muted text-small">{finding.message}</p> : null}
      <code className="mt-2 block whitespace-pre-wrap break-all rounded-chip border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[0.8125rem] text-text leading-5">
        {finding.evidence}
      </code>
    </Tag>
  );
}

const ORDER = ['BLOCK', 'WARN', 'INFO'] as const;

export interface FindingListProps {
  findings: readonly FindingLike[];
  /** Group under BLOCK / WARN / INFO sub-headings, most severe first. */
  grouped?: boolean;
  /** Shown when there are no findings. */
  emptyText?: string;
  className?: string;
}

/** A list of FindingRows with stable keys, optionally grouped by decision. */
export function FindingList({
  findings,
  grouped = false,
  emptyText = 'The scanner reported no findings.',
  className,
}: FindingListProps) {
  if (findings.length === 0) {
    return <p className={cn('text-muted text-small', className)}>{emptyText}</p>;
  }
  if (!grouped) {
    return (
      <ul className={cn('m-0 grid list-none gap-2 p-0', className)}>
        {keyed(findings, findingKey).map(({ item, key }) => (
          <FindingRow key={key} finding={item} />
        ))}
      </ul>
    );
  }
  return (
    <div className={cn('grid gap-5', className)}>
      {ORDER.map((decision) => {
        const group = findings.filter((f) => f.decision === decision);
        if (group.length === 0) return null;
        return (
          <div key={decision}>
            <p className="mb-2 flex items-center gap-2">
              <DecisionBadge decision={decision} count={group.length} />
            </p>
            <ul className="m-0 grid list-none gap-2 p-0">
              {keyed(group, findingKey).map(({ item, key }) => (
                <FindingRow key={key} finding={item} />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
