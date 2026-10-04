import { describe, expect, it } from 'vitest';
import { checkPackagePath, DEFAULT_LIMITS, findCaseCollisions, splitTarPath } from '../src/index';

describe('checkPackagePath', () => {
  it.each([
    'SKILL.md',
    'scripts/run.sh',
    'references/a/b.md',
    'assets/logo 1.png',
    '.github/config.yml',
    'docs/caf\u00e9.md',
    'a/b/c/d/e/f/g/h/i/j.md',
  ])('accepts %s', (path) => {
    expect(checkPackagePath(path)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['absolute POSIX', '/etc/passwd'],
    ['absolute backslash', '\\\\server\\share'],
    ['drive letter', 'C:/Windows/x'],
    ['drive letter without slash', 'c:x'],
    ['backslash', 'scripts\\run.sh'],
    ['dot-dot segment', '../evil'],
    ['nested dot-dot segment', 'a/../../evil'],
    ['dot segment', './SKILL.md'],
    ['inner dot segment', 'a/./b.md'],
    ['empty segment', 'a//b'],
    ['trailing slash', 'a/'],
    ['NUL', 'a\u0000b'],
    ['control char', 'a\u0007b'],
    ['newline', 'a\nb'],
    ['DEL', 'a\u007fb'],
    ['colon (alternate data stream)', 'file.txt:stream'],
    ['CON', 'CON'],
    ['con with extension', 'con.txt'],
    ['NUL with double extension', 'NUL.tar.gz'],
    ['reserved name in a directory', 'docs/aux/readme.md'],
    ['PRN', 'Prn.md'],
    ['COM1', 'com1.log'],
    ['COM9', 'COM9'],
    ['LPT1', 'lpt1.txt'],
    ['LPT9', 'scripts/LPT9.sh'],
    ['reserved with trailing space before extension', 'CON .txt'],
    ['trailing space', 'notes '],
    ['trailing dot', 'notes.'],
    ['directory with trailing dot', 'dir./a.md'],
    ['non-NFC', 'cafe\u0301.md'],
    ['.git segment', '.git/config'],
    ['.git segment nested', 'a/.git/hooks/pre-commit'],
    ['.GIT segment', '.GIT/config'],
    ['bidi override', 'invoice‮gpj.exe'],
    ['zero-width space', 'SKILL​.md'],
    ['unpaired surrogate', 'a\uD800.md'],
    ['Windows-invalid character', 'what?.md'],
    ['Windows-invalid character pipe', 'a|b.md'],
    ['__proto__ segment', '__proto__'],
  ])('rejects %s', (_label, path) => {
    expect(checkPackagePath(path)).toEqual(expect.any(String));
  });

  it('allows names that only contain a reserved word', () => {
    expect(checkPackagePath('console.md')).toBeNull();
    expect(checkPackagePath('com10.txt')).toBeNull();
    expect(checkPackagePath('nullable/x.md')).toBeNull();
  });

  it('enforces the path length limit', () => {
    const atLimit = `${'x'.repeat(99)}/${'y'.repeat(100)}`;
    expect(atLimit.length).toBe(DEFAULT_LIMITS.maxPathLength);
    expect(checkPackagePath(atLimit)).toBeNull();
    const long = `${'x'.repeat(100)}/${'y'.repeat(100)}`;
    expect(checkPackagePath(long)).toMatch(/longer than 200/);
    expect(checkPackagePath('abc/def.md', { ...DEFAULT_LIMITS, maxPathLength: 5 })).toMatch(
      /longer than 5/,
    );
  });

  it('enforces the depth limit', () => {
    expect(checkPackagePath('a/b/c/d/e/f/g/h/i/j/k.md')).toMatch(/deeper than 10/);
    expect(checkPackagePath('a/b/c.md', { ...DEFAULT_LIMITS, maxDepth: 2 })).toMatch(/deeper/);
  });

  it('rejects names too long for a ustar header', () => {
    expect(checkPackagePath('n'.repeat(101))).toMatch(/ustar/);
    expect(checkPackagePath(`dir/${'n'.repeat(100)}`)).toBeNull();
  });

  it('names the problem in the message', () => {
    expect(checkPackagePath('../evil')).toMatch(/"\.\."/);
    expect(checkPackagePath('/abs')).toMatch(/absolute/);
    expect(checkPackagePath('C:/x')).toMatch(/drive letter/);
    expect(checkPackagePath('CON.txt')).toMatch(/reserved/);
  });
});

describe('splitTarPath', () => {
  it('splits long paths at a slash into prefix and name', () => {
    const path = `${'p'.repeat(120)}/${'n'.repeat(60)}`;
    expect(splitTarPath(path)).toEqual({ prefix: 'p'.repeat(120), name: 'n'.repeat(60) });
    expect(splitTarPath('short.md')).toEqual({ prefix: '', name: 'short.md' });
  });

  it('returns null when no split fits', () => {
    expect(splitTarPath('n'.repeat(101))).toBeNull();
    expect(splitTarPath(`${'p'.repeat(156)}/n`)).toBeNull();
  });
});

describe('findCaseCollisions', () => {
  it('returns no collisions for distinct paths', () => {
    expect(findCaseCollisions(['SKILL.md', 'scripts/run.sh', 'references/a/b.md'])).toEqual([]);
  });

  it('finds files that differ only by case', () => {
    expect(findCaseCollisions(['A.md', 'a.md', 'b.md'])).toEqual(['A.md', 'a.md']);
  });

  it('finds directories that differ only by case', () => {
    expect(findCaseCollisions(['Docs/x.md', 'docs/y.md', 'z.md'])).toEqual([
      'Docs/x.md',
      'docs/y.md',
    ]);
  });

  it('folds non-ASCII case too', () => {
    expect(findCaseCollisions(['\u00c9t\u00e9.md', '\u00e9t\u00e9.md'])).toHaveLength(2);
  });
});
