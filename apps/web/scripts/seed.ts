/**
 * Seeds the registry with the starter skills in registry/seed/skills, published by the
 * verified "agenthub-team" publisher, plus three scanner fixtures under the unverified
 * "fixture-lab" publisher so the moderation queue and warnings can be demonstrated.
 *
 * Idempotent: existing publishers are reused and existing versions are skipped.
 * Run with `npm run seed -w apps/web` (bundled by scripts/run-seed.mjs). New publisher tokens
 * go to `<data dir>/seed-tokens.txt` (owner-only); pass `-- --print-tokens` to print them.
 * Refuses to run with NODE_ENV=production unless AGENTHUB_SEED_FORCE=1.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { loadSkillFromDir, packSkill } from '@agenthub/core';
import { dataDir } from '../src/config';
import { getDatabase } from '../src/db/client';
import { isApiError } from '../src/lib/errors';
import { getRegistry, type Registry } from '../src/lib/registry';

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, 'registry', 'seed', 'skills'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error('Could not find registry/seed/skills above the current folder');
    dir = parent;
  }
}

async function ensurePublisher(
  registry: Registry,
  name: string,
  verified: boolean,
): Promise<string> {
  const existing = await registry.findPublisherByName(name);
  if (existing) {
    console.log(`publisher ${name}: exists (its token was shown when it was created)`);
    return existing.id;
  }
  const created = await registry.createPublisher(name, verified);
  console.log(`publisher ${name}: created${verified ? ' (verified)' : ''}`);
  if (process.argv.includes('--print-tokens')) {
    console.log(`  token (shown once, store it safely): ${created.token}`);
  } else {
    // Keep tokens out of terminal scrollback and CI logs: write them to an owner-only file.
    const file = path.join(dataDir(), 'seed-tokens.txt');
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(file, `${name}\t${created.token}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    console.log(`  token written to ${file} (owner-only; delete it once stored safely)`);
  }
  return created.id;
}

async function publishDir(registry: Registry, dir: string, publisherId: string): Promise<void> {
  const name = path.basename(dir);
  const hasManifest = existsSync(path.join(dir, 'agenthub.yaml'));
  try {
    const pkg = await loadSkillFromDir(dir);
    const summary = await registry.publish(packSkill(pkg), publisherId, {
      releaseNotes: 'Initial release.',
      ...(hasManifest ? {} : { version: '1.0.0' }),
    });
    const counts = { INFO: 0, WARN: 0, BLOCK: 0 };
    for (const f of summary.findings) counts[f.decision] += 1;
    console.log(
      `  ${summary.slug}@${summary.version}: ${summary.status} (${summary.outcome}; ` +
        `${counts.BLOCK} block, ${counts.WARN} warn, ${counts.INFO} info)`,
    );
  } catch (error) {
    if (isApiError(error) && error.code === 'CONFLICT') {
      console.log(`  ${name}: skipped (${error.message})`);
      return;
    }
    console.error(`  ${name}: FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.AGENTHUB_SEED_FORCE !== '1') {
    throw new Error(
      'Refusing to seed with NODE_ENV=production (it creates publishers and tokens). ' +
        'Set AGENTHUB_SEED_FORCE=1 to seed anyway.',
    );
  }
  const root = findRepoRoot(process.cwd());
  console.log(`data dir: ${dataDir()}`);
  const registry = await getRegistry();

  const teamId = await ensurePublisher(registry, 'agenthub-team', true);
  const seedRoot = path.join(root, 'registry', 'seed', 'skills');
  for (const name of readdirSync(seedRoot).sort()) {
    const dir = path.join(seedRoot, name);
    if (existsSync(path.join(dir, 'SKILL.md'))) await publishDir(registry, dir, teamId);
  }

  const fixtureRoot = path.join(root, 'packages', 'test-fixtures', 'fixtures');
  const fixtures = ['secret-reader', 'download-exec', 'prompt-injection'].filter((f) =>
    existsSync(path.join(fixtureRoot, f, 'SKILL.md')),
  );
  if (fixtures.length > 0) {
    const labId = await ensurePublisher(registry, 'fixture-lab', false);
    for (const name of fixtures) await publishDir(registry, path.join(fixtureRoot, name), labId);
  } else {
    console.log('fixtures: none found in packages/test-fixtures/fixtures (skipped)');
  }

  await (await getDatabase()).close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
