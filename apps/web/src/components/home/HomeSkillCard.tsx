import Link from 'next/link';
import type { ScanOutcome, SearchResult } from '../../lib/api-types';
import { cn } from '../../lib/cn';
import { AgentStrip, SpotlightCard, VerifiedMark } from '../ui';

const VERDICTS: Record<
  ScanOutcome | 'none',
  { word: string; dot: string; text: string; title: string }
> = {
  allow: {
    word: 'No warnings',
    dot: 'bg-signal',
    text: 'text-signal-ink',
    title: 'The scanner found nothing above INFO',
  },
  confirm: {
    word: 'Review warnings',
    dot: 'bg-warn',
    text: 'text-warn',
    title: 'At least one finding needs your confirmation',
  },
  block: {
    word: 'Blocked',
    dot: 'bg-block',
    text: 'text-block',
    title: 'At least one finding is blocked by policy',
  },
  none: {
    word: 'Not scanned',
    dot: 'border border-subtle bg-transparent',
    text: 'text-subtle',
    title: 'No scan result is recorded for this version',
  },
};

/** Verdict as a dot plus a word, so it never relies on color alone. */
export function VerdictMark({ outcome }: { outcome?: ScanOutcome | null }) {
  const v = VERDICTS[outcome ?? 'none'];
  return (
    <span
      title={v.title}
      className={cn('inline-flex items-center gap-2 font-mono text-[0.75rem] leading-5', v.text)}
    >
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', v.dot)} />
      <span>
        <span className="sr-only">Scan verdict: </span>
        {v.word}
      </span>
    </span>
  );
}

/**
 * A registry search result on the home page: mono name, summary, scan verdict, version,
 * publisher and agent support. The whole card is one link (the name) for pointer users.
 */
export function HomeSkillCard({ skill }: { skill: SearchResult }) {
  return (
    <SpotlightCard
      className="h-full transition-colors duration-150 hover:bg-border-strong has-[a:focus-visible]:bg-ring"
      innerClassName="p-5"
    >
      <article className="flex h-full flex-col">
        <div className="flex items-baseline justify-between gap-3">
          <h4 className="min-w-0 font-medium font-mono text-[0.9375rem] leading-6">
            <Link
              href={`/skills/${skill.slug}`}
              className="break-words text-text no-underline after:absolute after:-inset-5 after:content-[''] hover:text-text"
            >
              {skill.name}
            </Link>
          </h4>
          {skill.latestVersion ? (
            <span className="shrink-0 font-mono text-[0.75rem] text-subtle leading-5">
              <span className="sr-only">Latest version </span>v{skill.latestVersion}
            </span>
          ) : null}
        </div>
        <p className="mt-2 line-clamp-3 text-muted text-small">{skill.summary}</p>
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-4">
          <VerdictMark outcome={skill.scanOutcome} />
          {skill.category ? (
            <span className="font-mono text-[0.75rem] text-subtle leading-5">
              <span aria-hidden="true">/ </span>
              <span className="sr-only">Category: </span>
              {skill.category}
            </span>
          ) : null}
        </div>
        <div className="mt-4 flex items-center justify-between gap-3 border-border border-t pt-3">
          {skill.publisher ? (
            <p className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-muted leading-5">
              <span className="sr-only">Publisher: </span>
              <span className="truncate">{skill.publisher.name}</span>
              {skill.publisher.verified ? <VerifiedMark size={14} /> : null}
            </p>
          ) : (
            <span />
          )}
          <AgentStrip supported={skill.agents} size="sm" label="Supported agents" />
        </div>
      </article>
    </SpotlightCard>
  );
}
