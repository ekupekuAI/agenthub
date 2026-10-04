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
    expect(names.length).toBe(10);
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
  });

  it('keeps expectations outside the skill folders, one per fixture', () => {
    const files = readdirSync(EXPECTED_DIR).sort();
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
    for (const name of names) {
      for (const f of readFixtureFiles(name)) {
        if (!/\.(?:sh|mjs|js|py|md)$/.test(f.path)) continue;
        const hosts = [...decoder.decode(f.content).matchAll(/https?:\/\/([^/\s'")]+)/g)].map(
          (m) => m[1],
        );
        for (const host of hosts)
          expect(host, `${name}/${f.path}`).toMatch(/(?:^|\.)(?:invalid|playwright\.dev)$/);
      }
    }
  });
});
