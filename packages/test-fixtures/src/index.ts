/**
 * Skill fixtures for scanner, engine and CLI tests (design §9). Every payload is inert: hosts
 * use the reserved `.invalid` TLD, paths and secrets are fake, and nothing here is executed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExternalRef, PolicyResult } from '@agenthub/core';

/** Absolute path of the folder that holds one sub-folder per fixture skill. */
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

/**
 * Absolute path of the folder with later versions of fixture skills, one sub-folder per variant
 * (`versions/<variant>/<name>`), for update and capability-diff tests.
 */
export const VERSIONS_DIR = fileURLToPath(new URL('../versions', import.meta.url));

/** Absolute path of the folder with `<name>.json` expectations, kept outside the skills. */
export const EXPECTED_DIR = fileURLToPath(new URL('../expected', import.meta.url));

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface FixtureFile {
  /** POSIX path relative to the skill root. */
  path: string;
  content: Uint8Array;
}

export interface FixtureExpectation {
  outcome: PolicyResult['outcome'];
  /** Sorted, unique rule ids the scanner must report for the fixture. */
  ruleIds: string[];
  /** Sorted externals, each rendered by externalSummary(). */
  externals: string[];
}

/** '<kind>:<id> <role> <pin>[ <pinValue>]', the form used in expectation files. */
export function externalSummary(ref: ExternalRef): string {
  const pin = ref.pinValue === null ? ref.pin : `${ref.pin} ${ref.pinValue}`;
  return `${ref.kind}:${ref.id} ${ref.role} ${pin}`;
}

/** Names of every fixture skill, sorted. */
export function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Absolute path of a fixture skill folder. Throws for an unknown name. */
export function fixturePath(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid fixture name: ${name}`);
  const path = join(FIXTURES_DIR, name);
  if (!existsSync(path) || !statSync(path).isDirectory())
    throw new Error(`unknown fixture: ${name}`);
  return path;
}

/** Version fixtures as [variant, name] pairs (e.g. ['expanding', 'web-testing']), sorted. */
export function versionFixtures(): [string, string][] {
  const out: [string, string][] = [];
  for (const variant of readdirSync(VERSIONS_DIR, { withFileTypes: true })) {
    if (!variant.isDirectory()) continue;
    for (const skill of readdirSync(join(VERSIONS_DIR, variant.name), { withFileTypes: true })) {
      if (skill.isDirectory()) out.push([variant.name, skill.name]);
    }
  }
  return out.sort((a, b) => (a.join('/') < b.join('/') ? -1 : 1));
}

/** Absolute path of a later version of a fixture skill. Throws for an unknown pair. */
export function versionFixturePath(variant: string, name: string): string {
  for (const part of [variant, name]) {
    if (!NAME.test(part)) throw new Error(`invalid fixture name: ${part}`);
  }
  const path = join(VERSIONS_DIR, variant, name);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`unknown version fixture: ${variant}/${name}`);
  }
  return path;
}

/** Every file of a fixture, recursively, with POSIX relative paths, sorted by path. */
export function readFixtureFiles(name: string): FixtureFile[] {
  return readTree(fixturePath(name));
}

/** Every file of a version fixture (see readFixtureFiles). */
export function readVersionFiles(variant: string, name: string): FixtureFile[] {
  return readTree(versionFixturePath(variant, name));
}

function readTree(root: string): FixtureFile[] {
  const files: FixtureFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile())
        files.push({ path: rel, content: new Uint8Array(readFileSync(abs)) });
    }
  };
  walk(root, '');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The expected policy outcome, rule ids and externals for a fixture, or for a version fixture
 * when `variant` is given (expected/versions/<variant>-<name>.json).
 */
export function readExpected(name: string, variant?: string): FixtureExpectation {
  let file: string;
  if (variant === undefined) {
    fixturePath(name);
    file = join(EXPECTED_DIR, `${name}.json`);
  } else {
    versionFixturePath(variant, name);
    file = join(EXPECTED_DIR, 'versions', `${variant}-${name}.json`);
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null) throw new Error(`malformed expectation: ${name}`);
  const { outcome, ruleIds, externals } = raw as Record<string, unknown>;
  if (outcome !== 'allow' && outcome !== 'confirm' && outcome !== 'block') {
    throw new Error(`malformed expectation outcome: ${name}`);
  }
  if (!Array.isArray(ruleIds) || !ruleIds.every((id) => typeof id === 'string')) {
    throw new Error(`malformed expectation ruleIds: ${name}`);
  }
  if (!Array.isArray(externals) || !externals.every((e) => typeof e === 'string')) {
    throw new Error(`malformed expectation externals: ${name}`);
  }
  return { outcome, ruleIds: ruleIds as string[], externals: externals as string[] };
}
