import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_DIR,
  FIXTURES_DIR,
  fixtureNames,
  fixturePath,
  readExpected,
  readFixtureFiles,
  readVersionFiles,
  versionFixtures,
} from '../src/index';

const decoder = new TextDecoder();

function frontmatter(name: string): string {
  const skill = readFixtureFiles(name).find((f) => f.path === 'SKILL.md');
  if (skill === undefined) throw new Error(`${name} has no SKILL.md`);
  const match = /^---\n([\s\S]*?)\n---\n/.exec(
    decoder.decode(skill.content).replace(/\r\n/g, '\n'),
  );
  if (match === null) throw new Error(`${name} SKILL.md has no frontmatter`);
  return match[1] as string;
}

describe('fixture skills', () => {
  const names = fixtureNames();

  it('lives in an absolute fixtures folder', () => {
    expect(isAbsolute(FIXTURES_DIR)).toBe(true);
    expect(existsSync(FIXTURES_DIR)).toBe(true);
    expect(names.length).toBe(12);
  });

  it.each(names)('%s has a SKILL.md whose name equals the folder and a description', (name) => {
    const fm = frontmatter(name);
    expect(fm).toMatch(new RegExp(`^name: ${name}$`, 'm'));
    expect(fm).toMatch(/^description: \S.{0,1023}$/m);
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it.each(names)('%s has a valid expectation file', (name) => {
    const expected = readExpected(name);
    expect(['allow', 'confirm', 'block']).toContain(expected.outcome);
    expect(expected.ruleIds).toEqual([...new Set(expected.ruleIds)].sort());
    expect(expected.externals).toEqual([...new Set(expected.externals)].sort());
  });

  it.each(versionFixtures())(
    'version fixture %s/%s keeps the name and has an expectation',
    (variant, name) => {
      expect(names).toContain(name);
      expect(readVersionFiles(variant, name).some((f) => f.path === 'SKILL.md')).toBe(true);
      expect(['allow', 'confirm', 'block']).toContain(readExpected(name, variant).outcome);
    },
  );

  it('keeps expectations outside the skill folders, one per fixture', () => {
    const files = readdirSync(EXPECTED_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    expect(files).toEqual(names.map((n) => `${n}.json`));
    for (const name of names) {
      expect(
        readFixtureFiles(name).some(
          (f) => f.path.endsWith('.json') && f.path.startsWith('expected'),
        ),
      ).toBe(false);
    }
  });

  it('readFixtureFiles returns sorted POSIX paths with their bytes', () => {
    const files = readFixtureFiles('complex-benign');
    expect(files.map((f) => f.path)).toEqual([
      'SKILL.md',
      'agenthub.yaml',
      'assets/icon.png',
      'assets/logo.svg',
      'references/guide.md',
      'scripts/build.mjs',
      'scripts/check.py',
    ]);
    const png = files.find((f) => f.path === 'assets/icon.png');
    expect(Array.from(png?.content.subarray(0, 4) ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('fixturePath resolves a known fixture', () => {
    expect(fixturePath('hello-skill')).toBe(join(FIXTURES_DIR, 'hello-skill'));
  });

  it('fixturePath rejects unknown names and path tricks', () => {
    expect(() => fixturePath('no-such-skill')).toThrow(/unknown fixture/);
    expect(() => fixturePath('../expected')).toThrow(/invalid fixture name/);
    expect(() => readExpected('no-such-skill')).toThrow(/unknown fixture/);
  });

  it('keeps payloads inert: only reserved .invalid hosts in scripts', () => {
    const all = [
      ...names.map((name) => ({ name, files: readFixtureFiles(name) })),
      ...versionFixtures().map(([variant, name]) => ({
        name: `${variant}/${name}`,
        files: readVersionFiles(variant, name),
      })),
    ];
    for (const { name, files } of all) {
      for (const f of files) {
        if (!/\.(?:sh|mjs|js|py|md|json)$/.test(f.path)) continue;
        const hosts = [...decoder.decode(f.content).matchAll(/https?:\/\/([^/\s'")]+)/g)].map(
          (m) => m[1],
        );
        for (const host of hosts)
          expect(host, `${name}/${f.path}`).toMatch(/(?:^|\.)(?:invalid|playwright\.dev)$/);
      }
    }
  });
});
