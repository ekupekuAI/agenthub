import Link from 'next/link';
import { SkillCard } from '../src/components/SkillCard';
import { getRegistry } from '../src/lib/registry';
import { AGENT_LABELS, AGENTS, type Agent, searchQuerySchema } from '../src/lib/validation';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === '' ? undefined : v;
}

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const parsed = searchQuerySchema.safeParse({
    q: first(raw.q),
    agent: first(raw.agent),
    category: first(raw.category),
  });
  const query: { q?: string; agent?: Agent; category?: string } = parsed.success ? parsed.data : {};
  const searching = Boolean(query.q || query.agent || query.category);

  const registry = await getRegistry();
  const [results, categories, recent] = await Promise.all([
    searching ? registry.search({ ...query, limit: 50 }) : Promise.resolve([]),
    registry.categories(),
    searching ? Promise.resolve([]) : registry.search({ limit: 6 }),
  ]);

  return (
    <div>
      <section className="border-b border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <h1 className="max-w-3xl text-3xl font-bold tracking-tight sm:text-4xl">
            The package manager and trust layer for agent skills.
          </h1>
          <p className="mt-3 max-w-2xl text-base text-muted sm:text-lg">
            Find skills for Claude Code, Codex, Cursor and VS Code. Every version is immutable,
            content-addressed and scanned before anyone can install it.
          </p>

          <search aria-label="Search skills">
            <form
              action="/"
              method="get"
              className="mt-8 grid gap-3 rounded-xl border border-line bg-canvas p-3 shadow-sm sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
            >
              <div className="flex flex-col gap-1">
                <label htmlFor="q" className="text-xs font-semibold text-muted">
                  Search
                </label>
                <input
                  id="q"
                  name="q"
                  type="search"
                  defaultValue={query.q ?? ''}
                  placeholder="e.g. web testing, changelog, sql"
                  maxLength={200}
                  className="w-full rounded-md border border-line bg-canvas px-3 py-2 text-ink placeholder:text-muted"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="agent" className="text-xs font-semibold text-muted">
                  Agent
                </label>
                <select
                  id="agent"
                  name="agent"
                  defaultValue={query.agent ?? ''}
                  className="rounded-md border border-line bg-canvas px-3 py-2 text-ink"
                >
                  <option value="">Any agent</option>
                  {AGENTS.map((a) => (
                    <option key={a} value={a}>
                      {AGENT_LABELS[a]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor="category" className="text-xs font-semibold text-muted">
                  Category
                </label>
                <select
                  id="category"
                  name="category"
                  defaultValue={query.category ?? ''}
                  className="rounded-md border border-line bg-canvas px-3 py-2 text-ink"
                >
                  <option value="">Any category</option>
                  {categories.map((c) => (
                    <option key={c.category} value={c.category}>
                      {c.category}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="submit"
                className="rounded-md bg-accent px-5 py-2 font-semibold text-accent-ink transition-colors hover:bg-accent-strong"
              >
                Search
              </button>
            </form>
          </search>
          {!parsed.success ? (
            <p role="alert" className="mt-3 text-sm text-bad-fg">
              Some search filters were not recognised and were ignored.
            </p>
          ) : null}
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {searching ? (
          <section aria-labelledby="results-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="results-heading" className="text-xl font-semibold">
                {results.length} {results.length === 1 ? 'result' : 'results'}
                {query.q ? (
                  <>
                    {' '}
                    for <span className="font-mono">“{query.q}”</span>
                  </>
                ) : null}
              </h2>
              <Link href="/" className="text-sm">
                Clear search
              </Link>
            </div>
            {results.length === 0 ? (
              <p className="mt-6 rounded-lg border border-dashed border-line p-6 text-muted">
                No active skills match. Try a broader term, or remove the agent and category
                filters.
              </p>
            ) : (
              <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {results.map((skill) => (
                  <li key={skill.slug}>
                    <SkillCard skill={skill} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <>
            <section aria-labelledby="categories-heading">
              <h2 id="categories-heading" className="text-xl font-semibold">
                Browse by category
              </h2>
              {categories.length === 0 ? (
                <p className="mt-4 text-muted">
                  The registry is empty. Run <code>npm run seed -w apps/web</code> to load the
                  starter skills.
                </p>
              ) : (
                <ul className="mt-4 flex flex-wrap gap-2">
                  {categories.map((c) => (
                    <li key={c.category}>
                      <Link
                        href={`/?category=${encodeURIComponent(c.category)}`}
                        className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm font-medium text-ink no-underline transition-colors hover:border-accent hover:text-accent"
                      >
                        {c.category}
                        <span className="text-xs text-muted">{c.count}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="recent-heading" className="mt-12">
              <h2 id="recent-heading" className="text-xl font-semibold">
                Recently updated
              </h2>
              <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {recent.map((skill) => (
                  <li key={skill.slug}>
                    <SkillCard skill={skill} />
                  </li>
                ))}
              </ul>
            </section>

            <section
              aria-labelledby="how-heading"
              className="mt-12 grid gap-4 rounded-xl border border-line bg-surface p-6 sm:grid-cols-3"
            >
              <h2 id="how-heading" className="sr-only">
                How agenthub keeps installs safe
              </h2>
              <div>
                <h3 className="font-semibold">Immutable versions</h3>
                <p className="mt-1 text-sm text-muted">
                  A published version never changes. Its SHA-256 content digest is its identity.
                </p>
              </div>
              <div>
                <h3 className="font-semibold">Scanned on upload</h3>
                <p className="mt-1 text-sm text-muted">
                  Every package is checked for risky behavior. Blocked uploads are quarantined.
                </p>
              </div>
              <div>
                <h3 className="font-semibold">Revocable</h3>
                <p className="mt-1 text-sm text-muted">
                  Bad releases can be pulled. Revoked versions can no longer be installed.{' '}
                  <Link href="/guidelines#security-model">How it works</Link>
                </p>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
