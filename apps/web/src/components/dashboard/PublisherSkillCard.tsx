import Link from 'next/link';
import type { PublisherSkillSummary } from '../../lib/registry';
import {
  ArrowUpRightIcon,
  DecisionBadge,
  DigestChip,
  formatDate,
  OutcomeBadge,
  StatusBadge,
} from '../ui';

type Version = PublisherSkillSummary['versions'][number];

export interface PublisherSkillCardProps {
  skill: PublisherSkillSummary;
}

function Counts({ counts }: { counts: Version['counts'] }) {
  const total = counts.BLOCK + counts.WARN + counts.INFO;
  if (total === 0) {
    return <span className="text-[0.8125rem] text-subtle leading-5">No findings</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {counts.BLOCK > 0 ? <DecisionBadge decision="BLOCK" count={counts.BLOCK} /> : null}
      {counts.WARN > 0 ? <DecisionBadge decision="WARN" count={counts.WARN} /> : null}
      {counts.INFO > 0 ? <DecisionBadge decision="INFO" count={counts.INFO} /> : null}
    </span>
  );
}

/**
 * One of the publisher's skills: name and link, the latest version, then every version as a
 * ledger line with its status, scan verdict, findings, date and content digest.
 */
export function PublisherSkillCard({ skill }: PublisherSkillCardProps) {
  const latest = skill.versions[0];
  const headingId = `skill-${skill.slug}`;
  const needsAttention = skill.versions.some((v) => v.status === 'quarantined');

  return (
    <article
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col rounded-card border border-border bg-surface-1 shadow-panel transition-colors duration-150 hover:border-border-strong"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-5 sm:p-6">
        <div className="min-w-0">
          <h3 id={headingId} className="font-medium font-mono text-[1.125rem] leading-7">
            <Link
              href={`/skills/${skill.slug}`}
              className="text-text no-underline decoration-signal-ink underline-offset-4 hover:underline [overflow-wrap:anywhere]"
            >
              {skill.name}
            </Link>
          </h3>
          <p className="mt-0.5 font-mono text-[0.8125rem] text-subtle leading-5 [overflow-wrap:anywhere]">
            {skill.slug}
            {latest ? ` · latest ${latest.version}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {latest ? <StatusBadge status={latest.status} /> : null}
          <Link
            href={`/skills/${skill.slug}`}
            className="hit-area inline-flex items-center gap-1 text-[0.8125rem] text-muted leading-5 no-underline transition-colors duration-150 hover:text-text"
          >
            Skill page
            <ArrowUpRightIcon size={14} />
            <span className="sr-only"> for {skill.name}</span>
          </Link>
        </div>
      </header>

      {needsAttention ? (
        <p className="mx-5 mb-4 rounded-control border border-warn-line bg-warn-tint px-3 py-2 text-small text-text sm:mx-6">
          <span className="font-semibold text-warn">Needs attention:</span> a version is quarantined
          until a moderator reviews it. Fix the findings and publish a new version.
        </p>
      ) : null}

      {skill.versions.length === 0 ? (
        <p className="border-border border-t px-5 py-4 text-muted text-small sm:px-6">
          No versions yet.
        </p>
      ) : (
        <ol
          aria-label={`Versions of ${skill.name}, newest first`}
          className="m-0 list-none border-border border-t p-0"
        >
          {skill.versions.map((v) => (
            <li
              key={v.version}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 border-border border-b px-5 py-3.5 last:border-b-0 sm:px-6 md:grid-cols-[6.5rem_minmax(0,1fr)_auto]"
            >
              <div className="flex min-w-0 flex-col">
                <span
                  className={
                    v.status === 'revoked'
                      ? 'font-mono text-mono text-muted line-through'
                      : 'font-mono text-mono text-text'
                  }
                >
                  {v.version}
                </span>
                <span className="font-mono text-[0.75rem] text-subtle leading-5">
                  {formatDate(v.createdAt)}
                </span>
              </div>
              <div className="col-span-2 row-start-2 flex min-w-0 flex-wrap items-center gap-1.5 md:col-span-1 md:row-start-auto">
                <StatusBadge status={v.status} />
                <OutcomeBadge outcome={v.outcome} />
                <Counts counts={v.counts} />
                {v.statusReason ? (
                  <p className="mt-1 basis-full text-[0.8125rem] text-muted leading-5 [overflow-wrap:anywhere]">
                    Reason: {v.statusReason}
                  </p>
                ) : null}
              </div>
              <div className="flex items-start justify-end">
                <DigestChip digest={v.digest} label={`content digest of ${v.version}`} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
