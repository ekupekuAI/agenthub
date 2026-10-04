/** Helpers shared by the language analyzers. */

/** Environment variables every OS sets; reading them is not reported by `env.read`. */
const STANDARD_ENV = new Set([
  'HOME',
  'PWD',
  'OLDPWD',
  'PATH',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'IFS',
  'RANDOM',
  'LINENO',
  'SECONDS',
  'UID',
  'EUID',
  'PPID',
  'HOSTNAME',
  'HOSTTYPE',
  'OSTYPE',
  'MACHTYPE',
  'BASH',
  'BASH_SOURCE',
  'BASH_VERSION',
  'BASH_REMATCH',
  'BASH_LINENO',
  'FUNCNAME',
  'PIPESTATUS',
  'REPLY',
  'OPTARG',
  'OPTIND',
  'OPTERR',
  'SHLVL',
  'TERM',
  'COLUMNS',
  'LINES',
  'LANG',
  'LC_ALL',
  'PS1',
  'PS2',
  'PS4',
  'ZSH_VERSION',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMPUTERNAME',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'PATHEXT',
  'COMSPEC',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'PUBLIC',
  'ALLUSERSPROFILE',
  'CD',
  'DATE',
  'TIME',
  'ERRORLEVEL',
  'CMDCMDLINE',
  // Locations the agent itself provides to skills.
  'CLAUDE_PLUGIN_ROOT',
  'CLAUDE_PROJECT_DIR',
]);

export function isStandardEnv(name: string): boolean {
  return STANDARD_ENV.has(name.toUpperCase());
}

/** Program name as used for `exec` subjects: basename, lower case, no Windows extension. */
export function programName(word: string): string {
  let name = word.replace(/^@/, '').replace(/["']/g, '');
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).toLowerCase();
  name = name.replace(/\.(?:exe|cmd|bat|com)$/, '');
  if (/^python\d+(?:\.\d+)*$/.test(name) || name === 'py') return 'python';
  if (/^pip\d+(?:\.\d+)*$/.test(name)) return 'pip';
  if (name === 'nodejs') return 'node';
  return name;
}

export interface Literal {
  value: string;
  kind: 'string' | 'template' | 'array';
  /** All plain string literals of an array argument, in order. */
  items: string[];
}

/** Reads a quoted literal starting at `text[0]`; returns the value and the index after it. */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '\\') {
      value += text[i + 1] ?? '';
      i++;
    } else if (c === quote) {
      return { value, end: i + 1 };
    } else if (quote === '`' && c === '$' && text[i + 1] === '{') {
      const close = text.indexOf('}', i);
      if (close < 0) return null;
      value += '__SUBST__';
      i = close;
    } else {
      value += c;
    }
  }
  return null;
}

/** The first argument of a call when it is a string, template or array of strings. */
export function firstLiteral(args: string): Literal | null {
  const text = args.trimStart();
  const c = text[0];
  if (c === '"' || c === "'" || c === '`') {
    const q = readQuoted(text, 0);
    if (q === null) return null;
    return { value: q.value, kind: c === '`' ? 'template' : 'string', items: [q.value] };
  }
  if (c === '[') {
    const items: string[] = [];
    let i = 1;
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === ']') break;
      if (ch === '"' || ch === "'" || ch === '`') {
        const q = readQuoted(text, i);
        if (q === null) break;
        items.push(q.value);
        i = q.end;
      } else if (/[\s,]/.test(ch)) {
        i++;
      } else {
        // A non-literal element: keep what was read so far and stop.
        items.push('__SUBST__');
        break;
      }
    }
    const first = items[0];
    return first === undefined ? null : { value: first, kind: 'array', items };
  }
  return null;
}

/** True when every argument is a plain string literal (no interpolation). */
export function isLiteralOnly(args: string): boolean {
  return /^\s*(?:(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`)\s*(?:,\s*|\+\s*)?)*$/s.test(
    args,
  );
}

/** Text inside the parentheses that open at `open` (which must index a '('), or null. */
export function callArgs(text: string, open: number, limit = 2000): string | null {
  let depth = 0;
  let quote = '';
  const end = Math.min(text.length, open + limit);
  for (let i = open; i < end; i++) {
    const c = text[i] as string;
    if (quote !== '') {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Maps string offsets to 1-based line numbers and columns. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') this.starts.push(i + 1);
  }

  line(offset: number): number {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  column(offset: number): number {
    return offset - (this.starts[this.line(offset) - 1] as number);
  }
}

/** Runs a global regex over text, yielding every match. */
export function* matchAll(text: string, re: RegExp): Generator<RegExpExecArray> {
  // Cheap rejection before compiling a global copy; most calls find nothing.
  re.lastIndex = 0;
  const any = re.test(text);
  re.lastIndex = 0;
  if (!any) return;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (let m = g.exec(text); m !== null; m = g.exec(text)) {
    yield m;
    if (m[0].length === 0) g.lastIndex++;
  }
}

/** Quotes a word for re-parsing as a POSIX shell command line. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
