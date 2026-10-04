/**
 * Skill fixtures for scanner, engine and CLI tests (design §9). Every payload is inert: hosts
 * use the reserved `.invalid` TLD, paths and secrets are fake, and nothing here is executed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PolicyResult } from '@agenthub/core';

/** Absolute path of the folder that holds one sub-folder per fixture skill. */
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url));

/** Absolute path of the folder with `<name>.json` expectations, kept outside the skills. */
export const EXPECTED_DIR = fileURLToPath(new URL('../expected', import.meta.url));

export interface FixtureFile {
  /** POSIX path relative to the skill root. */
  path: string;
  content: Uint8Array;
}

export interface FixtureExpectation {
  outcome: PolicyResult['outcome'];
  /** Sorted, unique rule ids the scanner must report for the fixture. */
  ruleIds: string[];
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
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`invalid fixture name: ${name}`);
  const path = join(FIXTURES_DIR, name);
  if (!existsSync(path) || !statSync(path).isDirectory())
    throw new Error(`unknown fixture: ${name}`);
  return path;
}

/** Every file of a fixture, recursively, with POSIX relative paths, sorted by path. */
export function readFixtureFiles(name: string): FixtureFile[] {
  const root = fixturePath(name);
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

/** The expected policy outcome and rule ids for a fixture. */
export function readExpected(name: string): FixtureExpectation {
  fixturePath(name);
  const raw = JSON.parse(readFileSync(join(EXPECTED_DIR, `${name}.json`), 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null) throw new Error(`malformed expectation: ${name}`);
  const { outcome, ruleIds } = raw as Record<string, unknown>;
  if (outcome !== 'allow' && outcome !== 'confirm' && outcome !== 'block') {
    throw new Error(`malformed expectation outcome: ${name}`);
  }
  if (!Array.isArray(ruleIds) || !ruleIds.every((id) => typeof id === 'string')) {
    throw new Error(`malformed expectation ruleIds: ${name}`);
  }
  return { outcome, ruleIds: ruleIds as string[] };
}
