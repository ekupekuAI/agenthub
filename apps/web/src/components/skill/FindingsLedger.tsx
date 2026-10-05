import type { ReactNode } from 'react';
import { findingKey, keyed } from '../../lib/keys';
import { CircleCheckIcon, DecisionBadge, type FindingLike, FindingRow } from '../ui';

const GROUPS: readonly { decision: FindingLike['decision']; title: string; meaning: string }[] = [
  {
    decision: 'BLOCK',
    title: 'Blocked',
    meaning: 'The CLI refuses to install while any of these is present.',
  },
  {
    decision: 'WARN',
    title: 'Warnings',
    meaning: 'The CLI lists these and asks for confirmation before it installs.',
  },
  {
    decision: 'INFO',
    title: 'Information',
    meaning: 'Shown for context. They do not stop or pause an install.',
  },
];

export interface FindingsLedgerProps {
  findings: readonly FindingLike[];
  /** False when the version has no scan at all, which reads differently from a clean scan. */
  scanned: boolean;
  /** Prefix for the group heading ids, so two ledgers can share a page. */
  idPrefix?: string;
  /** Heading level of each group. */
  groupHeading?: 'h3' | 'h4';
  /** Extra line in the empty state. */
  emptyNote?: ReactNode;
}

/**
 * Scanner findings grouped BLOCK, WARN, INFO, most severe first. Each group has a heading with
 * the decision chip, the count and what the decision does at install time. Evidence is
 * untrusted text; FindingRow renders it as text in a wrapping code strip.
 */
export function FindingsLedger({
  findings,
  scanned,
  idPrefix = 'findings',
  groupHeading: Heading = 'h3',
  emptyNote,
}: FindingsLedgerProps) {
  if (findings.length === 0) {
    return (
      <div className="flex gap-3.5 rounded-card border border-border border-dashed bg-surface-1 p-5">
        <span
          aria-hidden="true"
          className={
            scanned
              ? 'inline-flex size-9 shrink-0 items-center justify-center rounded-control border border-signal-line bg-signal-tint text-signal-ink'
              : 'inline-flex size-9 shrink-0 items-center justify-center rounded-control border border-border bg-surface-2 text-subtle'
          }
        >
          <CircleCheckIcon size={18} />
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-text">
            {scanned ? 'No findings' : 'This version has not been scanned'}
          </p>
          <p className="mt-1 max-w-xl text-muted text-small">
            {scanned
              ? 'The scanner checked every file and reported nothing. That is evidence, not a guarantee: read the files you install.'
              : 'There is no scan result to show. The CLI treats an unscanned version with caution.'}
          </p>
          {emptyNote ? <p className="mt-2 text-muted text-small">{emptyNote}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-8">
      {GROUPS.map(({ decision, title, meaning }) => {
        const group = findings.filter((finding) => finding.decision === decision);
        if (group.length === 0) return null;
        const headingId = `${idPrefix}-${decision.toLowerCase()}`;
        return (
          <section key={decision} aria-labelledby={headingId} className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-b pb-3">
              <DecisionBadge decision={decision} count={group.length} />
              <Heading id={headingId} className="font-semibold text-body text-text">
                {title}
              </Heading>
              <p className="basis-full text-muted text-small sm:basis-auto sm:before:mr-3 sm:before:text-subtle sm:before:content-['·']">
                {meaning}
              </p>
            </div>
            <ul className="m-0 mt-3 grid list-none gap-2.5 p-0">
              {keyed(group, findingKey).map(({ item, key }) => (
                <FindingRow key={key} finding={item} className="[overflow-wrap:anywhere]" />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
