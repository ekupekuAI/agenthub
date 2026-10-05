import Link from 'next/link';
import type { ReactNode } from 'react';
import type { SearchResult } from '../../lib/api-types';
import { cn } from '../../lib/cn';
import { AGENT_LABELS, AGENTS, type Agent } from '../../lib/validation';
import {
  AGENT_META,
  Button,
  Container,
  EmptyState,
  Eyebrow,
  SearchIcon,
  Stagger,
  StaggerItem,
} from '../ui';
import { HomeSkillCard } from './HomeSkillCard';

export interface SkillQuery {
  q?: string;
  agent?: Agent;
  category?: string;
}

export interface SkillSearchProps {
  query: SkillQuery;
  /** False when some search parameters failed validation and were ignored. */
  filtersValid: boolean;
  searching: boolean;
  results: SearchResult[];
  categories: { category: string; count: number }[];
  recent: SearchResult[];
}

/** `/?q=…&agent=…&category=…#skills`, with the patch applied (undefined clears a key). */
function searchHref(query: SkillQuery, patch: Partial<SkillQuery>): string {
  const next = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.agent) params.set('agent', next.agent);
  if (next.category) params.set('category', next.category);
  const qs = params.toString();
  return `/${qs ? `?${qs}` : ''}#skills`;
}

const CHIP =
  'tap-target inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-small no-underline transition-colors duration-150';
const CHIP_ON = 'border-signal-line bg-signal-tint text-signal-ink hover:text-signal-ink';
const CHIP_OFF =
  'border-border bg-surface-1 text-muted hover:border-border-strong hover:bg-surface-2 hover:text-text';

function Chip({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        aria-current={active ? 'true' : undefined}
        className={cn(CHIP, active ? CHIP_ON : CHIP_OFF)}
      >
        {children}
      </Link>
    </li>
  );
}

function FilterRow({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:items-start sm:gap-4">
      <p id={id} className="eyebrow sm:pt-2.5">
        {label}
      </p>
      <ul aria-labelledby={id} className="m-0 flex list-none flex-wrap gap-2 p-0">
        {children}
      </ul>
    </div>
  );
}

function CardGrid({ skills }: { skills: SearchResult[] }) {
  return (
    <Stagger as="ul" className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
      {skills.map((skill) => (
        <StaggerItem as="li" key={skill.slug} className="min-w-0">
          <HomeSkillCard skill={skill} />
        </StaggerItem>
      ))}
    </Stagger>
  );
}

/**
 * The registry search: a GET form to `/` (q, agent, category), filter chips that are plain
 * links, then either the results or the recently updated skills.
 */
export function SkillSearch({
  query,
  filtersValid,
  searching,
  results,
  categories,
  recent,
}: SkillSearchProps) {
  const named = categories.filter((c) => Boolean(c.category));

  return (
    <section id="skills" aria-labelledby="skills-heading" className="py-14 lg:py-24">
      <Container>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <Eyebrow className="mb-3">Registry</Eyebrow>
            <h2 id="skills-heading" className="display-2 text-text">
              Find a skill, read its <em className="text-signal-ink italic">evidence</em>.
            </h2>
            <p className="mt-4 text-body text-muted">
              Every result shows its scan verdict, the agents it supports and who published it.
            </p>
          </div>
        </div>

        <search aria-label="Search the registry" className="mt-10 block">
          <form
            action="/#skills"
            method="get"
            className="flex flex-col gap-2 rounded-panel border border-border-field bg-surface-1 p-2 shadow-panel transition-colors duration-150 focus-within:border-ring sm:flex-row sm:items-center"
          >
            <div className="relative min-w-0 flex-1">
              <label htmlFor="q" className="sr-only">
                Search
              </label>
              <SearchIcon
                size={18}
                className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-subtle"
              />
              <input
                id="q"
                name="q"
                type="search"
                defaultValue={query.q ?? ''}
                placeholder="Search skills: web testing, changelog, sql"
                maxLength={200}
                autoComplete="off"
                className="h-12 w-full min-w-0 rounded-control border-0 bg-transparent pr-3 pl-11 text-body text-text placeholder:text-subtle"
              />
            </div>
            {query.agent ? <input type="hidden" name="agent" value={query.agent} /> : null}
            {query.category ? <input type="hidden" name="category" value={query.category} /> : null}
            <Button variant="primary" size="lg" type="submit" className="shrink-0">
              Search
            </Button>
          </form>
        </search>
        {!filtersValid ? (
          <p role="alert" className="mt-3 text-block text-small">
            Some search filters were not recognised and were ignored.
          </p>
        ) : null}

        <div className="mt-6 grid gap-4">
          <FilterRow id="filter-agent" label="Agent">
            <Chip href={searchHref(query, { agent: undefined })} active={!query.agent}>
              Any agent
            </Chip>
            {AGENTS.map((agent) => (
              <Chip
                key={agent}
                href={searchHref(query, { agent: query.agent === agent ? undefined : agent })}
                active={query.agent === agent}
              >
                <span aria-hidden="true" className="font-mono text-[0.6875rem] tracking-[0.04em]">
                  {AGENT_META[agent].monogram}
                </span>
                {AGENT_LABELS[agent]}
              </Chip>
            ))}
          </FilterRow>
          {named.length > 0 ? (
            <FilterRow id="filter-category" label="Category">
              <Chip href={searchHref(query, { category: undefined })} active={!query.category}>
                Any category
              </Chip>
              {named.map((c) => (
                <Chip
                  key={c.category}
                  href={searchHref(query, {
                    category: query.category === c.category ? undefined : c.category,
                  })}
                  active={query.category === c.category}
                >
                  {c.category}
                  <span className="font-mono text-[0.75rem] opacity-80">
                    <span className="sr-only">(</span>
                    {c.count}
                    <span className="sr-only"> skills)</span>
                  </span>
                </Chip>
              ))}
            </FilterRow>
          ) : null}
        </div>

        <div className="mt-12">
          {searching ? (
            <section aria-labelledby="results-heading">
              <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-border border-b pb-4">
                <h3 id="results-heading" className="font-semibold text-h3 text-text">
                  {results.length} {results.length === 1 ? 'result' : 'results'}
                  {query.q ? (
                    <>
                      {' '}
                      for <span className="font-mono font-normal">“{query.q}”</span>
                    </>
                  ) : null}
                </h3>
                <Link href="/#skills" className="text-small">
                  Clear search
                </Link>
              </div>
              {results.length === 0 ? (
                <EmptyState
                  icon={<SearchIcon size={22} />}
                  title="No active skills match"
                  description="Try a broader term, or remove the agent and category filters."
                  action={
                    <Button href="/#skills" variant="secondary">
                      Clear filters
                    </Button>
                  }
                />
              ) : (
                <CardGrid skills={results} />
              )}
            </section>
          ) : (
            <section aria-labelledby="recent-heading">
              <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-border border-b pb-4">
                <h3 id="recent-heading" className="font-semibold text-h3 text-text">
                  Recently updated
                </h3>
                <p className="font-mono text-[0.75rem] text-subtle leading-5">most recent first</p>
              </div>
              {categories.length === 0 ? (
                <EmptyState
                  icon={<SearchIcon size={22} />}
                  title="The registry is empty"
                  description={
                    <>
                      Run <code>npm run seed -w apps/web</code> to load the starter skills.
                    </>
                  }
                />
              ) : (
                <CardGrid skills={recent} />
              )}
            </section>
          )}
        </div>
      </Container>
    </section>
  );
}
