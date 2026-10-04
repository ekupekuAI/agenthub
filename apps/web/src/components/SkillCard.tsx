import Link from 'next/link';
import type { SearchResult } from '../lib/api-types';
import { AGENT_LABELS } from '../lib/validation';
import { OutcomeBadge } from './Badges';

export function SkillCard({ skill }: { skill: SearchResult }) {
  return (
    <article className="group relative flex h-full flex-col rounded-xl border border-line bg-canvas p-4 transition-colors hover:border-accent">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold leading-snug">
          <Link
            href={`/skills/${skill.slug}`}
            className="text-ink no-underline after:absolute after:inset-0 after:content-[''] group-hover:text-accent"
          >
            {skill.name}
          </Link>
        </h3>
        {skill.latestVersion ? (
          <span className="shrink-0 font-mono text-xs text-muted">v{skill.latestVersion}</span>
        ) : null}
      </div>
      <p className="mt-1.5 line-clamp-3 text-sm text-muted">{skill.summary}</p>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-3 text-xs text-muted">
        <OutcomeBadge outcome={skill.scanOutcome} />
        {skill.category ? (
          <span className="rounded-full border border-line px-2 py-0.5">{skill.category}</span>
        ) : null}
        {skill.publisher ? (
          <span>
            by {skill.publisher.name}
            {skill.publisher.verified ? (
              <span className="text-accent" title="Verified publisher">
                {' '}
                ✓<span className="sr-only"> verified</span>
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted">
        <span className="sr-only">Supported agents: </span>
        {skill.agents.map((a) => AGENT_LABELS[a]).join(' · ')}
      </p>
    </article>
  );
}
