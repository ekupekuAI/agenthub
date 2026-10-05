/**
 * Registry name protection. Pure functions: no database, no I/O.
 *
 * Skill names are flat ASCII slugs (SLUG_RE), so "homoglyphs" here are ASCII lookalikes:
 * digits that read as letters and letter pairs that read as one letter.
 *
 * A new name is held for review (never rejected) when it is a reserved name, or when it looks
 * like a name another publisher already owns. Holding instead of rejecting matters: a hard
 * reject would let whoever registers a lookalike first deny the legitimate name to its owner.
 */

/**
 * Names only an administrator can approve: the registry's own words, its routes, and the
 * names of vendors and agents people would expect to be official.
 */
export const RESERVED_NAMES: readonly string[] = [
  'agenthub',
  'admin',
  'api',
  'registry',
  'official',
  'anthropic',
  'openai',
  'claude',
  'claude-code',
  'codex',
  'cursor',
  'vscode',
  'copilot',
  'github',
  'microsoft',
  'npm',
  'security',
  'test',
  'example',
  'www',
  'help',
  'login',
  'signup',
  'publish',
  'dashboard',
];

/**
 * Tokens that add nothing to a name's identity when put in front of or after it:
 * `web-testing-cli`, `official-web-testing`, `web-testing-skill` all read as `web-testing`.
 */
export const AFFIX_TOKENS: ReadonlySet<string> = new Set([
  'cli',
  'clis',
  'skill',
  'skills',
  'tool',
  'tools',
  'js',
  'py',
  'official',
  'verified',
  'real',
  'original',
  'genuine',
  'secure',
  'safe',
  'the',
  'new',
  'latest',
]);

export const NAME_REVIEW_PREFIX = 'name-review:';
export const RESERVED_REASON = `${NAME_REVIEW_PREFIX} reserved name`;

export function lookalikeReason(other: string): string {
  return `${NAME_REVIEW_PREFIX} looks like ${other}`;
}

/** The outcome of checking a new name. `conflict` is the colliding existing name, if any. */
export type NameCheck =
  | { status: 'clear' }
  | { status: 'held'; kind: 'reserved'; reason: string }
  | { status: 'held'; kind: 'lookalike'; reason: string; conflict: string };

/** An existing name and who owns it. */
export interface OwnedName {
  slug: string;
  publisherId: string;
}

/** Derived forms shorter than this are too generic to compare by equality. */
const MIN_DERIVED_LENGTH = 3;

const SEPARATORS = /[-_.\s]+/;
const DIGITS: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
};

/** Words of a name, lowercased, split on '-', '_', '.' and whitespace. */
export function nameTokens(name: string): string[] {
  return name.toLowerCase().split(SEPARATORS).filter(Boolean);
}

/**
 * The visual skeleton of a name: lowercase, separators removed, lookalike characters folded.
 * `0→o 1→l i→l 3→e 4→a 5→s 7→t`, then `rn→m vv→w cl→d`. Two names with equal skeletons are
 * hard to tell apart when read quickly.
 */
export function skeleton(name: string): string {
  const flat = name
    .toLowerCase()
    .split(SEPARATORS)
    .join('')
    .replace(/[013457]/g, (d) => DIGITS[d] ?? d)
    .replace(/i/g, 'l');
  return flat.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
}

/** The tokens with leading and trailing affixes removed (at least one token is kept). */
export function coreTokens(tokens: readonly string[]): string[] {
  const out = [...tokens];
  while (out.length > 1 && AFFIX_TOKENS.has(out[out.length - 1] as string)) out.pop();
  while (out.length > 1 && AFFIX_TOKENS.has(out[0] as string)) out.shift();
  return out;
}

/** Singular candidates for a word: `skills→skill`, `boxes→box`, `queries→query`. */
function singulars(word: string): string[] {
  const out = [word];
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) out.push(word.slice(0, -1));
  if (word.length > 4 && word.endsWith('es')) out.push(word.slice(0, -2));
  if (word.length > 4 && word.endsWith('ies')) out.push(`${word.slice(0, -3)}y`);
  return out;
}

/** Token lists with the last word replaced by each of its singular candidates. */
function withSingulars(tokens: readonly string[]): string[][] {
  if (tokens.length === 0) return [];
  const head = tokens.slice(0, -1);
  return singulars(tokens[tokens.length - 1] as string).map((last) => [...head, last]);
}

/**
 * Every skeleton a name collapses to: the full name, the name without affixes, and the
 * singular form of each. Two names whose sets meet are lookalikes.
 */
export function nameForms(name: string): Set<string> {
  const tokens = nameTokens(name);
  const full = skeleton(tokens.join(''));
  const forms = new Set<string>([full]);
  const variants = [...withSingulars(tokens), ...withSingulars(coreTokens(tokens))];
  for (const variant of variants) {
    const form = skeleton(variant.join(''));
    if (form.length >= MIN_DERIVED_LENGTH) forms.add(form);
  }
  return forms;
}

/** Skeleton of the name's core words in sorted order (catches `testing-web` for `web-testing`). */
export function sortedForm(name: string): string | null {
  const core = coreTokens(nameTokens(name));
  if (core.length < 2) return null;
  return core
    .map((t) => skeleton(t))
    .sort()
    .join('');
}

/**
 * Damerau-Levenshtein distance, optimal string alignment variant: insertions, deletions,
 * substitutions and transpositions of two adjacent characters each cost 1. Returns early
 * with `max + 1` once the distance is known to exceed `max`.
 */
export function damerauLevenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (prevPrev[j - 2] as number) + 1);
      }
      row.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length] as number;
}

/**
 * Edits allowed between two skeletons before they count as lookalikes, by the length of the
 * shorter one: none below 5 characters, 1 from 5, 2 from 10.
 */
export function distanceLimit(length: number): number {
  if (length >= 10) return 2;
  if (length >= 5) return 1;
  return 0;
}

/** Full and affix-free skeletons: the forms compared by edit distance. */
function distanceForms(name: string): string[] {
  const tokens = nameTokens(name);
  const forms = new Set([skeleton(tokens.join('')), skeleton(coreTokens(tokens).join(''))]);
  return [...forms].filter((f) => f.length > 0);
}

/** True when two names are confusable: equal forms, reordered words, or a small edit distance. */
export function looksAlike(a: string, b: string): boolean {
  const formsA = nameForms(a);
  for (const form of nameForms(b)) if (formsA.has(form)) return true;
  const sortedA = sortedForm(a);
  if (sortedA !== null && sortedA === sortedForm(b)) return true;
  for (const x of distanceForms(a)) {
    for (const y of distanceForms(b)) {
      const limit = distanceLimit(Math.min(x.length, y.length));
      if (limit > 0 && damerauLevenshtein(x, y, limit) <= limit) return true;
    }
  }
  return false;
}

/**
 * True when a name is, or reads as, a reserved name. Short reserved words (`api`, `test`,
 * `help`) match only as the whole name or its plural, so `api-docs-writer` and `api-skill`
 * stay free; longer ones also match with affixes (`claude-code-cli`) and, from 8 characters,
 * with one edit (`agenthib`).
 */
export function isReservedName(name: string): boolean {
  const tokens = nameTokens(name);
  const full = skeleton(tokens.join(''));
  const plain = new Set(withSingulars(tokens).map((t) => skeleton(t.join(''))));
  plain.add(full);
  const forms = nameForms(name);
  for (const reserved of RESERVED_NAMES) {
    const r = skeleton(reserved);
    if (plain.has(r)) return true;
    if (r.length >= 5 && forms.has(r)) return true;
    if (r.length >= 8) {
      for (const form of distanceForms(name)) {
        if (damerauLevenshtein(form, r, 1) <= 1) return true;
      }
    }
  }
  return false;
}

/**
 * Check a name that has never been published. `existing` lists names already in the
 * registry; names owned by `publisherId` itself are ignored, so a publisher can grow its own
 * family of names (`web-testing`, `web-testing-cli`) freely.
 */
export function checkNewName(
  name: string,
  publisherId: string,
  existing: Iterable<OwnedName>,
): NameCheck {
  if (isReservedName(name)) return { status: 'held', kind: 'reserved', reason: RESERVED_REASON };
  let best: string | null = null;
  for (const other of existing) {
    if (other.publisherId === publisherId || other.slug === name) continue;
    if (looksAlike(name, other.slug)) {
      // Deterministic choice when several names collide: the shortest, then alphabetical.
      if (
        best === null ||
        other.slug.length < best.length ||
        (other.slug.length === best.length && other.slug < best)
      ) {
        best = other.slug;
      }
    }
  }
  if (best !== null) {
    return { status: 'held', kind: 'lookalike', reason: lookalikeReason(best), conflict: best };
  }
  return { status: 'clear' };
}
