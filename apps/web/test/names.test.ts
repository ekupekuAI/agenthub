import { describe, expect, it } from 'vitest';
import {
  checkNewName,
  coreTokens,
  damerauLevenshtein,
  distanceLimit,
  isReservedName,
  looksAlike,
  nameForms,
  skeleton,
  sortedForm,
} from '../src/lib/names';

describe('skeleton (normalizer)', () => {
  it('lowercases and strips separators', () => {
    expect(skeleton('Web-Testing')).toBe(skeleton('web_testing'));
    expect(skeleton('web.testing')).toBe(skeleton('webtesting'));
  });

  it('folds digits and lookalike letters', () => {
    expect(skeleton('d0cker')).toBe(skeleton('docker'));
    expect(skeleton('1int')).toBe(skeleton('lint'));
    expect(skeleton('iint')).toBe(skeleton('lint'));
    expect(skeleton('t3st')).toBe(skeleton('test'));
    expect(skeleton('4pi')).toBe(skeleton('api'));
    expect(skeleton('5ql')).toBe(skeleton('sql'));
    expect(skeleton('7ool')).toBe(skeleton('tool'));
  });

  it('folds rn→m, vv→w and cl→d', () => {
    expect(skeleton('cornmit')).toBe(skeleton('commit'));
    expect(skeleton('vvatch')).toBe(skeleton('watch'));
    expect(skeleton('clone')).toBe(skeleton('done'));
  });
});

describe('forms', () => {
  it('drops leading and trailing affixes but keeps one token', () => {
    expect(coreTokens(['web', 'testing', 'cli'])).toEqual(['web', 'testing']);
    expect(coreTokens(['official', 'web', 'testing', 'skill'])).toEqual(['web', 'testing']);
    expect(coreTokens(['cli', 'tool'])).toEqual(['cli']);
  });

  it('includes singular and affix-free forms', () => {
    const forms = nameForms('web-testing-tools');
    expect(forms.has(skeleton('web-testing'))).toBe(true);
    expect(nameForms('lints').has(skeleton('lint'))).toBe(true);
  });

  it('sorts core words', () => {
    expect(sortedForm('testing-web')).toBe(sortedForm('web-testing'));
    expect(sortedForm('lint')).toBeNull();
  });
});

describe('damerauLevenshtein', () => {
  it('counts edits, with adjacent transpositions as one', () => {
    expect(damerauLevenshtein('abc', 'abc')).toBe(0);
    expect(damerauLevenshtein('abc', 'abd')).toBe(1);
    expect(damerauLevenshtein('abc', 'acb')).toBe(1);
    expect(damerauLevenshtein('abc', 'abcd')).toBe(1);
    expect(damerauLevenshtein('kitten', 'sitting')).toBe(3);
    expect(damerauLevenshtein('', 'abc')).toBe(3);
  });

  it('stops early past the limit', () => {
    expect(damerauLevenshtein('aaaaaaaa', 'bbbbbbbb', 1)).toBe(2);
    expect(damerauLevenshtein('a', 'abcdef', 2)).toBe(3);
  });

  it('allows more edits for longer names', () => {
    expect(distanceLimit(4)).toBe(0);
    expect(distanceLimit(5)).toBe(1);
    expect(distanceLimit(9)).toBe(1);
    expect(distanceLimit(10)).toBe(2);
  });
});

describe('looksAlike', () => {
  it.each([
    'web-testlng',
    'web_testing',
    'webtesting',
    'web-testing-cli',
    'web-testing-skill',
    'web-testings',
    'web-tesitng',
    'testing-web',
    'official-web-testing',
    'vveb-testing',
    'web-test1ng',
  ])('%s looks like web-testing', (name) => {
    expect(looksAlike(name, 'web-testing')).toBe(true);
  });

  it('catches 0/o and rn/m', () => {
    expect(looksAlike('d0cker-compose', 'docker-compose')).toBe(true);
    expect(looksAlike('git-cornmit', 'git-commit')).toBe(true);
  });

  it.each([
    ['sql-review', 'api-docs-writer'],
    ['sql-review', 'code-review-checklist'],
    ['changelog-writer', 'unit-test-writer'],
    ['release-checklist', 'code-review-checklist'],
    ['dependency-audit', 'accessibility-audit'],
    ['lint', 'link'],
    ['web-testing', 'web-test'],
  ])('%s does not look like %s', (a, b) => {
    expect(looksAlike(a, b)).toBe(false);
  });
});

describe('reserved names', () => {
  it.each([
    'agenthub',
    'admin',
    'api',
    'claude-code',
    'claude_code',
    'c1aude',
    'anthropic',
    'openai',
    'github-cli',
    'official-agenthub',
    'agenthib',
    'tests',
    'www',
  ])('%s is reserved', (name) => {
    expect(isReservedName(name)).toBe(true);
  });

  it.each([
    'api-docs-writer',
    'api-skill',
    'web-testing',
    'github-pr-review',
    'test-runner',
    'helpful-hints',
  ])('%s is not reserved', (name) => {
    expect(isReservedName(name)).toBe(false);
  });
});

describe('checkNewName', () => {
  const existing = [
    { slug: 'web-testing', publisherId: 'a' },
    { slug: 'sql-review', publisherId: 'a' },
  ];

  it('holds a reserved name for every publisher', () => {
    expect(checkNewName('agenthub', 'a', existing)).toEqual({
      status: 'held',
      kind: 'reserved',
      reason: 'name-review: reserved name',
    });
  });

  it("holds a lookalike of another publisher's name and names the collision", () => {
    expect(checkNewName('web-testlng', 'b', existing)).toEqual({
      status: 'held',
      kind: 'lookalike',
      reason: 'name-review: looks like web-testing',
      conflict: 'web-testing',
    });
  });

  it('lets a publisher grow its own family of names', () => {
    expect(checkNewName('web-testing-cli', 'a', existing)).toEqual({ status: 'clear' });
  });

  it('clears clearly different names', () => {
    expect(checkNewName('api-docs-writer', 'b', existing)).toEqual({ status: 'clear' });
  });
});
