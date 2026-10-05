import { describe, expect, it } from 'vitest';
import type { ValidationIssue } from '../src/index';
import { parseSkillMd, validateFrontmatter } from '../src/index';
import { catchError, hasControlChar, issueCodes, skillMd, toCrlf } from './helpers';

const base = { name: 'web-testing', description: 'Test web apps.' };

function codes(issues: ValidationIssue[], level?: 'error' | 'warning'): string[] {
  return issues.filter((issue) => level === undefined || issue.level === level).map((i) => i.code);
}

describe('validateFrontmatter: name', () => {
  it.each(['a', 'web-testing', 'a1-b2-c3', '0', 'x'.repeat(64)])('accepts %s', (name) => {
    expect(validateFrontmatter({ ...base, name })).toEqual([]);
  });

  it.each([
    ['Web', 'name.format'],
    ['-a', 'name.format'],
    ['a-', 'name.format'],
    ['a--b', 'name.format'],
    ['web_testing', 'name.format'],
    ['web testing', 'name.format'],
    ['café', 'name.format'],
    ['x'.repeat(65), 'name.length'],
    ['', 'name.length'],
  ])('rejects %j with %s', (name, code) => {
    expect(codes(validateFrontmatter({ ...base, name }), 'error')).toContain(code);
  });

  it.each(['nul', 'con', 'aux', 'prn', 'com1', 'com9', 'lpt1', 'lpt9'])(
    'rejects the Windows device name %s',
    (name) => {
      expect(codes(validateFrontmatter({ ...base, name }), 'error')).toEqual(['name.reserved']);
    },
  );

  it('allows names that only contain a device name', () => {
    expect(validateFrontmatter({ ...base, name: 'console' })).toEqual([]);
    expect(validateFrontmatter({ ...base, name: 'com10' })).toEqual([]);
    expect(validateFrontmatter({ ...base, name: 'nul-tools' })).toEqual([]);
  });

  it('escapes control characters when quoting a bad name', () => {
    const issues = validateFrontmatter({ ...base, name: 'a\u001b[2Jb' });
    for (const issue of issues) expect(hasControlChar(issue.message)).toBe(false);
  });

  it('requires name', () => {
    expect(codes(validateFrontmatter({ description: 'x' }))).toEqual(['name.missing']);
  });

  it('requires name to be a string', () => {
    expect(codes(validateFrontmatter({ ...base, name: 42 }))).toEqual(['name.type']);
  });

  it('requires name to equal the folder name when given', () => {
    expect(validateFrontmatter(base, 'web-testing')).toEqual([]);
    expect(codes(validateFrontmatter(base, 'other-folder'), 'error')).toEqual([
      'name.folder-mismatch',
    ]);
  });
});

describe('validateFrontmatter: description', () => {
  it('accepts 1 and 1024 characters', () => {
    expect(validateFrontmatter({ ...base, description: 'x' })).toEqual([]);
    expect(validateFrontmatter({ ...base, description: 'x'.repeat(1024) })).toEqual([]);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(validateFrontmatter({ ...base, description: '\u{1F600}'.repeat(1024) })).toEqual([]);
  });

  it('requires description', () => {
    expect(codes(validateFrontmatter({ name: 'a' }))).toEqual(['description.missing']);
  });

  it.each([
    ['empty', '', 'description.length'],
    ['blank', '   ', 'description.length'],
    ['too long', 'x'.repeat(1025), 'description.length'],
    ['not a string', 7, 'description.type'],
  ])('rejects %s description', (_label, description, code) => {
    expect(codes(validateFrontmatter({ ...base, description }), 'error')).toEqual([code]);
  });
});

describe('validateFrontmatter: optional fields', () => {
  it('accepts a string license', () => {
    expect(validateFrontmatter({ ...base, license: 'Apache-2.0' })).toEqual([]);
  });

  it('rejects a non-string license', () => {
    expect(codes(validateFrontmatter({ ...base, license: 2 }), 'error')).toEqual(['license.type']);
    expect(codes(validateFrontmatter({ ...base, license: null }), 'error')).toEqual([
      'license.type',
    ]);
  });

  it('accepts compatibility of 1-500 characters', () => {
    expect(validateFrontmatter({ ...base, compatibility: 'Requires Node 22' })).toEqual([]);
    expect(validateFrontmatter({ ...base, compatibility: 'x'.repeat(500) })).toEqual([]);
  });

  it.each([
    ['empty', '', 'compatibility.length'],
    ['too long', 'x'.repeat(501), 'compatibility.length'],
    ['not a string', ['node'], 'compatibility.type'],
  ])('rejects %s compatibility', (_label, compatibility, code) => {
    expect(codes(validateFrontmatter({ ...base, compatibility }), 'error')).toEqual([code]);
  });

  it('accepts string metadata', () => {
    expect(validateFrontmatter({ ...base, metadata: { author: 'acme', version: '1.0' } })).toEqual(
      [],
    );
  });

  it('warns on non-string metadata values', () => {
    const issues = validateFrontmatter({ ...base, metadata: { version: 1, tags: ['a'] } });
    expect(issues.map((i) => [i.level, i.code, i.path])).toEqual([
      ['warning', 'metadata.value-type', 'metadata.version'],
      ['warning', 'metadata.value-type', 'metadata.tags'],
    ]);
  });

  it('rejects metadata that is not a map', () => {
    expect(codes(validateFrontmatter({ ...base, metadata: 'x' }), 'error')).toEqual([
      'metadata.type',
    ]);
    expect(codes(validateFrontmatter({ ...base, metadata: ['x'] }), 'error')).toEqual([
      'metadata.type',
    ]);
  });

  it('accepts allowed-tools as a string', () => {
    expect(validateFrontmatter({ ...base, 'allowed-tools': 'Bash(git:*) Read' })).toEqual([]);
  });

  it('warns when allowed-tools is a list', () => {
    const issues = validateFrontmatter({ ...base, 'allowed-tools': ['Bash', 'Read'] });
    expect(issues.map((i) => [i.level, i.code])).toEqual([['warning', 'allowed-tools.list']]);
  });

  it('rejects allowed-tools of another type', () => {
    expect(codes(validateFrontmatter({ ...base, 'allowed-tools': 3 }), 'error')).toEqual([
      'allowed-tools.type',
    ]);
  });

  it('warns on unknown top-level keys and keeps them', () => {
    const issues = validateFrontmatter({ ...base, 'argument-hint': '[file]', model: 'x' });
    expect(issues.map((i) => [i.level, i.code, i.path])).toEqual([
      ['warning', 'frontmatter.unknown-key', 'argument-hint'],
      ['warning', 'frontmatter.unknown-key', 'model'],
    ]);
  });
});

describe('parseSkillMd', () => {
  it('parses frontmatter and body', () => {
    const parsed = parseSkillMd(skillMd('name: a\ndescription: b\nx-vendor: 1', '# Body\n'));
    expect(parsed.frontmatter).toEqual({ name: 'a', description: 'b', 'x-vendor': 1 });
    expect(parsed.body).toBe('# Body\n');
    expect(codes(parsed.issues)).toEqual(['frontmatter.unknown-key']);
  });

  it('strips a BOM and accepts CRLF line endings', () => {
    const parsed = parseSkillMd(`﻿${toCrlf(skillMd('name: a\ndescription: b'))}`);
    expect(parsed.frontmatter.name).toBe('a');
    expect(parsed.issues).toEqual([]);
  });

  it('applies the folder name rule when given', () => {
    const text = skillMd('name: a\ndescription: b');
    expect(codes(parseSkillMd(text, { folderName: 'b' }).issues)).toEqual(['name.folder-mismatch']);
  });

  it('returns rule errors as issues instead of throwing', () => {
    const parsed = parseSkillMd(skillMd('name: Bad--Name\ndescription: ""'));
    expect(codes(parsed.issues, 'error')).toEqual(['name.format', 'description.length']);
  });

  it('warns when the body is over 500 lines', () => {
    const ok = parseSkillMd(skillMd('name: a\ndescription: b', 'line\n'.repeat(500)));
    expect(ok.issues).toEqual([]);
    const long = parseSkillMd(skillMd('name: a\ndescription: b', 'line\n'.repeat(501)));
    expect(codes(long.issues, 'warning')).toEqual(['body.too-long']);
  });

  it.each([
    ['no frontmatter', '# Title\n', 'frontmatter.missing'],
    ['frontmatter not at the start', '\n---\nname: a\n---\n', 'frontmatter.missing'],
    ['unterminated frontmatter', '---\nname: a\ndescription: b\n', 'frontmatter.unterminated'],
    ['invalid YAML', '---\nname: [a\n---\n', 'frontmatter.yaml'],
    ['duplicate keys', '---\nname: a\nname: b\ndescription: c\n---\n', 'frontmatter.yaml'],
    ['a list instead of a mapping', '---\n- a\n- b\n---\n', 'frontmatter.type'],
    ['an empty block', '---\n---\nbody\n', 'frontmatter.type'],
    ['a scalar', '---\njust text\n---\n', 'frontmatter.type'],
  ])('throws VALIDATION for %s', (_label, text, code) => {
    const error = catchError(() => parseSkillMd(text));
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual([code]);
  });

  it('refuses YAML alias bombs', () => {
    const bomb = [
      'name: a',
      'description: b',
      'l1: &a [x, x, x, x, x, x, x, x, x]',
      'l2: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]',
      'l3: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]',
      'l4: [*c, *c, *c, *c, *c, *c, *c, *c, *c]',
    ].join('\n');
    const error = catchError(() => parseSkillMd(skillMd(bomb)));
    expect(error.code).toBe('VALIDATION');
    expect(issueCodes(error)).toEqual(['frontmatter.yaml']);
  });

  it('does not pollute prototypes through __proto__ keys', () => {
    const parsed = parseSkillMd(skillMd('name: a\ndescription: b\n__proto__: { polluted: true }'));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(parsed.frontmatter)).toBe(Object.prototype);
    expect(codes(parsed.issues)).toEqual(['frontmatter.unknown-key']);
  });
});
