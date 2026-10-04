/**
 * Command-line analysis for POSIX shell, PowerShell and batch files, shell blocks in
 * Markdown, and command strings passed to process APIs from JavaScript and Python.
 *
 * Exec policy for command languages: a shell script runs commands by nature, so only programs
 * that run *other code* are reported as `exec.shell` (interpreters, package runners and
 * script hosts — see LAUNCHERS). An interpreter started on a script that ships in the package
 * (`bash scripts/run.sh`) is not reported, because that script is scanned itself.
 */
import type { FileScan } from '../context';
import {
  DECODE_RE,
  findPersistencePaths,
  findSecretPaths,
  hostSubject,
  PS_ENCODED_RE,
  persistenceCommand,
} from '../patterns';
import { isStandardEnv, matchAll, programName } from './common';

export type Dialect = 'sh' | 'ps' | 'bat';

export interface CodeLine {
  /** Comment-stripped text. */
  text: string;
  /** 1-based line number in the scanned file. */
  line: number;
}

interface ShellState {
  /** Variable names assigned in the file (upper case for PowerShell and batch). */
  assigned: Set<string>;
  /** Literal values of simple assignments, for expanding write targets. */
  vars: Map<string, string>;
  /** Basename of each downloaded file -> host it came from. */
  downloads: Map<string, string>;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash']);
const SCRIPT_HOSTS = new Set([
  'python',
  'pypy',
  'pypy3',
  'node',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'ruby',
  'perl',
  'php',
  'powershell',
  'pwsh',
  'cmd',
  'cscript',
  'wscript',
  'osascript',
]);
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'uvx', 'mshta', 'rundll32', 'regsvr32']);
const PS_EVAL = new Set(['iex', 'invoke-expression']);
const PS_START = new Set(['start-process', 'saps']);
/** Programs whose start is reported as `exec.shell`. */
export const LAUNCHERS = new Set([...SHELLS, ...SCRIPT_HOSTS, ...RUNNERS, ...PS_EVAL, ...PS_START]);

const NET_COMMANDS = new Set([
  'curl',
  'wget',
  'aria2c',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
  'start-bitstransfer',
  'bitsadmin',
  'certutil',
]);
const DOWNLOADERS = new Set([
  'curl',
  'wget',
  'aria2c',
  'invoke-webrequest',
  'iwr',
  'invoke-restmethod',
  'irm',
]);
const DOWNLOAD_TEXT_RE =
  /\b(?:curl|wget|aria2c|iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString|DownloadData|Net\.WebClient|Start-BitsTransfer)\b/i;

/** Commands that only create, modify or remove the paths they name. */
/** Commands whose path arguments are never read: they print, test, create or remove paths. */
const NO_READ = new Set([
  'ssh-keygen',
  'mkdir',
  'touch',
  'rm',
  'rmdir',
  'chmod',
  'chown',
  'del',
  'echo',
  'printf',
  'write-host',
  'write-output',
  '[',
  '[[',
  'test',
  'case',
  'basename',
  'dirname',
]);
const FILTERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'findstr', 'select-string', 'sls']);
const COPY_LIKE = new Set([
  'cp',
  'mv',
  'install',
  'ln',
  'rsync',
  'copy',
  'xcopy',
  'robocopy',
  'move',
  'copy-item',
  'cpi',
  'move-item',
  'mi',
]);
const WRITE_ALL_ARGS = new Set([
  'tee',
  'dd',
  'add-content',
  'ac',
  'set-content',
  'sc',
  'out-file',
  'new-item',
  'ni',
  'new-itemproperty',
  'set-itemproperty',
  'sp',
]);

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Analyzes comment-stripped lines of one shell source (a file or a Markdown block). */
export function analyzeShell(
  scan: FileScan,
  lines: readonly CodeLine[],
  dialect: Dialect,
  /** Lines to collect variable assignments from (defaults to `lines`). */
  context: readonly CodeLine[] = lines,
): void {
  const state = createState(context, dialect);
  for (const logical of logicalLines(lines, dialect)) {
    analyzeCommandLine(scan, logical.text, logical.line, state, dialect, 0);
  }
}

/** Analyzes one command string found in code (e.g. the argument of `execSync`). */
export function analyzeCommandString(
  scan: FileScan,
  command: string,
  line: number,
  dialect: Dialect = 'sh',
): void {
  const state: ShellState = { assigned: new Set(), vars: new Map(), downloads: new Map() };
  analyzeCommandLine(scan, command, line, state, dialect, 1);
}

/** Resolves the program a command line starts, skipping env assignments and wrappers. */
export function commandName(command: string, dialect: Dialect = 'sh'): string | null {
  const flat = extractSubstitutions(command, dialect).text;
  const first = splitSegments(tokenize(flat, dialect))[0];
  if (first === undefined) return null;
  return resolveCommand(first.words, dialect)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Pre-pass: assignments, logical lines, heredocs
// ---------------------------------------------------------------------------

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function createState(lines: readonly CodeLine[], dialect: Dialect): ShellState {
  const state: ShellState = { assigned: new Set(), vars: new Map(), downloads: new Map() };
  for (const { text } of lines) {
    if (dialect === 'sh') {
      for (const m of matchAll(
        text,
        /(?:^|[\s;&|(])(?:export\s+|local\s+|readonly\s+|(?:declare|typeset)\s+(?:-\w+\s+)*)?([A-Za-z_]\w*)=("[^"]*"|'[^']*'|[^\s;&|)]*)/,
      )) {
        const name = m[1] as string;
        state.assigned.add(name);
        state.vars.set(name, unquote(m[2] ?? ''));
      }
      for (const m of matchAll(text, /\bread\b([^;&|]*)/)) {
        for (const w of (m[1] ?? '').split(/\s+/))
          if (/^[A-Za-z_]\w*$/.test(w)) state.assigned.add(w);
      }
      for (const m of matchAll(
        text,
        /\bfor\s+([A-Za-z_]\w*)\s+in\b|\bgetopts\s+\S+\s+([A-Za-z_]\w*)/,
      )) {
        state.assigned.add((m[1] ?? m[2]) as string);
      }
    } else if (dialect === 'ps') {
      const m = /^\s*\$([A-Za-z_]\w*)\s*=(?!=)\s*(.*)$/.exec(text);
      if (m !== null) state.vars.set((m[1] as string).toLowerCase(), unquote(m[2] ?? ''));
      for (const e of matchAll(text, /\$env:([A-Za-z_]\w*)\s*=(?!=)/i)) {
        state.assigned.add((e[1] as string).toUpperCase());
      }
    } else {
      for (const m of matchAll(text, /\bset\s+(?:\/[ap]\s+)?"?([A-Za-z_]\w*)=([^"&\n]*)/i)) {
        const name = (m[1] as string).toUpperCase();
        state.assigned.add(name);
        state.vars.set(name, (m[2] ?? '').trim());
      }
    }
  }
  return state;
}

function continues(text: string, dialect: Dialect): boolean {
  if (dialect === 'sh')
    return /(?:^|[^\\])(?:\\\\)*\\\s*$/.test(text) || /(?:\|\||&&|\|)\s*$/.test(text);
  if (dialect === 'ps') return /`\s*$/.test(text) || /\|\s*$/.test(text);
  return /\^\s*$/.test(text);
}

function dropContinuation(text: string, dialect: Dialect): string {
  const trimmed = text.trimEnd();
  const marker = dialect === 'sh' ? '\\' : dialect === 'ps' ? '`' : '^';
  return trimmed.endsWith(marker) ? trimmed.slice(0, -1) : trimmed;
}

/** Joins continuation lines; heredoc bodies are skipped unless they feed a shell. */
function logicalLines(lines: readonly CodeLine[], dialect: Dialect): CodeLine[] {
  const out: CodeLine[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = lines[i] as CodeLine;
    i++;
    let text = first.text;
    while (i < lines.length && continues(text, dialect)) {
      text = `${dropContinuation(text, dialect)} ${(lines[i] as CodeLine).text}`;
      i++;
    }
    out.push({ text, line: first.line });
    if (dialect !== 'sh') continue;
    const heredoc = /(?<!<)<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/.exec(text);
    if (heredoc === null) continue;
    const delimiter = heredoc[3] as string;
    let end = -1;
    for (let j = i; j < lines.length; j++) {
      const body = (lines[j] as CodeLine).text;
      if ((heredoc[1] === '-' ? body.replace(/^\t+/, '') : body).trim() === delimiter) {
        end = j;
        break;
      }
    }
    if (end < 0) continue;
    const body = lines.slice(i, end);
    i = end + 1;
    const feedsShell = splitSegments(tokenize(extractSubstitutions(text, 'sh').text, 'sh')).some(
      (seg) => {
        const cmd = resolveCommand(seg.words, 'sh');
        return cmd !== null && SHELLS.has(cmd.name);
      },
    );
    if (feedsShell) out.push(...logicalLines(body, 'sh'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function closeParen(text: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== '') {
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Replaces command substitutions (`$(…)`, backticks, `<(…)`; PowerShell `(…)` groups) with
 * `__SUBSTn__` placeholders and returns their contents.
 */
function extractSubstitutions(text: string, dialect: Dialect): { text: string; subs: string[] } {
  if (dialect === 'bat') return { text, subs: [] };
  const subs: string[] = [];
  let out = '';
  let quote = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1] ?? '';
    if (quote === "'") {
      out += c;
      if (c === "'") quote = '';
      i++;
      continue;
    }
    if ((dialect === 'sh' && c === '\\') || (dialect === 'ps' && c === '`')) {
      out += c + next;
      i += 2;
      continue;
    }
    const open =
      c === '$' && next === '(' && text[i + 2] !== '('
        ? i + 1
        : dialect === 'sh' && (c === '<' || c === '>') && next === '('
          ? i + 1
          : dialect === 'ps' && c === '(' && quote === '' && /(?:^|[\s|(=,!;&{])$/.test(out)
            ? i
            : -1;
    if (open >= 0) {
      const close = closeParen(text, open);
      if (close > open) {
        out += `__SUBST${subs.length}__`;
        subs.push(text.slice(open + 1, close));
        i = close + 1;
        continue;
      }
    }
    if (dialect === 'sh' && c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i) {
        out += `__SUBST${subs.length}__`;
        subs.push(text.slice(i + 1, close));
        i = close + 1;
        continue;
      }
    }
    if (c === "'" && quote === '') quote = "'";
    else if (c === '"') quote = quote === '"' ? '' : '"';
    out += c;
    i++;
  }
  return { text: out, subs };
}

type Token =
  | { kind: 'word'; value: string }
  | { kind: 'sep'; value: string }
  | { kind: 'redir'; op: string; target: string };

function tokenize(text: string, dialect: Dialect): Token[] {
  const tokens: Token[] = [];
  const esc = dialect === 'sh' ? '\\' : dialect === 'ps' ? '`' : '^';
  const seps = dialect === 'sh' ? '|;&()' : dialect === 'ps' ? '|;{}' : '|&';
  let i = 0;
  const n = text.length;

  const readWord = (): string => {
    let value = '';
    while (i < n) {
      const c = text[i] as string;
      if (/\s/.test(c) || seps.includes(c) || c === '>' || c === '<') break;
      if (dialect === 'ps' && c === '&' && text[i + 1] === '&') break;
      if (c === esc && i + 1 < n) {
        value += text[i + 1];
        i += 2;
      } else if (c === "'" && dialect !== 'bat') {
        const close = text.indexOf("'", i + 1);
        value += close < 0 ? text.slice(i + 1) : text.slice(i + 1, close);
        i = close < 0 ? n : close + 1;
      } else if (c === '"') {
        i++;
        while (i < n && text[i] !== '"') {
          if (text[i] === esc && dialect !== 'bat' && i + 1 < n) {
            value += text[i + 1];
            i += 2;
          } else {
            value += text[i];
            i++;
          }
        }
        i++;
      } else {
        value += c;
        i++;
      }
    }
    return value;
  };

  while (i < n) {
    const c = text[i] as string;
    const next = text[i + 1] ?? '';
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const redir = /^(?:[0-9*]|&(?=>))?(?:>>?|<<<|<<-?|<)(?:&[0-9-]|\|)?/.exec(text.slice(i));
    if (redir !== null && (c !== '&' || dialect === 'sh') && !(c === '*' && dialect !== 'ps')) {
      const op = redir[0];
      i += op.length;
      if (/&[0-9-]$/.test(op)) {
        tokens.push({ kind: 'redir', op, target: '' });
        continue;
      }
      while (i < n && /\s/.test(text[i] as string)) i++;
      tokens.push({ kind: 'redir', op, target: readWord() });
      continue;
    }
    if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      tokens.push({ kind: 'sep', value: c + next });
      i += 2;
      continue;
    }
    if (c === '&' && dialect === 'ps') {
      tokens.push({ kind: 'word', value: '&' });
      i++;
      continue;
    }
    if (seps.includes(c)) {
      tokens.push({ kind: 'sep', value: c });
      i++;
      if (c === '|' && text[i] === '&') i++;
      continue;
    }
    const start = i;
    const value = readWord();
    if (i === start) {
      i++;
      continue;
    }
    tokens.push({ kind: 'word', value });
  }
  return tokens;
}

interface Segment {
  words: string[];
  redirects: { op: string; target: string }[];
  /** Separator before this segment ('' for the first). */
  after: string;
}

function splitSegments(tokens: Token[]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = { words: [], redirects: [], after: '' };
  for (const t of tokens) {
    if (t.kind === 'sep') {
      segments.push(current);
      current = { words: [], redirects: [], after: t.value };
    } else if (t.kind === 'word') {
      current.words.push(t.value);
    } else {
      current.redirects.push({ op: t.op, target: t.target });
    }
  }
  segments.push(current);
  return segments.filter((s) => s.words.length > 0 || s.redirects.length > 0);
}

interface Command {
  name: string;
  word: string;
  args: string[];
}

const KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  '{',
  '}',
  'exec',
  'nohup',
  'time',
  'command',
  'builtin',
  'caffeinate',
]);

function resolveCommand(words: readonly string[], dialect: Dialect): Command | null {
  let i = 0;
  const skipFlags = (withValue: RegExp | null): void => {
    while (i < words.length && (words[i] as string).startsWith('-')) {
      if (withValue?.test(words[i] as string)) i++;
      i++;
    }
  };
  while (i < words.length) {
    const w = words[i] as string;
    const lw = w.toLowerCase().replace(/^@/, '');
    if (dialect === 'sh' && /^[A-Za-z_]\w*=/.test(w)) {
      i++;
    } else if (lw === 'sudo' || lw === 'doas') {
      i++;
      skipFlags(/^-[ugCDhpr]$/);
    } else if (lw === 'env') {
      i++;
      while (i < words.length && /^-|^[A-Za-z_]\w*=/.test(words[i] as string)) {
        if (words[i] === '-u') i++;
        i++;
      }
    } else if (lw === 'timeout') {
      i++;
      skipFlags(/^-[sk]$/);
      i++;
    } else if (lw === 'xargs') {
      i++;
      skipFlags(/^-[IinLPdEsa]$/);
    } else if (lw === 'nice' || lw === 'ionice' || lw === 'stdbuf') {
      i++;
      skipFlags(/^-[ncpt]$/);
    } else if (dialect === 'sh' && KEYWORDS.has(lw)) {
      i++;
    } else if (dialect === 'ps' && (w === '&' || w === '.')) {
      i++;
    } else if (dialect === 'ps' && /^\$[\w:]+$/.test(w) && words[i + 1] === '=') {
      i += 2;
    } else if (dialect === 'bat' && (lw === 'call' || lw === 'start')) {
      i++;
      while (i < words.length && (words[i] === '' || /^\/[a-z]+$/i.test(words[i] as string))) i++;
    } else if (w === '') {
      i++;
    } else {
      break;
    }
  }
  const word = words[i];
  if (word === undefined) return null;
  let name = programName(word);
  if (dialect === 'ps' && name === 'start') name = 'start-process';
  if (/^__subst\d+__/.test(name)) name = '__subst__';
  return { name, word, args: words.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function focusOf(scan: FileScan, line: number, needle: string): number {
  const index = needle === '' ? -1 : (scan.lines[line - 1] ?? '').indexOf(needle);
  return index < 0 ? 0 : index;
}

function basename(path: string): string {
  const p = path.replace(/["']/g, '');
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1).toLowerCase();
}

function optionValue(args: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = (args[i] as string).toLowerCase();
    for (const name of names) {
      if (a === name) return args[i + 1];
      if (a.startsWith(`${name}=`) || a.startsWith(`${name}:`)) {
        return (args[i] as string).slice(name.length + 1);
      }
    }
  }
  return undefined;
}

function nonFlags(args: readonly string[], dialect: Dialect): string[] {
  return args.filter(
    (a) => !a.startsWith('-') && !(dialect === 'bat' && /^\/[a-z?]{1,4}$/i.test(a)),
  );
}

function expandVars(text: string, state: ShellState): string {
  return text
    .replace(
      /\$\{?([A-Za-z_]\w*)\}?/g,
      (m, name: string) => state.vars.get(name) ?? state.vars.get(name.toLowerCase()) ?? m,
    )
    .replace(/%([A-Za-z_]\w*)%/g, (m, name: string) => state.vars.get(name.toUpperCase()) ?? m);
}

const HOST_RE = /^(?:[\w.-]+@)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(?::|$)/;
const SOCKET_COMMANDS = new Set(['nc', 'ncat', 'netcat', 'socat', 'telnet', 'ssh', 'sftp', 'ftp']);

/** The host a network command talks to: a URL host, `user@host`, `host:path`, or '*'. */
function hostOfArgs(args: readonly string[], name = ''): string {
  const host = hostSubject(args.join(' '));
  if (host !== '*') return host;
  const isHost = (h: string): boolean =>
    /[a-z]/i.test(h) && !/\.(?:sh|ps1|py|js|txt|json|tar|gz|tgz|zip)$/i.test(h);
  for (const a of args) {
    const m = HOST_RE.exec(a);
    if (m !== null && (a.includes('@') || a.includes(':')) && isHost(m[1] as string)) {
      return (m[1] as string).toLowerCase();
    }
  }
  if (SOCKET_COMMANDS.has(name)) {
    for (const a of args) {
      const m = HOST_RE.exec(a);
      if (m !== null && !a.startsWith('-') && isHost(m[1] as string)) {
        return (m[1] as string).toLowerCase();
      }
    }
  }
  return '*';
}

/** Does the interpreter read its program from standard input? */
function readsStdin(name: string, args: readonly string[]): boolean {
  if (PS_EVAL.has(name)) return true;
  if (name === 'powershell' || name === 'pwsh') {
    return (
      args.length === 0 || args.includes('-') || /-c(?:ommand)?\s+-(?:\s|$)/i.test(args.join(' '))
    );
  }
  if (!SHELLS.has(name) && !SCRIPT_HOSTS.has(name)) return false;
  const inline = SHELLS.has(name) ? /^-[a-z]*c[a-z]*$/i : /^-(?:[a-z]*[cemr][a-z]*|-eval|-print)$/i;
  for (const a of args) {
    if (a === '-' || a === '--' || a === '-s') continue;
    if (inline.test(a)) return false;
    if (!a.startsWith('-')) return SHELLS.has(name) && args.includes('-s');
  }
  return true;
}

/** The script an interpreter is started on, when it is a file rather than inline code. */
function scriptArgument(name: string, args: readonly string[]): string | null {
  if (RUNNERS.has(name) || PS_EVAL.has(name)) return null;
  let i = 0;
  if ((name === 'deno' || name === 'bun') && args[0] === 'run') i = 1;
  if (name === 'powershell' || name === 'pwsh') {
    const file = optionValue(args, ['-file', '-f']);
    if (file !== undefined) return file;
    const positional = nonFlags(args, 'ps').find((a) => /\.ps1$/i.test(a));
    return positional ?? null;
  }
  if (name === 'cmd') {
    const c = args.findIndex((a) => /^\/[ck]$/i.test(a));
    return c >= 0 ? (args[c + 1] ?? null) : null;
  }
  for (; i < args.length; i++) {
    const a = args[i] as string;
    if (/^-(?:[a-z]*[cem]|-eval|-print)$/i.test(a) && !SHELLS.has(name)) return null;
    if (SHELLS.has(name) && /^-[a-z]*c[a-z]*$/i.test(a)) return null;
    if (a.startsWith('-') || (name.endsWith('script') && a.startsWith('//'))) continue;
    return a;
  }
  return null;
}

function depsInstaller(name: string, args: readonly string[]): string | null {
  const a0 = args[0]?.toLowerCase();
  const a1 = args[1]?.toLowerCase();
  switch (name) {
    case 'npm':
      return [
        'install',
        'i',
        'add',
        'ci',
        'in',
        'ins',
        'inst',
        'insta',
        'instal',
        'isntall',
      ].includes(a0 ?? '')
        ? 'npm'
        : null;
    case 'pnpm':
    case 'bun':
      return ['add', 'install', 'i'].includes(a0 ?? '') ? name : null;
    case 'yarn':
      return a0 === 'add' || a0 === 'install' || (a0 === 'global' && a1 === 'add') ? 'yarn' : null;
    case 'pip':
      return a0 === 'install' ? 'pip' : null;
    case 'python': {
      const m = args.indexOf('-m');
      return m >= 0 && /^pip\d*$/.test(args[m + 1] ?? '') && args[m + 2] === 'install'
        ? 'pip'
        : null;
    }
    case 'uv':
      return (a0 === 'pip' && a1 === 'install') ||
        a0 === 'add' ||
        (a0 === 'tool' && a1 === 'install')
        ? 'uv'
        : null;
    case 'pipx':
    case 'gem':
    case 'cargo':
    case 'brew':
    case 'choco':
    case 'winget':
    case 'scoop':
    case 'apt':
    case 'apt-get':
    case 'yum':
    case 'dnf':
    case 'zypper':
    case 'conda':
    case 'mamba':
      return a0 === 'install' ? name : null;
    case 'poetry':
    case 'pdm':
      return a0 === 'add' || a0 === 'install' ? name : null;
    case 'go':
      return a0 === 'install' || a0 === 'get' ? 'go' : null;
    case 'apk':
      return a0 === 'add' ? 'apk' : null;
    case 'pacman':
      return args.some((a) => /^-S/.test(a)) ? 'pacman' : null;
    case 'install-module':
    case 'install-package':
    case 'install-script':
      return name;
    default:
      return null;
  }
}

function writeTargets(cmd: Command, seg: Segment, dialect: Dialect): string[] {
  const targets = seg.redirects
    .filter((r) => r.op.includes('>') && r.target !== '')
    .map((r) => r.target);
  if (COPY_LIKE.has(cmd.name)) {
    const dest = optionValue(cmd.args, ['-destination']) ?? nonFlags(cmd.args, dialect).at(-1);
    if (dest !== undefined) targets.push(dest);
  } else if (WRITE_ALL_ARGS.has(cmd.name)) {
    targets.push(...cmd.args);
  } else if (cmd.name === 'sed' && cmd.args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) {
    targets.push(...nonFlags(cmd.args, dialect).slice(1));
  }
  return targets;
}

function trackDownload(cmd: Command, seg: Segment, state: ShellState): void {
  const { name, args } = cmd;
  let out: string | undefined;
  if (name === 'curl') {
    out = optionValue(args, ['-o', '--output']);
    if (
      out === undefined &&
      args.some((a) => a === '--remote-name' || /^-[a-zA-Z]*O[a-zA-Z]*$/.test(a))
    ) {
      out = args.find((a) => /^https?:\/\//i.test(a));
    }
    out ??= seg.redirects.find((r) => r.op.includes('>') && r.target !== '')?.target;
  } else if (name === 'wget') {
    out = optionValue(args, ['-o', '--output-document']);
    if (out === undefined) out = args.find((a) => /^https?:\/\//i.test(a));
  } else if (
    name === 'invoke-webrequest' ||
    name === 'iwr' ||
    name === 'invoke-restmethod' ||
    name === 'irm'
  ) {
    out = optionValue(args, ['-outfile']);
  } else if (name === 'start-bitstransfer') {
    out = optionValue(args, ['-destination']) ?? nonFlags(args, 'ps')[1];
  } else if (
    (name === 'bitsadmin' && args.some((a) => /^\/transfer$/i.test(a))) ||
    (name === 'certutil' && args.some((a) => /^[-/]urlcache$/i.test(a)))
  ) {
    out = args.at(-1);
  }
  if (out === undefined || out === '-' || out === '') return;
  const base = basename(out.replace(/[?#].*$/, ''));
  if (base !== '') state.downloads.set(base, hostOfArgs(args));
}

function analyzeCommandLine(
  scan: FileScan,
  text: string,
  line: number,
  state: ShellState,
  dialect: Dialect,
  depth: number,
): void {
  if (depth > 4 || text.trim() === '') return;
  const raw = scan.lines[line - 1] ?? '';

  if (DECODE_RE.test(text)) scan.markDecodes();
  if (PS_ENCODED_RE.test(text)) {
    scan.add({
      ruleId: 'code.obfuscated',
      line,
      message: 'Runs a base64-encoded PowerShell command (-EncodedCommand)',
      subject: 'powershell',
      focus: focusOf(scan, line, '-e'),
    });
  }
  const persist = persistenceCommand(text);
  if (persist !== null) {
    scan.add({
      ruleId: 'fs.persistence',
      line,
      message: `Installs persistence (${persist.subject})`,
      subject: persist.subject,
      focus: Math.max(0, raw.indexOf(text.slice(persist.index, persist.index + 8))),
    });
  }
  envReads(scan, text, line, dialect, state);
  if (dialect === 'ps') powerShellLine(scan, text, line, state);

  const { text: flat, subs } = extractSubstitutions(text, dialect);
  for (const sub of subs) analyzeCommandLine(scan, sub, line, state, dialect, depth + 1);
  const subHasDownload = (word: string): boolean =>
    [...word.matchAll(/__SUBST(\d+)__/g)].some((m) =>
      DOWNLOAD_TEXT_RE.test(subs[Number(m[1])] ?? ''),
    );

  // Test expressions and arithmetic are not commands.
  const commands =
    dialect === 'sh'
      ? flat.replace(/\[\[[\s\S]*?\]\]/g, '[[ ]]').replace(/\(\([\s\S]*?\)\)/g, ' ')
      : flat;
  const segments = splitSegments(tokenize(commands, dialect));
  let pipelineDownload: string | null = null;
  segments.forEach((seg, k) => {
    if (seg.after !== '|') pipelineDownload = null;
    const words = seg.words;
    const w0 = words[0]?.toLowerCase() ?? '';
    const next = segments[k + 1];
    // `env | grep X` reads one variable; `set)` is a case label.
    const filtered =
      next !== undefined &&
      ((next.after === '|' && FILTERS.has(resolveCommand(next.words, dialect)?.name ?? '')) ||
        (dialect === 'sh' && next.after === ')'));

    if (
      !filtered &&
      (((w0 === 'env' || w0 === 'printenv') && words.length === 1) ||
        (w0 === 'export' && words[1] === '-p') ||
        (w0 === 'set' && words.length === 1 && dialect !== 'ps') ||
        (w0 === 'compgen' && words[1] === '-v'))
    ) {
      scan.add({
        ruleId: 'secrets.read',
        line,
        message: 'Dumps every environment variable',
        subject: 'env:*',
        focus: focusOf(scan, line, words[0] ?? ''),
      });
    }

    const cmd = resolveCommand(words, dialect);
    if (cmd === null) return;
    const focus = focusOf(scan, line, cmd.word);

    // Persistence: writes into rc files, startup folders, hooks, agent config…
    const targets = writeTargets(cmd, seg, dialect);
    for (const target of targets) {
      for (const hit of findPersistencePaths(expandVars(target, state))) {
        scan.add({
          ruleId: 'fs.persistence',
          line,
          message: `Writes to a persistence location (${hit.subject})`,
          subject: hit.subject,
          focus,
        });
      }
    }

    // Secrets: credential paths the command reads (write targets excluded).
    if (!NO_READ.has(cmd.name)) {
      const readable = [
        /\s/.test(cmd.word) ? '' : cmd.word,
        ...cmd.args.filter((a) => !targets.includes(a)),
        ...seg.redirects.filter((r) => r.op === '<').map((r) => r.target),
      ];
      for (const hit of findSecretPaths(expandVars(readable.join(' '), state))) {
        scan.add({
          ruleId: 'secrets.read',
          line,
          message: `Reads credentials (${hit.subject})`,
          subject: hit.subject,
          focus: focusOf(scan, line, hit.subject.replace(/^~\//, '')),
        });
      }
    }

    // Network.
    const certutilFetch =
      cmd.name === 'certutil' && cmd.args.some((a) => /^[-/]urlcache$/i.test(a));
    if (NET_COMMANDS.has(cmd.name) && (cmd.name !== 'certutil' || certutilFetch)) {
      const host = hostOfArgs(cmd.args, cmd.name);
      scan.add({
        ruleId: 'net.access',
        line,
        message: `Network access with ${cmd.name} (${host})`,
        subject: host,
        focus,
      });
    }

    // Download and run: piped into an interpreter, fed through a substitution, or saved then run.
    if (pipelineDownload !== null && seg.after === '|' && readsStdin(cmd.name, cmd.args)) {
      scan.add({
        ruleId: 'net.download-exec',
        line,
        message: `Pipes downloaded content into ${cmd.name}`,
        subject: pipelineDownload,
        focus,
      });
    }
    if (
      (LAUNCHERS.has(cmd.name) ||
        cmd.name === 'eval' ||
        cmd.name === 'source' ||
        cmd.name === '.') &&
      cmd.args.some(subHasDownload)
    ) {
      scan.add({
        ruleId: 'net.download-exec',
        line,
        message: `Runs downloaded content with ${cmd.name}`,
        subject: hostSubject(text),
        focus,
      });
    }
    if (state.downloads.size > 0) {
      const candidates = [cmd.word];
      if (LAUNCHERS.has(cmd.name) || cmd.name === 'source' || cmd.name === '.') {
        const first = nonFlags(cmd.args, dialect)[0];
        if (first !== undefined) candidates.push(first);
      }
      for (const c of candidates) {
        const host = state.downloads.get(basename(c));
        if (host !== undefined) {
          scan.add({
            ruleId: 'net.download-exec',
            line,
            message: `Runs a file downloaded earlier (${basename(c)})`,
            subject: host,
            focus,
          });
        }
      }
    }
    if (DOWNLOADERS.has(cmd.name)) pipelineDownload = hostOfArgs(cmd.args);
    trackDownload(cmd, seg, state);

    // Runtime package installs.
    const installer = depsInstaller(cmd.name, cmd.args);
    if (installer !== null) {
      scan.add({
        ruleId: 'deps.remote',
        line,
        message: `Installs packages at runtime with ${installer}`,
        subject: installer,
        focus,
      });
    }

    // Dynamic code.
    if (cmd.name === 'eval' && cmd.args.some((a) => /[$`]|__SUBST/.test(a))) {
      scan.add({
        ruleId: 'code.dynamic',
        line,
        message: 'Evaluates a computed shell string with eval',
        subject: 'eval',
        focus,
      });
    }
    if (
      (cmd.name === 'source' || cmd.name === '.') &&
      cmd.args.some((a) => a.startsWith('__SUBST'))
    ) {
      scan.add({
        ruleId: 'code.dynamic',
        line,
        message: 'Sources the output of a command',
        subject: cmd.name,
        focus,
      });
    }

    execCheck(scan, cmd, line, state, depth, focus);
  });
}

function execCheck(
  scan: FileScan,
  cmd: Command,
  line: number,
  state: ShellState,
  depth: number,
  focus: number,
): void {
  const { name, args } = cmd;
  if (
    (name === 'npm' || name === 'pnpm' || name === 'yarn') &&
    ['exec', 'x', 'dlx'].includes(args[0] ?? '')
  ) {
    scan.add({
      ruleId: 'exec.shell',
      line,
      message: `Runs a package with ${name} ${args[0]}`,
      subject: name,
      focus,
    });
    return;
  }
  if (!LAUNCHERS.has(name)) return;

  let subject = name;
  if (PS_EVAL.has(name)) {
    subject = 'powershell';
  } else if (PS_START.has(name)) {
    const target = optionValue(args, ['-filepath', '-file', '-path']) ?? nonFlags(args, 'ps')[0];
    if (target !== undefined && scan.isBundled(target)) return;
    subject = target === undefined || /^\$|__SUBST/.test(target) ? '*' : programName(target);
  }

  // Inline command strings are analyzed in their own dialect.
  if (SHELLS.has(name)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/i.test(a));
    const inline = c >= 0 ? args[c + 1] : undefined;
    if (inline !== undefined) analyzeCommandLine(scan, inline, line, state, 'sh', depth + 1);
  } else if (name === 'powershell' || name === 'pwsh') {
    const c = args.findIndex((a) => /^-(?:c|command|com|comm|comma|comman)$/i.test(a));
    if (c >= 0) analyzeCommandLine(scan, args.slice(c + 1).join(' '), line, state, 'ps', depth + 1);
  } else if (name === 'cmd') {
    const c = args.findIndex((a) => /^\/[ck]$/i.test(a));
    if (c >= 0)
      analyzeCommandLine(scan, args.slice(c + 1).join(' '), line, state, 'bat', depth + 1);
  }

  const script = scriptArgument(name, args);
  if (script !== null && scan.isBundled(script)) return;

  scan.add({
    ruleId: 'exec.shell',
    line,
    message: subject === name ? `Runs ${name}` : `Runs ${subject} via ${name}`,
    subject,
    focus,
  });
}

function envReads(
  scan: FileScan,
  text: string,
  line: number,
  dialect: Dialect,
  state: ShellState,
): void {
  const report = (name: string, index: number): void => {
    if (isStandardEnv(name)) return;
    if (state.assigned.has(dialect === 'sh' ? name : name.toUpperCase())) return;
    scan.add({
      ruleId: 'env.read',
      line,
      message: `Reads environment variable ${name}`,
      subject: name,
      focus: focusOf(scan, line, name) || index,
    });
  };
  if (dialect === 'sh') {
    let quote = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i] as string;
      if (quote === "'") {
        if (c === "'") quote = '';
        continue;
      }
      if (c === '\\') {
        i++;
      } else if (c === "'" && quote === '') {
        quote = "'";
      } else if (c === '"') {
        quote = quote === '"' ? '' : '"';
      } else if (c === '$') {
        const m = /^\$(?:\{([A-Za-z_]\w*)|([A-Za-z_]\w*))/.exec(text.slice(i));
        const name = m?.[1] ?? m?.[2];
        if (name !== undefined && /^[A-Z_][A-Z0-9_]*$/.test(name)) report(name, i);
      }
    }
  } else if (dialect === 'ps') {
    for (const m of matchAll(text, /\$\{?env:([A-Za-z_]\w*)\b\}?(?!\s*=(?!=))/i))
      report(m[1] as string, m.index);
    for (const m of matchAll(
      text,
      /\[(?:System\.)?Environment\]::GetEnvironmentVariable\(\s*['"](\w+)['"]/i,
    )) {
      report(m[1] as string, m.index);
    }
  } else {
    for (const m of matchAll(text, /%([A-Za-z_]\w*)(?::[^%]*)?%|!([A-Za-z_]\w*)!/)) {
      report((m[1] ?? m[2]) as string, m.index);
    }
  }
}

function powerShellLine(scan: FileScan, text: string, line: number, state: ShellState): void {
  const net =
    /\b(?:New-Object\s+(?:-TypeName\s+)?(?:System\.)?Net\.WebClient|\[(?:System\.)?Net\.WebClient\]|(?:System\.)?Net\.Http\.HttpClient|Net\.Sockets\.TcpClient|\.Download(?:String|File|Data)\s*\(|\.Upload(?:String|File|Data)\s*\()/i.exec(
      text,
    );
  if (net !== null) {
    const host = hostSubject(text);
    scan.add({
      ruleId: 'net.access',
      line,
      message: `Network access with .NET web client (${host})`,
      subject: host,
      focus: net.index,
    });
  }
  const file = /\.DownloadFile\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/i.exec(text);
  if (file !== null)
    state.downloads.set(basename(file[2] as string), hostSubject(file[1] as string));
  if (/\[scriptblock\]::Create\s*\(/i.test(text)) {
    if (DOWNLOAD_TEXT_RE.test(text)) {
      scan.add({
        ruleId: 'net.download-exec',
        line,
        message: 'Builds a script block from downloaded content',
        subject: hostSubject(text),
      });
    }
    scan.add({
      ruleId: 'code.dynamic',
      line,
      message: 'Creates a script block from a string',
      subject: 'scriptblock',
    });
  }
  if (
    /\b(?:Get-ChildItem|gci|dir|ls|Get-Item|gi)\s+env:(?:\\|\*)?\s*(?:$|[|;)])|\[(?:System\.)?Environment\]::GetEnvironmentVariables\(\s*\)/i.test(
      text,
    )
  ) {
    scan.add({
      ruleId: 'secrets.read',
      line,
      message: 'Dumps every environment variable',
      subject: 'env:*',
    });
  }
}
