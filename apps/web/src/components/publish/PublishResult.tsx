import type { RefObject } from 'react';
import type { PublishSummary } from '../../lib/registry';
import {
  ArrowRightIcon,
  Button,
  Callout,
  CopyCommand,
  EmptyState,
  Eyebrow,
  FindingList,
  formatBytes,
  ReceiptRow,
  ScanIcon,
  Skeleton,
  TrustReceipt,
} from '../ui';

const SKELETON_ROWS = ['w-40', 'w-36', 'w-24', 'w-20', 'w-44'] as const;

/** What the result area shows before the first upload. */
export function PublishIdle() {
  return (
    <EmptyState
      icon={<ScanIcon size={22} />}
      title="No receipt yet"
      description="After you publish, the registry answers with a receipt: both digests, the scanner version, the verdict and every finding."
    />
  );
}

/** A blank receipt shown while the upload is hashed and scanned. */
export function PublishPending() {
  return (
    <div role="status" className="receipt px-5 pt-8 pb-5 sm:px-6 sm:pb-6">
      <p className="eyebrow">agenthub receipt</p>
      <p className="mt-1 font-display text-[1.7rem] text-text leading-[1.1]">
        Uploading and scanning…
      </p>
      <p className="mt-1 text-muted text-small">
        The registry recomputes both digests, then scans every file.
      </p>
      <hr className="receipt-rule my-4" />
      <div aria-hidden="true" className="grid gap-3.5 py-1">
        {SKELETON_ROWS.map((width, index) => (
          <div key={width} className="flex items-center gap-3">
            <Skeleton className={index % 2 === 0 ? 'h-3.5 w-28' : 'h-3.5 w-20'} />
            <span className="leader self-center [transform:none]" />
            <Skeleton className={`h-6 ${width}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function headline(summary: PublishSummary): string {
  const subject = `${summary.slug}@${summary.version}`;
  if (summary.status === 'active') return `${subject} is published`;
  if (summary.status === 'quarantined') return `${subject} is quarantined`;
  return `${subject} is revoked`;
}

export interface PublishReceiptProps {
  summary: PublishSummary;
  /** Receives focus when the result arrives, so keyboard and screen-reader users land on it. */
  headingRef?: RefObject<HTMLHeadingElement | null>;
}

/** The outcome of a publish: what happened, what to do next, and the evidence as a receipt. */
export function PublishReceipt({ summary, headingRef }: PublishReceiptProps) {
  const subject = `${summary.slug}@${summary.version}`;
  const counts = { INFO: 0, WARN: 0, BLOCK: 0 };
  for (const finding of summary.findings) counts[finding.decision] += 1;
  const active = summary.status === 'active';

  return (
    <section aria-labelledby="publish-result-title" className="flex min-w-0 flex-col gap-5">
      <div>
        <Eyebrow dot={active}>Result</Eyebrow>
        <h2
          id="publish-result-title"
          ref={headingRef}
          tabIndex={-1}
          className="mt-2 break-words rounded-chip font-mono text-[1.0625rem] text-text leading-7"
        >
          {headline(summary)}
        </h2>
      </div>

      {active ? (
        <>
          {summary.outcome === 'confirm' ? (
            <Callout tone="warning" title="Published with warnings">
              The version is installable. The CLI shows the WARN findings below and asks for
              confirmation before it installs.
            </Callout>
          ) : (
            <Callout tone="success" title="Published">
              The version is installable now. Its content can never change; fixes go out as a new
              version.
            </Callout>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <CopyCommand command={`agenthub install ${summary.slug}`} className="sm:flex-1" />
            <Button href={`/skills/${summary.slug}`} trailingIcon={<ArrowRightIcon />}>
              View the skill page
            </Button>
          </div>
        </>
      ) : summary.status === 'quarantined' ? (
        <Callout tone="warning" title="Quarantined">
          The scanner blocked this upload, so it is quarantined. Nobody can install it until a
          moderator reviews it. Fix the findings below and publish a new version.
        </Callout>
      ) : (
        <Callout tone="danger" title="Revoked">
          This version is revoked and cannot be installed.
        </Callout>
      )}

      <TrustReceipt
        id="publish-receipt"
        title="Publish receipt"
        headingLevel={3}
        subject={subject}
        digest={summary.digest}
        archiveDigest={summary.archiveDigest}
        scannerVersion={summary.scannerVersion}
        outcome={summary.outcome}
        status={summary.status}
        counts={counts}
        footer={
          <div>
            <h4 className="eyebrow mb-3">Findings</h4>
            <FindingList findings={summary.findings} grouped />
          </div>
        }
      >
        <ReceiptRow label="Size">{formatBytes(summary.sizeBytes)}</ReceiptRow>
      </TrustReceipt>

      {summary.warnings.length > 0 ? (
        <Callout tone="note" title="Validation warnings">
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {summary.warnings.map((warning) => (
              <li key={`${warning.code}-${warning.path ?? ''}`} className="break-words">
                {warning.message}
                {warning.path ? (
                  <>
                    {' '}
                    <code>{warning.path}</code>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </section>
  );
}
