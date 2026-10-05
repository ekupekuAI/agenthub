import type { SkillInfoVersion } from '../../lib/api-types';
import { cn } from '../../lib/cn';
import {
  Badge,
  DigestChip,
  formatDate,
  OutcomeBadge,
  StatusBadge,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../ui';

export interface VersionsTableProps {
  versions: readonly SkillInfoVersion[];
  /** The version the page shows; its row is highlighted. */
  current?: string;
}

/** Every published version, newest first, with the one on the page marked. */
export function VersionsTable({ versions, current }: VersionsTableProps) {
  if (versions.length === 0) {
    return <p className="text-muted text-small">No versions have been published yet.</p>;
  }
  return (
    <Table caption="All published versions, newest first">
      <THead>
        <TR>
          <TH>Version</TH>
          <TH>Status</TH>
          <TH>Scan</TH>
          <TH>Published</TH>
          <TH>Digest</TH>
        </TR>
      </THead>
      <TBody>
        {versions.map((v) => {
          const isCurrent = v.version === current;
          return (
            <TR key={v.version} className={cn(isCurrent && 'bg-signal-tint hover:bg-signal-tint')}>
              <TD
                label="Version"
                mono
                className={cn(isCurrent && 'shadow-[inset_3px_0_0_0_var(--signal-ink)]')}
              >
                <span className="inline-flex flex-wrap items-center gap-2">
                  {v.status === 'revoked' ? (
                    <s className="text-muted">{v.version}</s>
                  ) : (
                    <span>{v.version}</span>
                  )}
                  {v.channel === 'beta' ? <Badge mono>beta</Badge> : null}
                  {isCurrent ? (
                    <Badge tone="signal" title="The version this page describes">
                      Shown
                    </Badge>
                  ) : null}
                </span>
              </TD>
              <TD label="Status">
                <StatusBadge status={v.status} />
                {v.revokedReason ? (
                  <p className="mt-1.5 max-w-xs text-[0.8125rem] text-muted leading-5 [overflow-wrap:anywhere]">
                    Reason: {v.revokedReason}
                  </p>
                ) : null}
              </TD>
              <TD label="Scan">
                <OutcomeBadge outcome={v.scan?.outcome} />
              </TD>
              <TD label="Published" mono>
                {v.createdAt ? formatDate(v.createdAt) : <span className="text-subtle">—</span>}
              </TD>
              <TD label="Digest">
                <DigestChip digest={v.digest} label={`content digest of ${v.version}`} />
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
