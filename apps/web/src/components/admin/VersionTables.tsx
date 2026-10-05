import Link from 'next/link';
import type { ReactNode } from 'react';
import type { QueueItem } from '../../lib/registry';
import { formatDate, OutcomeBadge, Table, TBody, TD, TH, THead, TR, VerifiedMark } from '../ui';

function versionKey(item: QueueItem): string {
  return `${item.slug}@${item.version}`;
}

/** Publisher name with the seal when verified. Compact: the seal's label is its tooltip. */
function Publisher({ publisher }: { publisher: QueueItem['publisher'] }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-text">
      <span className="[overflow-wrap:anywhere]">{publisher.name}</span>
      {publisher.verified ? <VerifiedMark /> : <span className="sr-only">(unverified)</span>}
    </span>
  );
}

/** Skill name linked to its page, with `slug@version` in mono underneath. */
function VersionName({ item, children }: { item: QueueItem; children?: ReactNode }) {
  return (
    <div className="min-w-0">
      <Link
        href={`/skills/${item.slug}`}
        className="font-medium text-text decoration-transparent [overflow-wrap:anywhere] hover:decoration-current"
      >
        {item.name}
      </Link>
      <p className="break-all font-mono font-normal text-[0.8125rem] text-muted leading-5">
        {versionKey(item)}
      </p>
      {children}
    </div>
  );
}

export interface ActiveVersionsTableProps {
  items: readonly QueueItem[];
  /** The decision controls for one row. */
  actionsFor: (item: QueueItem) => ReactNode;
}

/** The newest active versions, each with quarantine, rescan and revoke. */
export function ActiveVersionsTable({ items, actionsFor }: ActiveVersionsTableProps) {
  return (
    <Table caption="Active versions, newest first">
      <THead>
        <TR>
          <TH>Version</TH>
          <TH className="sm:max-lg:hidden">Publisher</TH>
          <TH>Uploaded</TH>
          <TH>Scan</TH>
          <TH align="right">Actions</TH>
        </TR>
      </THead>
      <TBody>
        {items.map((item) => (
          <TR key={versionKey(item)}>
            <TH scope="row" label="Version">
              <VersionName item={item}>
                {/* Between 640px and 1024px the publisher column folds into this cell. */}
                <p className="mt-1 hidden font-normal text-[0.8125rem] text-muted leading-5 sm:max-lg:block">
                  by <Publisher publisher={item.publisher} />
                </p>
                {item.statusReason ? (
                  <p className="mt-1 font-normal text-[0.8125rem] text-muted leading-5 [overflow-wrap:anywhere]">
                    Reason on file: {item.statusReason}
                  </p>
                ) : null}
              </VersionName>
            </TH>
            <TD label="Publisher" className="sm:max-lg:hidden">
              <Publisher publisher={item.publisher} />
            </TD>
            <TD label="Uploaded" mono className="whitespace-nowrap">
              <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
            </TD>
            <TD label="Scan">
              <OutcomeBadge outcome={item.scan?.outcome} />
            </TD>
            <TD>{actionsFor(item)}</TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

export interface RevokedVersionsTableProps {
  items: readonly QueueItem[];
}

/** Revoked versions with the reason on file. Revocation is final, so there are no actions. */
export function RevokedVersionsTable({ items }: RevokedVersionsTableProps) {
  return (
    <Table caption="Revoked versions, newest first">
      <THead>
        <TR>
          <TH>Version</TH>
          <TH>Publisher</TH>
          <TH>Uploaded</TH>
          <TH>Reason on file</TH>
        </TR>
      </THead>
      <TBody>
        {items.map((item) => (
          <TR key={versionKey(item)}>
            <TH scope="row" label="Version">
              <VersionName item={item} />
            </TH>
            <TD label="Publisher">
              <Publisher publisher={item.publisher} />
            </TD>
            <TD label="Uploaded" mono className="whitespace-nowrap">
              <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
            </TD>
            <TD label="Reason" className="text-text [overflow-wrap:anywhere]">
              {item.statusReason ?? <span className="text-subtle">No reason on file</span>}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
