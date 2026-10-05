/**
 * Outbound references (trust features design §5): URLs, git repositories, registry packages
 * and MCP servers a skill points at, fetches, installs or runs, with how firmly each one is
 * pinned. Pure and offline: nothing is fetched or resolved.
 *
 * Bounded and ReDoS-safe: URL candidates are found with indexOf('://') and widened by
 * character loops capped at 2,048 characters; command words come from a linear split; the few
 * regular expressions run only on bounded tokens and have no nested quantifiers. A file with
 * more candidates than MAX_OCCURRENCES, or a package with more than MAX_EXTERNALS distinct
 * references, is reported as `code.obfuscated` (externals-overflow): an incomplete inventory
 * must not be approvable.
 */
import {
  capToken,
  type ExternalKind,
  type ExternalRef,
  type ExternalRole,
  type Finding,
  normalizeExternals,
} from '@agenthub/core';
import { programName } from './lang/common';
import { fencedBlocks, looksLikeCommands } from './lang/markdown';
import { makeEvidence } from './text';

/** Bump whenever extraction changes what it reports (part of the ruleset digest). */
export const EXTRACTOR_VERSION = '1';
/** Most distinct externals per package before the inventory counts as incomplete. */
export const MAX_EXTERNALS = 256;
/** Most URL or command occurrences examined per file. */
export const MAX_OCCURRENCES = 4096;

const MAX_TOKEN = 2048;
const MAX_ID = 512;
const MAX_PIN = 128;
/** Lines longer than this are scanned for URLs and commands, but not for pin evidence. */
const MAX_PIN_LINE = 16 * 1024;
const SENTENCE_WINDOW = 400;

export type ExternalsLanguage = 'js' | 'py' | 'sh' | 'ps' | 'bat' | 'markdown' | 'text';

/** One reference found in one file, before package-level merging. */
export interface ExternalOccurrence {
  ref: ExternalRef;
  file: string;
  line: number;
  /** Raw line text, for evidence. */
  text: string;
  focus: number;
}

export interface FileExternals {
  occurrences: ExternalOccurrence[];
  /** True when the file had more candidates than could be examined. */
  overflow: boolean;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ROLE_RANK: Record<ExternalRole, number> = {
  reference: 0,
  fetch: 1,
  install: 2,
  run: 3,
  instructions: 3,
};

const HEX40 = /^[0-9a-f]{40}$/i;
const EXACT_VERSION =
  /^v?\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,100}\/)?[a-z0-9][a-z0-9._~-]{0,100}$/;
const PYPI_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/i;
const CRATE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function isTemplated(text: string): boolean {
  return text.includes('$') || text.includes('{{') || /%[A-Za-z_]\w*%/.test(text.slice(0, 512));
}

/** Replaces `$VAR`, `${…}`, `$(…)`, `{{…}}` and `%VAR%` with '*'. Linear, no regex. */
function untemplate(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '$') {
      const next = text[i + 1];
      if (next === '{' || next === '(') {
        const close = text.indexOf(next === '{' ? '}' : ')', i + 2);
        i = close < 0 ? text.length : close + 1;
      } else {
        i++;
        while (i < text.length && /\w/.test(text[i] as string)) i++;
      }
      out += '*';
      continue;
    }
    if (c === '{' && text[i + 1] === '{') {
      const close = text.indexOf('}}', i + 2);
      i = close < 0 ? text.length : close + 2;
      out += '*';
      continue;
    }
    if (c === '%') {
      let j = i + 1;
      while (j < text.length && j - i < 64 && /\w/.test(text[j] as string)) j++;
      if (j > i + 1 && text[j] === '%') {
        out += '*';
        i = j + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function pinValueOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return capToken(value, MAX_PIN);
}

function make(
  kind: ExternalKind,
  id: string,
  role: ExternalRole,
  pin: ExternalRef['pin'],
  pinValue: string | null,
  host?: string,
): ExternalRef {
  const ref: ExternalRef = {
    kind,
    id: capToken(id, MAX_ID),
    pin,
    pinValue: pinValueOf(pinValue),
    role,
  };
  if (host !== undefined) ref.host = capToken(host, 255);
  return ref;
}

function stripQuotes(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && `"'\`(`.includes(word[start] as string)) start++;
  while (end > start && `"'\`),;`.includes(word[end - 1] as string)) end--;
  return word.slice(start, end);
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

interface UrlToken {
  start: number;
  end: number;
  raw: string;
  /** Lower-cased scheme without a 'git+' prefix. */
  scheme: string;
  /** Written as git+<scheme>:// */
  gitPlus: boolean;
}

const URL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'ftps', 'ssh', 'git']);

function isSchemeChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2b ||
    code === 0x2e ||
    code === 0x2d
  );
}

/** Characters that end a URL candidate: whitespace, quotes, brackets, pipes, `;`, `\`. */
function isUrlStop(code: number): boolean {
  if (code <= 0x20 || code === 0x7f) return true;
  switch (code) {
    case 0x22: // "
    case 0x27: // '
    case 0x60: // `
    case 0x3c: // <
    case 0x3e: // >
    case 0x7c: // |
    case 0x5c: // \
    case 0x5e: // ^
    case 0x28: // (
    case 0x29: // )
    case 0x5b: // [
    case 0x5d: // ]
    case 0x3b: // ;
      return true;
    default:
      return false;
  }
}

const TRAILING = '.,:!?*_~';

/** Every URL candidate in `text`, linear in its length. */
function findUrls(text: string, budget: { left: number }): UrlToken[] {
  const out: UrlToken[] = [];
  let from = 0;
  for (;;) {
    const idx = text.indexOf('://', from);
    if (idx < 0) return out;
    if (budget.left <= 0) return out;
    let s = idx;
    while (s > 0 && idx - s < 16 && isSchemeChar(text.charCodeAt(s - 1))) s--;
    let e = idx + 3;
    while (e < text.length && e - s < MAX_TOKEN && !isUrlStop(text.charCodeAt(e))) e++;
    from = Math.max(e, idx + 3);
    // Trim sentence punctuation, and a template's unmatched closing brace.
    while (e > idx + 3 && TRAILING.includes(text[e - 1] as string)) e--;
    let scheme = text.slice(s, idx).toLowerCase();
    let gitPlus = false;
    if (scheme.startsWith('git+')) {
      gitPlus = true;
      scheme = scheme.slice(4);
    }
    // A scheme glued to a word ("seehttps://") is cut at the last known scheme.
    for (const known of URL_SCHEMES) {
      if (scheme.endsWith(known) && scheme !== known && !gitPlus) {
        s = idx - known.length;
        scheme = known;
        break;
      }
    }
    if (!URL_SCHEMES.has(scheme) || e <= idx + 3) continue;
    // XML namespaces are identifiers, not references.
    const before = text.slice(Math.max(0, s - 12), s);
    if (/xmlns(?::\w+)?=["']?$/.test(before)) continue;
    budget.left--;
    out.push({ start: s, end: e, raw: text.slice(s, e), scheme, gitPlus });
  }
}

interface ParsedUrl {
  /** Normalized URL without query or fragment: the id of a full reference. */
  id: string;
  /** Origin, or https://host/owner/repo on a code host: the id of a plain reference. */
  origin: string;
  host: string;
  templated: boolean;
  /** Path segments (decoded form as given). */
  segments: string[];
  lowerPath: string;
}

const CODE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

function parseUrl(raw: string): ParsedUrl | null {
  const schemeEnd = raw.indexOf('://');
  const scheme = raw
    .slice(0, schemeEnd)
    .toLowerCase()
    .replace(/^git\+/, '');
  if (isTemplated(raw)) {
    const body = untemplate(raw.slice(schemeEnd + 3)).replace(/[?#].*$/, '');
    const slash = body.indexOf('/');
    const authority = slash < 0 ? body : body.slice(0, slash);
    const hostPart = authority.slice(authority.lastIndexOf('@') + 1).toLowerCase();
    const host = hostPart.includes('*') ? '*' : hostPart.replace(/:\d+$/, '').replace(/\.$/, '');
    if (host === '') return null;
    const path = slash < 0 ? '' : body.slice(slash).replace(/\/+$/, '');
    const id = `${scheme}://${host === '*' ? hostPart : host}${path}`;
    return {
      id,
      origin: `${scheme}://${host === '*' ? hostPart : host}`,
      host,
      templated: true,
      segments: path.split('/').filter(Boolean),
      lowerPath: path.toLowerCase(),
    };
  }
  let url: URL;
  try {
    url = new URL(`${scheme}${raw.slice(schemeEnd)}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/\.$/, '');
  if (host === '') return null;
  const port = url.port === '' ? '' : `:${url.port}`;
  const path = url.pathname.replace(/\/+$/, '');
  const segments = path.split('/').filter(Boolean);
  const base = `${url.protocol}//${host}${port}`;
  const origin =
    CODE_HOSTS.has(host) && segments.length >= 2
      ? `${base}/${segments[0]}/${(segments[1] as string).replace(/\.git$/, '')}`
      : base;
  return {
    id: `${base}${path}`,
    origin,
    host,
    templated: false,
    segments,
    lowerPath: path.toLowerCase(),
  };
}

/** Pin from a GitHub URL: a 40-hex commit in raw/blob/tree positions, else the mutable ref. */
function githubPin(parsed: ParsedUrl): { pin: ExternalRef['pin']; value: string | null } {
  const seg = parsed.segments;
  let ref: string | undefined;
  if (parsed.host === 'raw.githubusercontent.com') ref = seg[2];
  else if (parsed.host === 'github.com' && ['blob', 'raw', 'tree'].includes(seg[2] ?? '')) {
    ref = seg[3];
  }
  if (ref === undefined) return { pin: 'unpinned', value: null };
  return HEX40.test(ref)
    ? { pin: 'commit', value: ref.toLowerCase() }
    : { pin: 'unpinned', value: ref };
}

/** A 64-hex checksum on this line or the next non-empty one, with a checking command. */
function sha256Pin(lines: readonly string[], index: number): string | null {
  const candidates: string[] = [];
  for (let j = index; j < lines.length && candidates.length < 2; j++) {
    const text = lines[j] as string;
    if (j > index && text.trim() === '') continue;
    candidates.push(text);
  }
  for (const text of candidates) {
    if (text.length > MAX_PIN_LINE) continue;
    if (!/sha256sum\b|shasum\s+-a\s*256\b|Get-FileHash\b|sha256\s*\(/i.test(text)) continue;
    const hex = /(?:^|[^0-9a-f])([0-9a-f]{64})(?![0-9a-f])/i.exec(text);
    if (hex !== null) return (hex[1] as string).toLowerCase();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Git references
// ---------------------------------------------------------------------------

function gitRef(raw: string, role: ExternalRole, explicitRef?: string): ExternalRef | null {
  let spec = raw.trim();
  let ref: string | undefined = explicitRef;
  let host: string;
  let path: string;
  if (spec.startsWith('github:') || spec.startsWith('gitlab:') || spec.startsWith('bitbucket:')) {
    const colon = spec.indexOf(':');
    const provider = spec.slice(0, colon);
    host =
      provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org';
    spec = spec.slice(colon + 1);
    const hash = spec.indexOf('#');
    if (hash >= 0) {
      ref = ref ?? spec.slice(hash + 1);
      spec = spec.slice(0, hash);
    }
    path = spec;
  } else if (/^[\w.-]+@[\w.-]+:/.test(spec.slice(0, 256))) {
    // scp-like: git@host:owner/repo.git
    const at = spec.indexOf('@');
    const colon = spec.indexOf(':', at);
    host = spec.slice(at + 1, colon).toLowerCase();
    path = spec.slice(colon + 1);
    const hash = path.indexOf('#');
    if (hash >= 0) {
      ref = ref ?? path.slice(hash + 1);
      path = path.slice(0, hash);
    }
  } else {
    spec = spec.replace(/^git\+/, '');
    const hash = spec.indexOf('#');
    if (hash >= 0) {
      ref = ref ?? spec.slice(hash + 1);
      spec = spec.slice(0, hash);
    }
    const schemeEnd = spec.indexOf('://');
    if (schemeEnd < 0) return null;
    const afterScheme = spec.slice(schemeEnd + 3);
    const slash = afterScheme.indexOf('/');
    if (slash < 0) return null;
    const authority = afterScheme.slice(0, slash);
    host = authority
      .slice(authority.lastIndexOf('@') + 1)
      .replace(/:\d+$/, '')
      .toLowerCase();
    path = afterScheme.slice(slash + 1);
    const at = path.lastIndexOf('@');
    if (at > 0 && ref === undefined) {
      ref = path.slice(at + 1);
      path = path.slice(0, at);
    }
  }
  path = path
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .replace(/^\/+/, '');
  if (host === '' || path === '') return null;
  const templated = isTemplated(host) || isTemplated(path);
  const hostOut = isTemplated(host) ? '*' : host;
  const id = templated ? untemplate(`${host}/${path}`) : `${host}/${path}`;
  if (ref !== undefined && HEX40.test(ref) && !templated) {
    return make('git', id, role, 'commit', ref.toLowerCase(), hostOut);
  }
  return make('git', id, role, 'unpinned', ref ?? null, hostOut);
}

// ---------------------------------------------------------------------------
// Registry packages
// ---------------------------------------------------------------------------

function npmRef(rawSpec: string, role: ExternalRole): ExternalRef | null {
  const spec = stripQuotes(rawSpec);
  if (spec === '' || spec.length > MAX_TOKEN) return null;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~')) return null;
  if (/^(?:file|link|workspace|portal|patch):/.test(spec)) return null;
  if (
    /^(?:github|gitlab|bitbucket):/.test(spec) ||
    spec.startsWith('git+') ||
    spec.includes('://')
  ) {
    return gitRef(spec, role);
  }
  if (isTemplated(spec)) return make('npm', '*', role, 'unpinned', null);
  if (!spec.startsWith('@') && /^[\w.-]{1,100}\/[\w.-]{1,100}(?:#.{0,128})?$/.test(spec)) {
    return gitRef(`github:${spec}`, role);
  }
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  const name = (at > 0 ? spec.slice(0, at) : spec).toLowerCase();
  const version = at > 0 ? spec.slice(at + 1) : null;
  if (!NPM_NAME.test(name)) return null;
  if (version !== null && version.length <= MAX_PIN && EXACT_VERSION.test(version)) {
    return make('npm', name, role, 'version', version.replace(/^v/, ''));
  }
  return make('npm', name, role, 'unpinned', version);
}

function pypiName(name: string): string {
  let out = '';
  let dash = false;
  for (const c of name.toLowerCase()) {
    if (c === '-' || c === '_' || c === '.') {
      if (!dash) out += '-';
      dash = true;
    } else {
      out += c;
      dash = false;
    }
  }
  return out;
}

function pypiRef(rawSpec: string, role: ExternalRole, hash: string | null): ExternalRef | null {
  let spec = stripQuotes(rawSpec);
  const marker = spec.indexOf(';');
  if (marker >= 0) spec = spec.slice(0, marker);
  spec = spec.trim();
  if (spec === '' || spec.length > MAX_TOKEN) return null;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~')) return null;
  if (spec.startsWith('git+') || /^(?:git|hg|svn|bzr)\+/.test(spec)) return gitRef(spec, role);
  if (spec.includes('://')) {
    const parsed = parseUrl(spec);
    return parsed === null
      ? null
      : make('url', parsed.id, role, hash ? 'sha256' : 'unpinned', hash, parsed.host);
  }
  if (isTemplated(spec)) return make('pypi', '*', role, 'unpinned', null);
  // name[extras] (constraint) or name@version (uv)
  let end = 0;
  while (end < spec.length && end < 128 && /[A-Za-z0-9._-]/.test(spec[end] as string)) end++;
  const name = spec.slice(0, end);
  if (!PYPI_NAME.test(name)) return null;
  let rest = spec.slice(end);
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    rest = close < 0 ? '' : rest.slice(close + 1);
  }
  rest = rest.trim();
  if (rest.startsWith('@')) rest = `==${rest.slice(1).trim()}`;
  const normalized = pypiName(name);
  if (hash !== null) return make('pypi', normalized, role, 'sha256', hash);
  const exact = /^===?\s*(\d[0-9A-Za-z.+!-]{0,63})$/.exec(rest.slice(0, 80));
  if (exact !== null && !rest.includes('*')) {
    return make('pypi', normalized, role, 'version', exact[1] as string);
  }
  return make('pypi', normalized, role, 'unpinned', rest === '' ? null : rest);
}

function crateRef(spec: string, role: ExternalRole, version: string | null): ExternalRef | null {
  const cleaned = stripQuotes(spec);
  const at = cleaned.indexOf('@');
  const name = (at > 0 ? cleaned.slice(0, at) : cleaned).toLowerCase();
  const pinned = version ?? (at > 0 ? cleaned.slice(at + 1) : null);
  if (isTemplated(name)) return make('crates', '*', role, 'unpinned', null);
  if (!CRATE_NAME.test(name)) return null;
  if (pinned !== null && pinned.length <= MAX_PIN && EXACT_VERSION.test(pinned.replace(/^=/, ''))) {
    return make('crates', name, role, 'version', pinned.replace(/^=/, ''));
  }
  return make('crates', name, role, 'unpinned', pinned);
}

// ---------------------------------------------------------------------------
// Command lines
// ---------------------------------------------------------------------------

/** Flags whose next word is a value (not a package) for each tool family. */
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  npm: new Set([
    '-c',
    '--call',
    '--registry',
    '--prefix',
    '-w',
    '--workspace',
    '--cache',
    '--userconfig',
    '--tag',
  ]),
  pip: new Set([
    '-r',
    '--requirement',
    '-c',
    '--constraint',
    '-i',
    '--index-url',
    '--extra-index-url',
    '-f',
    '--find-links',
    '-t',
    '--target',
    '--prefix',
    '--root',
    '--python-version',
    '--platform',
    '--trusted-host',
    '--src',
    '--python',
    '-p',
    '--with',
    '--from',
    '--spec',
    '--index',
    '--default-index',
  ]),
  cargo: new Set([
    '--version',
    '--vers',
    '--git',
    '--branch',
    '--tag',
    '--rev',
    '--root',
    '--registry',
    '--index',
    '--path',
    '--bin',
    '--features',
    '-F',
    '--target',
    '-j',
    '--jobs',
    '--profile',
  ]),
};

interface CommandHit {
  ref: ExternalRef;
  word: string;
}

/** Externals named by the commands in one code line. */
function commandExternals(text: string, hash: string | null): CommandHit[] {
  const out: CommandHit[] = [];
  const segments = text.split(/&&|\|\||[;&|\n`]|\$\(/);
  for (const segment of segments) {
    const words = segment.split(/[\s"'(){},]+/).filter((w) => w !== '');
    if (words.length === 0 || words.length > 4096) continue;
    for (let i = 0; i < words.length; i++) {
      const name = programName(words[i] as string);
      const next = (words[i + 1] ?? '').toLowerCase();
      const third = (words[i + 2] ?? '').toLowerCase();
      if (name === 'npx' || name === 'bunx' || name === 'pnpx') {
        out.push(...runnerArgs(words, i + 1, 'npm'));
      } else if ((name === 'pnpm' || name === 'yarn' || name === 'bun') && next === 'dlx') {
        out.push(...runnerArgs(words, i + 2, 'npm'));
      } else if (name === 'bun' && next === 'x') {
        out.push(...runnerArgs(words, i + 2, 'npm'));
      } else if (name === 'npm' && (next === 'exec' || next === 'x')) {
        out.push(...runnerArgs(words, i + 2, 'npm'));
      } else if (
        (name === 'npm' && ['i', 'install', 'add', 'isntall', 'in'].includes(next)) ||
        ((name === 'pnpm' || name === 'yarn' || name === 'bun') &&
          ['add', 'install', 'i'].includes(next))
      ) {
        out.push(...installArgs(words, i + 2, 'npm', hash));
      } else if (name === 'uvx') {
        out.push(...runnerArgs(words, i + 1, 'pypi'));
      } else if (name === 'pipx' && next === 'run') {
        out.push(...runnerArgs(words, i + 2, 'pypi'));
      } else if (name === 'pipx' && next === 'install') {
        out.push(...installArgs(words, i + 2, 'pypi', hash));
      } else if (name === 'uv' && next === 'tool' && third === 'run') {
        out.push(...runnerArgs(words, i + 3, 'pypi'));
      } else if (name === 'uv' && next === 'tool' && third === 'install') {
        out.push(...installArgs(words, i + 3, 'pypi', hash));
      } else if (name === 'uv' && next === 'pip' && third === 'install') {
        out.push(...installArgs(words, i + 3, 'pypi', hash));
      } else if (name === 'uv' && next === 'add') {
        out.push(...installArgs(words, i + 2, 'pypi', hash));
      } else if (name === 'pip' && next === 'install') {
        out.push(...installArgs(words, i + 2, 'pypi', hash));
      } else if (
        name === 'python' &&
        next === '-m' &&
        third === 'pip' &&
        (words[i + 3] ?? '') === 'install'
      ) {
        out.push(...installArgs(words, i + 4, 'pypi', hash));
      } else if (name === 'cargo' && next === 'install') {
        out.push(...installArgs(words, i + 2, 'crates', hash));
      } else if (name === 'git' && next === 'clone') {
        out.push(...cloneArgs(words, i + 2, text));
      }
    }
  }
  return out;
}

type Family = 'npm' | 'pypi' | 'crates';

function flagFamily(family: Family): ReadonlySet<string> {
  return family === 'npm'
    ? (VALUE_FLAGS.npm as ReadonlySet<string>)
    : family === 'pypi'
      ? (VALUE_FLAGS.pip as ReadonlySet<string>)
      : (VALUE_FLAGS.cargo as ReadonlySet<string>);
}

function refFor(
  family: Family,
  spec: string,
  role: ExternalRole,
  hash: string | null,
  version: string | null,
): ExternalRef | null {
  if (family === 'npm') return npmRef(spec, role);
  if (family === 'pypi') return pypiRef(spec, role, hash);
  return crateRef(spec, role, version);
}

/** npx-like: the package is the first non-flag word (or a --package / --from value). */
function runnerArgs(words: readonly string[], from: number, family: Family): CommandHit[] {
  const values = flagFamily(family);
  const out: CommandHit[] = [];
  for (let j = from; j < words.length && j < from + 64; j++) {
    const word = words[j] as string;
    if (word === '--') continue;
    const eq = word.indexOf('=');
    const flag = eq > 0 ? word.slice(0, eq) : word;
    if (['-p', '--package', '--from', '--spec', '--with'].includes(flag) && family !== 'crates') {
      // uvx --from / --with, npx -p, pipx --spec: the named package is fetched and run.
      if (family === 'npm' && flag === '-p' && eq < 0 && words[j + 1] !== undefined) {
        const ref = refFor(family, words[j + 1] as string, 'run', null, null);
        if (ref) out.push({ ref, word: words[j + 1] as string });
        j++;
        continue;
      }
      const value = eq > 0 ? word.slice(eq + 1) : (words[j + 1] ?? '');
      if (family === 'pypi' && flag === '-p') {
        if (eq < 0) j++;
        continue;
      }
      const ref = refFor(family, value, flag === '--with' ? 'install' : 'run', null, null);
      if (ref) out.push({ ref, word: value });
      if (eq < 0) j++;
      continue;
    }
    if (word.startsWith('-')) {
      if (values.has(flag) && eq < 0) j++;
      continue;
    }
    const ref = refFor(family, word, 'run', null, null);
    if (ref) out.push({ ref, word });
    return out;
  }
  return out;
}

/** install-like: every non-flag word is a package spec. */
function installArgs(
  words: readonly string[],
  from: number,
  family: Family,
  hash: string | null,
): CommandHit[] {
  const values = flagFamily(family);
  const out: CommandHit[] = [];
  let version: string | null = null;
  if (family === 'crates') {
    for (let j = from; j < words.length && j < from + 64; j++) {
      const word = words[j] as string;
      if ((word === '--version' || word === '--vers') && words[j + 1] !== undefined)
        version = words[j + 1] as string;
      else if (word.startsWith('--version=')) version = word.slice('--version='.length);
      if (word === '--git' && words[j + 1] !== undefined) {
        const ref = gitRef(words[j + 1] as string, 'install', revOf(words, from));
        if (ref) out.push({ ref, word: words[j + 1] as string });
      }
    }
  }
  for (let j = from; j < words.length && j < from + 256; j++) {
    const word = words[j] as string;
    if (word === '--') continue;
    if (word.startsWith('#')) break;
    const eq = word.indexOf('=');
    const flag = eq > 0 ? word.slice(0, eq) : word;
    if (word.startsWith('-')) {
      if ((flag === '-e' || flag === '--editable') && family === 'pypi') {
        const value = eq > 0 ? word.slice(eq + 1) : (words[j + 1] ?? '');
        const ref = pypiRef(value, 'install', hash);
        if (ref) out.push({ ref, word: value });
        if (eq < 0) j++;
        continue;
      }
      if (values.has(flag) && eq < 0) j++;
      continue;
    }
    const ref = refFor(family, word, 'install', hash, version);
    if (ref) out.push({ ref, word });
  }
  return out;
}

function revOf(words: readonly string[], from: number): string | undefined {
  for (let j = from; j < words.length - 1; j++) {
    if (['--rev', '--tag', '--branch'].includes(words[j] as string)) return words[j + 1];
  }
  return undefined;
}

/** git clone [-b ref] <repo>: the repository, pinned by a full commit checked out on the line. */
function cloneArgs(words: readonly string[], from: number, line: string): CommandHit[] {
  let branch: string | undefined;
  for (let j = from; j < words.length && j < from + 32; j++) {
    const word = words[j] as string;
    if ((word === '-b' || word === '--branch') && words[j + 1] !== undefined) {
      branch = words[j + 1];
      j++;
      continue;
    }
    if (word.startsWith('-')) {
      if (
        [
          '--depth',
          '-o',
          '--origin',
          '--reference',
          '-c',
          '--config',
          '--filter',
          '-j',
          '--jobs',
        ].includes(word)
      )
        j++;
      continue;
    }
    let ref = branch;
    if (line.length <= MAX_PIN_LINE) {
      const checkout =
        /\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|reset\s+--hard|switch\s+--detach)\s+([0-9a-f]{40})\b/i.exec(
          line,
        );
      if (checkout !== null) ref = checkout[1];
    }
    const hit = gitRef(word, 'install', ref);
    return hit === null ? [] : [{ ref: hit, word }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

const FETCH_WORDS = [
  'curl',
  'wget',
  'aria2c',
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
  'start-bitstransfer',
  'downloadstring',
  'downloadfile',
  'downloaddata',
  'webclient',
  'fetch(',
  'requests.',
  'urllib',
  'urlopen',
  'http.get',
  'https.get',
  'http.request',
  'https.request',
  'axios',
  'httpx',
  'aiohttp',
  'got(',
  'xmlhttprequest',
  'websocket(',
  'new websocket',
  'git ls-remote',
  'git fetch',
  'git pull',
];

const RUN_PIPE =
  /\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\|\s*(?:sudo\s+)?(?:python[\d.]*|node|perl|ruby|pwsh|powershell|iex|invoke-expression)\b|\b(?:iex|invoke-expression)\s*[(\s]|\b(?:ba)?sh\s+-c\s+["']?\$\(|\b(?:ba)?sh\s+<\(|\bsource\s+<\(/i;

function lineRole(lower: string, text: string): ExternalRole {
  if (lower.includes('mcp add') || lower.includes('mcp-remote')) return 'run';
  const fetches = FETCH_WORDS.some((word) => lower.includes(word));
  if (!fetches) return 'reference';
  if (text.length <= MAX_PIN_LINE && RUN_PIPE.test(text)) return 'run';
  return 'fetch';
}

/** Index-URL flags: the URL after them is a package index. */
function isIndexFlag(before: string): boolean {
  return /(?:--index-url|--extra-index-url|--find-links|--registry|--index|-i|-f)[=\s]+$/.test(
    before.slice(-24),
  );
}

/** Externals in one line of code (a script, or a shell block in Markdown). */
function codeLine(
  lines: readonly string[],
  index: number,
  file: string,
  budget: { left: number },
  out: ExternalOccurrence[],
  textOverride?: string,
): void {
  const text = textOverride ?? (lines[index] as string);
  if (text.trim() === '') return;
  const lower =
    text.length <= MAX_TOKEN * 64
      ? text.toLowerCase()
      : text.slice(0, MAX_TOKEN * 64).toLowerCase();
  const role = lineRole(lower, text);
  const hashFlag =
    text.length <= MAX_PIN_LINE ? /--hash[=\s]+sha256:([0-9a-f]{64})\b/i.exec(text) : null;
  const pipHash = hashFlag === null ? null : (hashFlag[1] as string).toLowerCase();
  const line = index + 1;
  const push = (ref: ExternalRef, focus: number) => {
    out.push({ ref, file, line, text, focus });
  };

  // Commands first: a git clone URL or a pip spec URL is not also a plain URL.
  const consumed = new Set<string>();
  if (budget.left > 0) {
    for (const hit of commandExternals(text, pipHash)) {
      budget.left--;
      consumed.add(stripQuotes(hit.word));
      push(hit.ref, Math.max(0, text.indexOf(hit.word)));
    }
  }
  const words = [...consumed];
  for (const url of findUrls(text, budget)) {
    if (words.length > 0 && words.some((word) => word.includes(url.raw))) continue;
    if (url.gitPlus || url.scheme === 'ssh' || url.scheme === 'git') {
      const ref = gitRef(url.raw, role === 'reference' ? 'install' : role);
      if (ref) push(ref, url.start);
      continue;
    }
    const parsed = parseUrl(url.raw);
    if (parsed === null) continue;
    if (isIndexFlag(text.slice(Math.max(0, url.start - 24), url.start))) {
      push(make('url', parsed.id, 'install', 'unpinned', null, parsed.host), url.start);
      continue;
    }
    const mcp = lower.includes('mcp add') || lower.includes('mcp-remote');
    if (role === 'reference' && !mcp) {
      push(make('url', parsed.origin, 'reference', 'unpinned', null, parsed.host), url.start);
      continue;
    }
    const github = githubPin(parsed);
    const sha = role === 'reference' ? null : sha256Pin(lines, index);
    const pin = sha !== null ? 'sha256' : github.pin;
    const value = sha ?? github.value;
    push(
      make(
        mcp ? 'mcp' : 'url',
        parsed.id,
        mcp ? 'run' : role,
        parsed.templated ? 'unpinned' : pin,
        parsed.templated ? null : value,
        parsed.host,
      ),
      url.start,
    );
  }
}

// ---------------------------------------------------------------------------
// Prose (remote instructions, design §5.4)
// ---------------------------------------------------------------------------

const VERBS = new Set([
  'follow',
  'follows',
  'followed',
  'following',
  'obey',
  'obeys',
  'execute',
  'executes',
  'apply',
  'applies',
  'perform',
  'performs',
  'run',
  'runs',
  'load',
  'loads',
  'fetch',
  'fetches',
  'download',
  'downloads',
  'retrieve',
  'retrieves',
  'read',
  'reads',
  'open',
  'opens',
  'visit',
  'visits',
  'consult',
  'consults',
  'use',
  'uses',
  'import',
  'imports',
  'include',
  'includes',
]);

const NOUNS = new Set([
  'instruction',
  'instructions',
  'step',
  'steps',
  'direction',
  'directions',
  'rule',
  'rules',
  'prompt',
  'prompts',
  'guide',
  'guides',
  'guideline',
  'guidelines',
  'playbook',
  'playbooks',
  'workflow',
  'workflows',
  'procedure',
  'procedures',
  'checklist',
  'checklists',
  'skill',
  'skills',
  'policy',
  'policies',
]);

const INSTRUCTION_EXTENSIONS = ['.md', '.mdx', '.txt', '.prompt', '.yaml', '.yml', '.json'];

function isBoundary(text: string, i: number): boolean {
  const c = text[i];
  if (c !== '.' && c !== '!' && c !== '?') return false;
  const next = text.charCodeAt(i + 1);
  return Number.isNaN(next) || next <= 0x20;
}

/** The sentence around [start, end): at most SENTENCE_WINDOW characters on each side. */
function sentenceAround(text: string, start: number, end: number): string {
  let l = start;
  while (l > 0 && start - l < SENTENCE_WINDOW && !isBoundary(text, l - 1)) l--;
  let r = end;
  while (r < text.length && r - end < SENTENCE_WINDOW && !isBoundary(text, r)) r++;
  return text.slice(l, r);
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w !== '');
}

/** The sentence with every URL in it blanked out (URL paths are not prose). */
function withoutUrls(sentence: string): string {
  const urls = findUrls(sentence, { left: Number.POSITIVE_INFINITY });
  let out = '';
  let last = 0;
  for (const url of urls) {
    out += `${sentence.slice(last, url.start)} `;
    last = url.end;
  }
  return out + sentence.slice(last);
}

function isInstructionSentence(sentence: string, parsed: ParsedUrl): boolean {
  const plain = withoutUrls(sentence);
  const words = wordsOf(plain);
  const lower = plain.toLowerCase();
  const verb =
    words.some((w) => VERBS.has(w)) || lower.includes('adhere to') || lower.includes('comply with');
  if (!verb) return false;
  if (words.some((w) => NOUNS.has(w))) return true;
  return INSTRUCTION_EXTENSIONS.some((ext) => parsed.lowerPath.endsWith(ext));
}

interface ProseLine {
  text: string;
  line: number;
}

/** Splits prose lines into blocks: blank lines, headings and list items start a new block. */
function proseBlocks(lines: readonly ProseLine[]): ProseLine[][] {
  const blocks: ProseLine[][] = [];
  let current: ProseLine[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push(current);
    current = [];
  };
  let previous = -2;
  for (const entry of lines) {
    const trimmed = entry.text.trim();
    if (trimmed === '' || entry.line !== previous + 1) flush();
    previous = entry.line;
    if (trimmed === '') continue;
    if (/^(?:#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>\s?|\|)/.test(trimmed.slice(0, 16))) flush();
    current.push(entry);
  }
  flush();
  return blocks;
}

function proseBlock(
  block: readonly ProseLine[],
  file: string,
  lines: readonly string[],
  budget: { left: number },
  out: ExternalOccurrence[],
): void {
  // Inline code spans are commands: `npx tool`, `curl … | sh`.
  const consumed = new Set<string>();
  for (const entry of block) {
    if (!entry.text.includes('`')) continue;
    const parts = entry.text.split('`');
    for (let k = 1; k < parts.length; k += 2) {
      const span = parts[k] as string;
      if (span.trim() === '') continue;
      const before = out.length;
      codeLine(lines, entry.line - 1, file, budget, out, span);
      for (let m = before; m < out.length; m++) {
        const occurrence = out[m] as ExternalOccurrence;
        if (occurrence.ref.role === 'reference') {
          out.splice(m, 1);
          m--;
          continue;
        }
        occurrence.text = entry.text;
        consumed.add(span);
      }
    }
  }
  // Join the block so a sentence wrapped over several lines is read as one.
  const starts: number[] = [];
  let joined = '';
  for (const entry of block) {
    starts.push(joined.length);
    joined += `${entry.text} `;
  }
  const indexAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const spans = [...consumed];
  const urls = findUrls(joined, budget);
  for (const url of urls) {
    if (spans.length > 0 && spans.some((span) => span.includes(url.raw))) continue;
    const k = indexAt(url.start);
    const where = block[k] as ProseLine;
    const focus = Math.max(0, url.start - (starts[k] as number));
    if (url.gitPlus || url.scheme === 'ssh' || url.scheme === 'git') {
      const ref = gitRef(url.raw, 'reference');
      if (ref) out.push({ ref, file, line: where.line, text: where.text, focus });
      continue;
    }
    const parsed = parseUrl(url.raw);
    if (parsed === null) continue;
    const sentence = sentenceAround(joined, url.start, url.end);
    if (isInstructionSentence(sentence, parsed)) {
      const github = githubPin(parsed);
      out.push({
        ref: make(
          'url',
          parsed.id,
          'instructions',
          parsed.templated ? 'unpinned' : github.pin,
          parsed.templated ? null : github.value,
          parsed.host,
        ),
        file,
        line: where.line,
        text: where.text,
        focus,
      });
    } else {
      out.push({
        ref: make('url', parsed.origin, 'reference', 'unpinned', null, parsed.host),
        file,
        line: where.line,
        text: where.text,
        focus,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Structured files
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lineOfText(lines: readonly string[], needle: string): number {
  if (needle === '' || lines.length > 10_000) return 1;
  const index = lines.findIndex((l) => l.includes(needle));
  return index < 0 ? 1 : index + 1;
}

const DEPENDENCY_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function packageJson(
  text: string,
  lines: readonly string[],
  file: string,
  budget: { left: number },
  out: ExternalOccurrence[],
): void {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return;
  }
  if (!isRecord(json)) return;
  for (const key of DEPENDENCY_KEYS) {
    const deps = json[key];
    if (!isRecord(deps)) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || budget.left <= 0) continue;
      budget.left--;
      const ref =
        /^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|[\w.-]+\/[\w.-]+(?:#.*)?$)/.test(
          spec.slice(0, 256),
        )
          ? npmRef(spec, 'install')
          : npmRef(`${name}@${spec}`, 'install');
      if (ref) {
        const line = lineOfText(lines, JSON.stringify(name));
        out.push({ ref, file, line, text: lines[line - 1] ?? '', focus: 0 });
      }
    }
  }
  const scripts = json.scripts;
  if (isRecord(scripts)) {
    for (const command of Object.values(scripts)) {
      if (typeof command !== 'string') continue;
      const index = lineOfText(lines, command.slice(0, 40)) - 1;
      codeLine(lines, index, file, budget, out, command);
    }
  }
}

function requirementsFile(
  lines: readonly string[],
  file: string,
  budget: { left: number },
  out: ExternalOccurrence[],
): void {
  lines.forEach((raw, index) => {
    const text = raw.replace(/(?:^|\s)#.*$/, '').trim();
    if (text === '' || budget.left <= 0) return;
    budget.left--;
    const hash =
      text.length <= MAX_PIN_LINE ? /--hash[=\s]+sha256:([0-9a-f]{64})\b/i.exec(text) : null;
    const pin = hash === null ? null : (hash[1] as string).toLowerCase();
    if (text.startsWith('-')) {
      const [flag, value] = text.split(/[\s=]+/, 2);
      if (value === undefined) return;
      if (['-i', '--index-url', '--extra-index-url', '-f', '--find-links'].includes(flag ?? '')) {
        const parsed = value.includes('://') ? parseUrl(value) : null;
        if (parsed)
          out.push({
            ref: make('url', parsed.id, 'install', 'unpinned', null, parsed.host),
            file,
            line: index + 1,
            text: raw,
            focus: 0,
          });
      } else if (flag === '-e' || flag === '--editable') {
        const ref = pypiRef(value, 'install', pin);
        if (ref) out.push({ ref, file, line: index + 1, text: raw, focus: 0 });
      }
      return;
    }
    const spec = text.split(/\s+--/)[0] as string;
    const ref = pypiRef(spec, 'install', pin);
    if (ref) out.push({ ref, file, line: index + 1, text: raw, focus: 0 });
  });
}

/** MCP server configuration: `{ "mcpServers": { name: { url | command + args } } }`. */
function mcpJson(
  text: string,
  lines: readonly string[],
  file: string,
  budget: { left: number },
  out: ExternalOccurrence[],
): boolean {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(json)) return false;
  const servers = isRecord(json.mcpServers)
    ? json.mcpServers
    : isRecord(json.servers) && /(?:^|\/)\.?mcp\.json$/.test(file)
      ? json.servers
      : null;
  if (servers === null) return false;
  for (const server of Object.values(servers)) {
    if (!isRecord(server) || budget.left <= 0) continue;
    budget.left--;
    const url =
      typeof server.url === 'string'
        ? server.url
        : typeof server.serverUrl === 'string'
          ? server.serverUrl
          : null;
    if (url !== null) {
      const parsed = parseUrl(url.slice(0, MAX_TOKEN));
      if (parsed) {
        const line = lineOfText(lines, url.slice(0, 60));
        out.push({
          ref: make('mcp', parsed.id, 'run', 'unpinned', null, parsed.host),
          file,
          line,
          text: lines[line - 1] ?? '',
          focus: 0,
        });
      }
    }
    if (typeof server.command === 'string') {
      const args = Array.isArray(server.args)
        ? server.args.filter((a): a is string => typeof a === 'string')
        : [];
      const command = [server.command, ...args].join(' ');
      const index = lineOfText(lines, server.command) - 1;
      codeLine(lines, index, file, budget, out, command);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Externals of one text file (LF line endings). */
export function extractFileExternals(
  path: string,
  text: string,
  language: ExternalsLanguage,
): FileExternals {
  const lines = text.split('\n');
  const out: ExternalOccurrence[] = [];
  const budget = { left: MAX_OCCURRENCES };
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();

  const requirements = /^requirements[\w.-]*\.(?:txt|in)$/.test(base);
  if (
    language === 'markdown' ||
    (language === 'text' && !requirements && /\.(?:txt|markdown|mdown|mdx)$/.test(base))
  ) {
    const blocks = language === 'markdown' ? fencedBlocks(lines) : [];
    const inFence = new Set<number>();
    for (const block of blocks) {
      // The fence lines themselves are neither prose nor code.
      const first = block.lines[0]?.line ?? 0;
      if (first > 1) inFence.add(first - 2);
      for (const entry of block.lines) inFence.add(entry.line - 1);
      const last = block.lines[block.lines.length - 1]?.line;
      if (last !== undefined) inFence.add(last);
      const commands =
        block.dialect !== null && (block.info !== '' || looksLikeCommands(block.lines));
      for (const entry of block.lines) {
        if (commands) codeLine(lines, entry.line - 1, path, budget, out);
        else {
          for (const url of findUrls(entry.text, budget)) {
            const parsed = parseUrl(url.raw);
            if (parsed)
              out.push({
                ref: make('url', parsed.origin, 'reference', 'unpinned', null, parsed.host),
                file: path,
                line: entry.line,
                text: entry.text,
                focus: url.start,
              });
          }
        }
      }
    }
    // Unclosed or empty fences: mark their opening lines too.
    const prose: ProseLine[] = [];
    lines.forEach((t, i) => {
      if (inFence.has(i) || /^ {0,3}(?:`{3,}|~{3,})/.test(t)) return;
      prose.push({ text: t, line: i + 1 });
    });
    for (const block of proseBlocks(prose)) proseBlock(block, path, lines, budget, out);
  } else if (language === 'text') {
    let structured = false;
    if (base.endsWith('.json')) structured = mcpJson(text, lines, path, budget, out);
    if (base === 'package.json') {
      packageJson(text, lines, path, budget, out);
      structured = true;
    }
    if (requirements) {
      requirementsFile(lines, path, budget, out);
      structured = true;
    }
    if (!structured) {
      lines.forEach((t, i) => {
        for (const url of findUrls(t, budget)) {
          const parsed = parseUrl(url.raw);
          if (parsed)
            out.push({
              ref: make('url', parsed.origin, 'reference', 'unpinned', null, parsed.host),
              file: path,
              line: i + 1,
              text: t,
              focus: url.start,
            });
        }
      });
    }
  } else {
    if (base === 'package.json') packageJson(text, lines, path, budget, out);
    lines.forEach((t, i) => {
      const trimmed = t.trimStart();
      const comment =
        trimmed.startsWith('#') ||
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('* ') ||
        trimmed.startsWith('<#') ||
        (language === 'bat' && /^(?:rem\s|::)/i.test(trimmed));
      if (comment && !trimmed.startsWith('#!')) {
        for (const url of findUrls(t, budget)) {
          const parsed = parseUrl(url.raw);
          if (parsed)
            out.push({
              ref: make('url', parsed.origin, 'reference', 'unpinned', null, parsed.host),
              file: path,
              line: i + 1,
              text: t,
              focus: url.start,
            });
        }
        return;
      }
      codeLine(lines, i, path, budget, out);
    });
  }
  return { occurrences: out, overflow: budget.left <= 0 };
}

/** Rule metadata for findings created here (kept in sync with RULES). */
function remoteInstructionFinding(occurrence: ExternalOccurrence): Finding {
  const { ref } = occurrence;
  const pinned = ref.pin === 'commit' || ref.pin === 'sha256';
  const finding: Finding = {
    ruleId: 'ext.remote-instructions',
    category: 'remote-instructions',
    severity: pinned ? 'medium' : 'high',
    declarable: true,
    file: occurrence.file,
    line: occurrence.line,
    evidence: makeEvidence(occurrence.text, occurrence.focus),
    message: pinned
      ? `Tells the agent to fetch and follow instructions from ${ref.id} (pinned to ${ref.pin} ${ref.pinValue ?? ''})`.trim()
      : `Tells the agent to fetch and follow instructions from ${ref.id} (unpinned: the content can change after approval)`,
  };
  finding.subject = ref.host ?? '*';
  return finding;
}

/**
 * Package-level externals: merged, sorted and bounded, plus the findings they imply
 * (`ext.remote-instructions`, and `code.obfuscated` for an inventory that overflowed).
 */
export function finishExternals(perFile: readonly { path: string; result: FileExternals }[]): {
  externals: ExternalRef[];
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const all: ExternalRef[] = [];
  const reported = new Set<string>();
  for (const { path, result } of perFile) {
    for (const occurrence of result.occurrences) {
      all.push(occurrence.ref);
      if (occurrence.ref.role !== 'instructions') continue;
      const key = `${occurrence.file}\u0000${occurrence.line}\u0000${occurrence.ref.id}`;
      if (reported.has(key)) continue;
      reported.add(key);
      findings.push(remoteInstructionFinding(occurrence));
    }
    if (result.overflow) {
      findings.push(
        overflowFinding(path, `more than ${MAX_OCCURRENCES} outbound references in one file`),
      );
    }
  }
  let externals = normalizeExternals(all);
  if (externals.length > MAX_EXTERNALS) {
    const first =
      perFile.find((f) => f.result.occurrences.length > 0)?.path ?? perFile[0]?.path ?? 'SKILL.md';
    findings.push(
      overflowFinding(
        first,
        `${externals.length} distinct outbound references (limit ${MAX_EXTERNALS})`,
      ),
    );
    externals = externals.slice(0, MAX_EXTERNALS);
  }
  return { externals, findings };
}

function overflowFinding(file: string, evidence: string): Finding {
  return {
    ruleId: 'code.obfuscated',
    category: 'obfuscation',
    severity: 'high',
    declarable: false,
    file,
    line: 0,
    evidence,
    message:
      'Too many outbound references to inventory: the capability inventory would be incomplete',
    subject: 'externals-overflow',
  };
}

/** Role order used when merging (exported for tests). */
export function roleRank(role: ExternalRole): number {
  return ROLE_RANK[role];
}
