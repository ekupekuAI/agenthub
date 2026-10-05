import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { DecisionBadge } from './DecisionBadge';
import { DigestChip } from './DigestChip';
import { formatDate } from './format';
import {
  BanIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from './icons';
import type { ScanOutcomeValue } from './OutcomeBadge';
import { StatusBadge, type VersionStatusValue } from './StatusBadge';

export type Verdict = 'allowed' | 'confirm' | 'blocked' | 'revoked' | 'unscanned';

/** Revocation wins over the scan outcome; a missing scan is "unscanned". */
export function verdictOf(input: {
  outcome?: ScanOutcomeValue | null;
  status?: VersionStatusValue;
}): Verdict {
  if (input.status === 'revoked') return 'revoked';
  if (input.outcome === 'block') return 'blocked';
  if (input.outcome === 'confirm') return 'confirm';
  if (input.outcome === 'allow') return 'allowed';
  return 'unscanned';
}

const VERDICTS: Record<Verdict, { label: string; color: string; icon: ReactNode }> = {
  allowed: { label: 'Allowed', color: 'text-signal-ink', icon: <CircleCheckIcon size={14} /> },
  confirm: {
    label: 'Needs confirmation',
    color: 'text-warn',
    icon: <TriangleAlertIcon size={14} />,
  },
  blocked: { label: 'Blocked', color: 'text-block', icon: <OctagonXIcon size={14} /> },
  revoked: { label: 'Revoked', color: 'text-block', icon: <BanIcon size={14} /> },
  unscanned: { label: 'Not scanned', color: 'text-subtle', icon: <CircleDashedIcon size={14} /> },
};

export interface VerdictStampProps {
  verdict: Verdict;
  className?: string;
}

/** The rubber stamp on a receipt: icon and word, rotated −6°. */
export function VerdictStamp({ verdict, className }: VerdictStampProps) {
  const { label, color, icon } = VERDICTS[verdict];
  return (
    <span className={cn('stamp', color, className)}>
      {icon}
      <span>
        <span className="sr-only">Verdict: </span>
        {label}
      </span>
    </span>
  );
}

export interface ReceiptRowProps {
  label: string;
  children: ReactNode;
  className?: string;
}

/** One `label ……… value` line. Use inside TrustReceipt (as children) or any <dl>. */
export function ReceiptRow({ label, children, className }: ReceiptRowProps) {
  return (
    <div className={cn('flex min-h-8 flex-wrap items-baseline gap-x-2 gap-y-1 py-1', className)}>
      <dt className="flex min-w-[8.5rem] flex-1 items-baseline gap-2 font-mono text-mono text-subtle">
        <span className="shrink-0 lowercase">{label}</span>
        <span aria-hidden="true" className="leader" />
      </dt>
      <dd className="m-0 flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-right font-mono text-mono text-text">
        {children}
      </dd>
    </div>
  );
}

export interface TrustReceiptProps {
  /** Receipt title; also the accessible name of the region. */
  title?: string;
  /** What the receipt is for, e.g. `web-testing@1.0.0`. */
  subject?: string;
  /** Content digest (`sha256:…`). */
  digest: string;
  archiveDigest?: string | null;
  scannerVersion?: string | null;
  /** ISO time of the scan. */
  scannedAt?: string | null;
  outcome?: ScanOutcomeValue | null;
  status?: VersionStatusValue;
  /** Findings summary. */
  counts?: { INFO: number; WARN: number; BLOCK: number };
  /** Extra <ReceiptRow>s appended to the evidence list. */
  children?: ReactNode;
  /** Content under the rows, after a dashed rule: declared permissions, grouped findings. */
  footer?: ReactNode;
  headingLevel?: 2 | 3;
  id?: string;
  className?: string;
}

/**
 * The trust receipt: a paper-shaped panel with a perforated top edge, mono evidence rows with
 * dotted leaders, a verdict stamp, and digests that copy on click.
 */
export function TrustReceipt({
  title = 'Trust evidence',
  subject,
  digest,
  archiveDigest,
  scannerVersion,
  scannedAt,
  outcome,
  status,
  counts,
  children,
  footer,
  headingLevel = 2,
  id = 'trust-receipt',
  className,
}: TrustReceiptProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const headingId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn('receipt px-5 pt-8 pb-5 sm:px-6 sm:pb-6', className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-4">
        <div className="min-w-0">
          <p className="eyebrow">agenthub receipt</p>
          <Heading
            id={headingId}
            className="mt-1 font-display text-[1.7rem] text-text leading-[1.1]"
          >
            {title}
          </Heading>
          {subject ? (
            <p className="mt-1 break-all font-mono text-mono text-muted">{subject}</p>
          ) : null}
        </div>
        <VerdictStamp verdict={verdictOf({ outcome, status })} className="mt-1 mr-1" />
      </header>

      <hr className="receipt-rule my-4" />

      <dl className="m-0">
        <ReceiptRow label="Content digest">
          <DigestChip digest={digest} label="content digest" />
        </ReceiptRow>
        {archiveDigest ? (
          <ReceiptRow label="Archive digest">
            <DigestChip digest={archiveDigest} label="archive digest" />
          </ReceiptRow>
        ) : null}
        <ReceiptRow label="Scanner">
          {scannerVersion ? (
            <>
              <span>{scannerVersion}</span>
              {scannedAt ? <span className="text-subtle">· {formatDate(scannedAt)}</span> : null}
            </>
          ) : (
            <span className="text-subtle">not scanned</span>
          )}
        </ReceiptRow>
        {status ? (
          <ReceiptRow label="Status">
            <StatusBadge status={status} />
          </ReceiptRow>
        ) : null}
        {counts ? (
          <ReceiptRow label="Findings">
            <DecisionBadge decision="BLOCK" count={counts.BLOCK} />
            <DecisionBadge decision="WARN" count={counts.WARN} />
            <DecisionBadge decision="INFO" count={counts.INFO} />
          </ReceiptRow>
        ) : null}
        {children}
      </dl>

      {footer ? (
        <>
          <hr className="receipt-rule my-4" />
          {footer}
        </>
      ) : null}
    </section>
  );
}
