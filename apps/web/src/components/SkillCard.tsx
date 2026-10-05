import Link from 'next/link';
import type { SearchResult } from '../lib/api-types';
import { AgentStrip } from './ui/AgentStrip';
import { OutcomeBadge } from './ui/OutcomeBadge';
import { VerifiedMark } from './ui/VerifiedMark';

/** A search result: name, version, summary, scan verdict, publisher and agent support. */
export function SkillCard({ skill }: { skill: SearchResult }) {
  return (
    <article className="group relative flex h-full flex-col rounded-card border border-border bg-surface-1 p-5 transition-colors duration-150 focus-within:border-border-strong hover:border-border-strong hover:bg-surface-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="min-w-0 font-medium font-mono text-[0.9375rem] leading-6">
          <Link
            href={`/skills/${skill.slug}`}
            className="break-words text-text no-underline after:absolute after:inset-0 after:rounded-card after:content-['']"
          >
            {skill.name}
          </Link>
        </h3>
        {skill.latestVersion ? (
          <span className="shrink-0 font-mono text-[0.8125rem] text-subtle">
            v{skill.latestVersion}
          </span>
        ) : null}
      </div>
      <p className="mt-2 line-clamp-3 text-muted text-small">{skill.summary}</p>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <OutcomeBadge outcome={skill.scanOutcome} />
        {skill.category ? (
          <span className="inline-flex h-6 items-center rounded-chip border border-border px-1.5 font-mono text-[0.75rem] text-muted">
            {skill.category}
          </span>
        ) : null}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-border border-t pt-3">
        {skill.publisher ? (
          <p className="flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-muted leading-5">
            <span className="truncate">{skill.publisher.name}</span>
            {skill.publisher.verified ? <VerifiedMark size={14} /> : null}
          </p>
        ) : (
          <span />
        )}
        <AgentStrip supported={skill.agents} size="sm" label="Supported agents" />
      </div>
    </article>
  );
}
