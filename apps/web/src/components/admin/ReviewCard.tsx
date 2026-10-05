import Link from 'next/link';
import type { ReactNode } from 'react';
import type { QueueItem } from '../../lib/registry';
import {
  Badge,
  ChevronRightIcon,
  type FindingLike,
  FindingList,
  formatDate,
  OutcomeBadge,
  ReceiptRow,
  StatusBadge,
  TrustReceipt,
  VerifiedMark,
} from '../ui';

const SEVERITY = { BLOCK: 0, WARN: 1, INFO: 2 } as const;

/** Findings shown before the rest is folded away. */
const VISIBLE_FINDINGS = 4;

/** INFO / WARN / BLOCK totals for a list of findings. */
export function countFindings(findings: readonly { decision: 'INFO' | 'WARN' | 'BLOCK' }[]): {
  INFO: number;
  WARN: number;
  BLOCK: number;
} {
  const counts = { INFO: 0, WARN: 0, BLOCK: 0 };
  for (const finding of findings) counts[finding.decision] += 1;
  return counts;
}

/** A DOM-safe id fragment for one version. */
export function versionDomId(item: { slug: string; version: string }): string {
  return `${item.slug}-${item.version}`.replace(/[^a-z0-9-]/gi, '-');
}

export interface PublisherLineProps {
  publisher: QueueItem['publisher'];
}

/** Publisher name with the verified seal, or a plain "unverified" chip. */
export function PublisherLine({ publisher }: PublisherLineProps) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-medium text-text [overflow-wrap:anywhere]">{publisher.name}</span>
      {publisher.verified ? <VerifiedMark showLabel /> : <Badge>Unverified publisher</Badge>}
    </span>
  );
}

export interface ReviewCardProps {
  item: QueueItem;
  /** The decision controls (approve, rescan, revoke) for this version. */
  actions: ReactNode;
}

/**
 * One quarantined version as a sheet of the ledger: who published what and when, the trust
 * receipt, the scanner's findings (most severe first) and the decision controls.
 * Everything that comes from the package is untrusted and rendered as text.
 */
export function ReviewCard({ item, actions }: ReviewCardProps) {
  const id = versionDomId(item);
  const titleId = `review-${id}-title`;
  const findingsId = `review-${id}-findings`;
  const findings: FindingLike[] = [...(item.scan?.findings ?? [])].sort(
    (a, b) => SEVERITY[a.decision] - SEVERITY[b.decision],
  );
  const counts = countFindings(findings);
  const head = findings.slice(0, VISIBLE_FINDINGS);
  const rest = findings.slice(VISIBLE_FINDINGS);

  return (
    <article
      aria-labelledby={titleId}
      className="rounded-card border border-border bg-surface-1 shadow-panel"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-4 py-4 sm:px-6 sm:py-5">
        <div className="min-w-0">
          <h3 id={titleId} className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <Link
              href={`/skills/${item.slug}`}
              className="text-h3 text-text decoration-transparent [overflow-wrap:anywhere] hover:decoration-current"
            >
              {item.name}
            </Link>
            <span className="break-all font-mono font-normal text-mono text-muted">
              {item.slug}@{item.version}
            </span>
          </h3>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted text-small">
            <span>Published by</span>
            <PublisherLine publisher={item.publisher} />
            <span aria-hidden="true" className="text-subtle">
              ·
            </span>
            <span>
              Uploaded <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={item.status} />
          <OutcomeBadge outcome={item.scan?.outcome} />
        </div>
      </header>

      {item.statusReason ? (
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-border border-t px-4 py-3 text-small sm:px-6">
          <span className="eyebrow">Reason on file</span>
          <span className="min-w-0 text-text [overflow-wrap:anywhere]">{item.statusReason}</span>
        </p>
      ) : null}

      <div className="grid gap-x-8 gap-y-6 border-border border-t bg-bg px-4 py-5 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby={findingsId} className="min-w-0">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h4 id={findingsId} className="eyebrow">
              Scanner findings
            </h4>
            {item.scan ? (
              <p className="font-mono text-mono text-subtle">
                {findings.length} {findings.length === 1 ? 'finding' : 'findings'}
              </p>
            ) : null}
          </div>
          {item.scan ? (
            <>
              <FindingList
                findings={head}
                emptyText="The scanner reported no findings for this version."
              />
              {rest.length > 0 ? (
                <details className="group mt-2">
                  <summary className="tap-target inline-flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-control px-2.5 font-medium text-muted text-small transition-colors duration-150 hover:bg-surface-2 hover:text-text [&::-webkit-details-marker]:hidden">
                    <ChevronRightIcon
                      size={15}
                      className="transition-transform duration-150 group-open:rotate-90"
                    />
                    <span className="group-open:hidden">
                      Show {rest.length} more {rest.length === 1 ? 'finding' : 'findings'}
                    </span>
                    <span className="hidden group-open:inline">
                      Hide {rest.length} {rest.length === 1 ? 'finding' : 'findings'}
                    </span>
                  </summary>
                  <FindingList findings={rest} className="mt-2" />
                </details>
              ) : null}
            </>
          ) : (
            <p className="text-muted text-small">
              This version has no scan on record. Run a rescan before you decide.
            </p>
          )}
        </section>

        <TrustReceipt
          id={`review-${id}-receipt`}
          headingLevel={3}
          subject={`${item.slug}@${item.version}`}
          digest={item.digest}
          scannerVersion={item.scan?.scannerVersion}
          scannedAt={item.scan?.scannedAt}
          outcome={item.scan?.outcome}
          status={item.status}
          counts={item.scan ? counts : undefined}
          className="self-start"
        >
          <ReceiptRow label="Uploaded">{formatDate(item.createdAt)}</ReceiptRow>
        </TrustReceipt>
      </div>

      <footer className="border-border border-t px-4 py-3.5 sm:px-6">{actions}</footer>
    </article>
  );
}
