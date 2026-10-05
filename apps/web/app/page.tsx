import { CompatibilityMap } from '../src/components/home/CompatibilityMap';
import { FeatureBento } from '../src/components/home/FeatureBento';
import { GuidelinesCta } from '../src/components/home/GuidelinesCta';
import { HomeHero } from '../src/components/home/HomeHero';
import { HowItWorks } from '../src/components/home/HowItWorks';
import { ProofStrip } from '../src/components/home/ProofStrip';
import { SkillSearch } from '../src/components/home/SkillSearch';
import { getRegistry } from '../src/lib/registry';
import { type Agent, searchQuerySchema } from '../src/lib/validation';

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
  // categories() groups every skill that has an active version, so the counts sum to the total.
  const skillCount = categories.reduce((sum, c) => sum + c.count, 0);

  return (
    <>
      <HomeHero />
      <ProofStrip skillCount={skillCount} />
      <SkillSearch
        query={query}
        filtersValid={parsed.success}
        searching={searching}
        results={results}
        categories={categories}
        recent={recent}
      />
      <FeatureBento />
      <CompatibilityMap />
      <HowItWorks />
      <GuidelinesCta />
    </>
  );
}
