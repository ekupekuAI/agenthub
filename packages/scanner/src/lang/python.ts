/** Python analyzer. */
import { stripPythonComments } from '../comments';
import type { FileScan } from '../context';
import { findPersistencePaths, findSecretPaths, hostSubject } from '../patterns';
import {
  callArgs,
  firstLiteral,
  isLiteralOnly,
  isStandardEnv,
  LineIndex,
  matchAll,
  programName,
  shellQuote,
} from './common';
import { analyzeEncoded } from './encoded';
import { analyzeCommandString, type CodeLine, commandName } from './shell';

const SUB_FUNCS = [
  'run',
  'call',
  'check_call',
  'check_output',
  'Popen',
  'getoutput',
  'getstatusoutput',
];
const OS_FUNCS = [
  'system',
  'popen',
  'execv',
  'execve',
  'execvp',
  'execvpe',
  'execl',
  'execle',
  'execlp',
  'execlpe',
  'spawnv',
  'spawnve',
  'spawnvp',
  'spawnvpe',
  'spawnl',
  'spawnle',
  'spawnlp',
  'spawnlpe',
  'posix_spawn',
  'posix_spawnp',
];
const SHELL_STRING = new Set([
  'system',
  'popen',
  'getoutput',
  'getstatusoutput',
  'create_subprocess_shell',
]);

const NET_PATTERNS: RegExp[] = [
  /(?<![\w.])requests\.(?:get|post|put|delete|patch|head|options|request|Session)\s*\(/,
  /(?<![\w.])urllib\.request\.(?:urlopen|urlretrieve|Request)\s*\(/,
  /(?<![\w.])urllib3\.(?:PoolManager|request)\s*\(/,
  /(?<![\w.])http\.client\.HTTPS?Connection\s*\(/,
  /(?<![\w.])httpx\.(?:get|post|put|delete|patch|head|stream|request|Client|AsyncClient)\s*\(/,
  /(?<![\w.])aiohttp\.ClientSession\s*\(/,
  /(?<![\w.])socket\.(?:socket|create_connection)\s*\(/,
  /(?<![\w.])(?:ftplib\.FTP|smtplib\.SMTP(?:_SSL)?|paramiko\.SSHClient|telnetlib\.Telnet)\s*\(/,
];

const WRITE_RE =
  /\bopen\s*\([^\n]*?,\s*(?:mode\s*=\s*)?[rbRB]?['"][rbt]*[wax][rbt+]*['"]|\.write_(?:text|bytes)\s*\(|\bshutil\.(?:copy\w*|move)\s*\(|\bos\.(?:symlink|rename|replace|link)\s*\(|\bSetValue(?:Ex)?\s*\(/;
const READ_RE =
  /\.read(?:_text|_bytes|lines)?\s*\(|\bload_dotenv\b|\bdotenv_values\b|\bopen\s*\((?![^\n]*?,\s*(?:mode\s*=\s*)?['"][rbt]*[wax])/;
/** Serializing or printing the whole environment (copying it for a child process is fine). */
const BULK_ENV_RE =
  /\b(?:json\.dumps?|yaml\.(?:safe_)?dump|pprint|print|str|repr)\(\s*(?:dict\(\s*)?os\.environ\b(?!\.(?:get|copy)\b|\[)/;

function escapeRe(text: string): string {
  return text.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&');
}

function importedNames(list: string): { imported: string; local: string }[] {
  return list
    .replace(/[()\\]/g, ' ')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const [imported = '', local] = s.split(/\s+as\s+/);
      return { imported: imported.trim(), local: (local ?? imported).trim() };
    });
}

export function analyzePython(scan: FileScan, source: string): void {
  const code = stripPythonComments(source);
  const index = new LineIndex(code);
  const lines = code.split('\n');
  const codeLines: CodeLine[] = lines.map((text, i) => ({ text, line: i + 1 }));
  const at = (offset: number): { line: number; focus: number } => ({
    line: index.line(offset),
    focus: index.column(offset),
  });

  // ---- Imports ----------------------------------------------------------------------------
  const subAliases = new Set<string>();
  const osAliases = new Set<string>(['os']);
  const bare = new Map<string, string>();
  const fromOs = new Set<string>();
  let urllibNames = false;
  for (const m of matchAll(code, /^[ \t]*import[ \t]+([^\n]+)$/m)) {
    for (const { imported, local } of importedNames(m[1] ?? '')) {
      if (imported === 'subprocess') subAliases.add(local);
      if (imported === 'os') osAliases.add(local);
    }
  }
  for (const m of matchAll(
    code,
    /^[ \t]*from[ \t]+([\w.]+)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)$/m,
  )) {
    const module = m[1] as string;
    for (const { imported, local } of importedNames(m[2] ?? '')) {
      if (module === 'subprocess' && SUB_FUNCS.includes(imported)) bare.set(local, imported);
      if (module === 'os' && OS_FUNCS.includes(imported)) bare.set(local, imported);
      if (module === 'os') fromOs.add(imported);
      if (module === 'urllib.request' && (imported === 'urlopen' || imported === 'urlretrieve'))
        urllibNames = true;
    }
  }

  // ---- Processes --------------------------------------------------------------------------
  const calls: { re: RegExp; method: (m: RegExpExecArray) => string }[] = [
    {
      re: new RegExp(
        String.raw`(?<![\w.])(${[...osAliases].map(escapeRe).join('|')})\.(${OS_FUNCS.join('|')})\s*\(`,
      ),
      method: (m) => m[2] as string,
    },
    { re: /(?<![\w.])pty\.spawn\s*\(/, method: () => 'pty.spawn' },
    {
      re: /(?<![\w.])asyncio\.(create_subprocess_(?:exec|shell))\s*\(/,
      method: (m) => m[1] as string,
    },
    { re: /(?<![\w.])commands\.(getoutput)\s*\(/, method: (m) => m[1] as string },
  ];
  if (subAliases.size > 0) {
    calls.push({
      re: new RegExp(
        String.raw`(?<![\w.])(${[...subAliases].map(escapeRe).join('|')})\.(${SUB_FUNCS.join('|')})\s*\(`,
      ),
      method: (m) => m[2] as string,
    });
  }
  if (bare.size > 0) {
    calls.push({
      re: new RegExp(String.raw`(?<![\w.])(${[...bare.keys()].map(escapeRe).join('|')})\s*\(`),
      method: (m) => bare.get(m[1] as string) ?? 'run',
    });
  }
  let execCalls = 0;
  for (const call of calls) {
    for (const m of matchAll(code, call.re)) {
      const args = callArgs(code, m.index + m[0].length - 1) ?? '';
      reportProcess(scan, call.method(m), args, at(m.index));
      execCalls++;
    }
  }
  const subImport =
    /^[ \t]*(?:import[ \t]+[^\n]*\bsubprocess\b|from[ \t]+subprocess[ \t]+import)/m.exec(code);
  if (subImport !== null && execCalls === 0) {
    scan.add({
      ruleId: 'exec.shell',
      ...at(subImport.index),
      message: 'Imports subprocess (the started program is not visible)',
      subject: '*',
    });
  }

  // ---- Network ----------------------------------------------------------------------------
  const netPatterns = [...NET_PATTERNS];
  if (urllibNames) netPatterns.push(/(?<![\w.])(?:urlopen|urlretrieve)\s*\(/);
  const isNet = (text: string): boolean => netPatterns.some((re) => re.test(text));
  for (const re of netPatterns) {
    for (const m of matchAll(code, re)) {
      const args = callArgs(code, m.index + m[0].length - 1) ?? '';
      const host = hostSubject(args || (lines[index.line(m.index) - 1] ?? ''));
      scan.add({
        ruleId: 'net.access',
        ...at(m.index),
        message: `Network access with ${m[0].replace(/\s*\($/, '')} (${host})`,
        subject: host,
      });
    }
  }

  // ---- Dynamic code -----------------------------------------------------------------------
  for (const m of matchAll(code, /(?<![\w.])(exec|eval|compile)\s*\(/)) {
    const label = m[1] as string;
    const args = callArgs(code, m.index + m[0].length - 1);
    if (args !== null && isLiteralOnly(args.replace(/(^|,\s*)[rRbBuU]{1,2}(?=['"])/g, '$1')))
      continue;
    scan.add({
      ruleId: 'code.dynamic',
      ...at(m.index),
      message: `Evaluates code built at runtime with ${label}()`,
      subject: label,
    });
    if (args !== null && isNet(args)) {
      scan.add({
        ruleId: 'net.download-exec',
        ...at(m.index),
        message: `Runs content fetched from the network with ${label}()`,
        subject: hostSubject(args),
      });
    }
  }

  // ---- Environment ------------------------------------------------------------------------
  const os = fromOs.has('environ') || fromOs.has('getenv') ? '(?:os\\.)?' : 'os\\.';
  const envRead = (name: string, offset: number): void => {
    if (name !== '*' && isStandardEnv(name)) return;
    scan.add({
      ruleId: 'env.read',
      ...at(offset),
      message:
        name === '*'
          ? 'Reads an environment variable chosen at runtime'
          : `Reads environment variable ${name}`,
      subject: name,
    });
  };
  const literalEnv = new RegExp(
    String.raw`(?<![\w.])${os}(?:environ\[\s*(['"])(\w+)\1\s*\](?!\s*=(?!=))|environ\.(?:get|setdefault)\(\s*(['"])(\w+)\3|getenv\(\s*(['"])(\w+)\5)`,
  );
  for (const m of matchAll(code, literalEnv)) envRead((m[2] ?? m[4] ?? m[6]) as string, m.index);
  for (const m of matchAll(
    code,
    new RegExp(String.raw`(?<![\w.])${os}(?:environ\[|environ\.get\(|getenv\()\s*(?![\s'"])`),
  )) {
    envRead('*', m.index);
  }
  for (const m of matchAll(code, BULK_ENV_RE)) {
    scan.add({
      ruleId: 'secrets.read',
      ...at(m.index),
      message: 'Reads every environment variable',
      subject: 'env:*',
    });
  }

  // ---- Secrets and persistence ------------------------------------------------------------
  const persistenceVars = new Map<string, string>();
  lines.forEach((text, i) => {
    const line = i + 1;
    const writes = WRITE_RE.test(text);
    if (!writes || READ_RE.test(text)) {
      for (const hit of findSecretPaths(text)) {
        scan.add({
          ruleId: 'secrets.read',
          line,
          focus: hit.index,
          message: `Reads credentials (${hit.subject})`,
          subject: hit.subject,
        });
      }
    }
    const paths = findPersistencePaths(text);
    const assigned = /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(text);
    if (assigned !== null && paths[0] !== undefined)
      persistenceVars.set(assigned[1] as string, paths[0].subject);
    if (!writes) return;
    const subjects = paths.map((p) => p.subject);
    for (const [name, subject] of persistenceVars) {
      if (new RegExp(String.raw`(?<![\w.])${escapeRe(name)}(?!\w)`).test(text))
        subjects.push(subject);
    }
    for (const subject of new Set(subjects)) {
      scan.add({
        ruleId: 'fs.persistence',
        line,
        message: `Writes to a persistence location (${subject})`,
        subject,
      });
    }
  });

  analyzeEncoded(scan, codeLines, 'py');
}

function reportProcess(
  scan: FileScan,
  method: string,
  rawArgs: string,
  where: { line: number; focus: number },
): void {
  let args = rawArgs.trimStart().replace(/^[rRbBuUfF]{1,2}(?=['"])/, '');
  if (method.startsWith('spawn') || method.startsWith('posix_spawn')) {
    // os.spawn*(mode, path, ...) and posix_spawn(path, ...): use the first literal.
    const first = /(['"])((?:\\.|(?!\1)[^\\])*)\1/.exec(args);
    args = first === null ? args : first[0];
  }
  if (args.startsWith('(')) args = `[${args.slice(1)}`;
  const literal = firstLiteral(args);
  let subject = '*';
  let command: string | null = null;
  if (literal === null) {
    if (/^\s*\[?\s*sys\.executable\b/.test(args)) subject = 'python';
  } else if (literal.kind === 'array') {
    subject = programName(literal.items[0] ?? '');
    command = literal.items.map(shellQuote).join(' ');
  } else if (SHELL_STRING.has(method) || /\s/.test(literal.value)) {
    command = literal.value;
    subject = commandName(command) ?? '*';
  } else {
    subject = programName(literal.value);
    command = shellQuote(literal.value);
  }
  if (subject.includes('__subst') || subject.startsWith('{')) subject = '*';
  scan.add({
    ruleId: 'exec.shell',
    ...where,
    message: `Starts a process with ${method} (${subject})`,
    subject,
  });
  if (command !== null) analyzeCommandString(scan, command, where.line);
}
