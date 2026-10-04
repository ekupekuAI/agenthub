/** JavaScript and TypeScript analyzer. */
import { stripJsComments } from '../comments';
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

const CP_MODULE = '[\'"](?:node:)?child_process[\'"]';
const CP_METHODS = ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork'];
const SHELL_STRING = new Set(['exec', 'execSync', 'execaCommand', 'execaCommandSync', '$']);

const NET_PATTERNS: RegExp[] = [
  /(?<![\w$.])(?:(?:globalThis|window|self)\.)?fetch\s*\(/,
  /(?<![\w$.])https?\.(?:request|get)\s*\(/,
  /(?<![\w$.])axios(?:\.(?:get|post|put|delete|patch|head|options|request|create))?\s*\(/,
  /\bnew\s+(?:WebSocket|EventSource|XMLHttpRequest)\s*\(/,
  /(?<![\w$.])(?:net|tls)\.(?:connect|createConnection)\s*\(/,
  /\bnew\s+net\.Socket\s*\(/,
  /(?<![\w$.])dgram\.createSocket\s*\(/,
  /(?<![\w$.])http2\.connect\s*\(/,
  /\bnavigator\.sendBeacon\s*\(/,
];

/** HTTP client libraries whose call names are too generic to match without an import. */
const NET_LIBRARIES: { module: string; call: RegExp }[] = [
  { module: 'got', call: /(?<![\w$.])got(?:\.\w+)?\s*\(/ },
  { module: 'ky', call: /(?<![\w$.])ky(?:\.\w+)?\s*\(/ },
  { module: 'superagent', call: /(?<![\w$.])superagent(?:\.\w+)?\s*\(/ },
  { module: 'request', call: /(?<![\w$.])request(?:\.\w+)?\s*\(/ },
  { module: 'undici', call: /(?<![\w$.])(?:request|stream)\s*\(/ },
];

const DYNAMIC_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /(?<![\w$.])eval\s*\(/, label: 'eval' },
  { re: /\bnew\s+Function\s*\(/, label: 'new Function' },
  { re: /(?<![\w$.])(?<!new\s+)Function\s*\(/, label: 'Function' },
  {
    re: /\bvm\.(?:runInNewContext|runInThisContext|runInContext|compileFunction)\s*\(/,
    label: 'vm',
  },
  { re: /\bnew\s+vm\.Script\s*\(/, label: 'vm.Script' },
];

const WRITE_RE =
  /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|cpSync|symlink|symlinkSync|rename|renameSync|outputFile|outputFileSync|writeJson|writeJsonSync)\s*\(|\bfs(?:\.promises)?\.(?:cp|writev?)\s*\(|\bopen(?:Sync)?\s*\([^\n]*['"](?:w|a|wx|ax|w\+|a\+|r\+)['"]/;
const READ_RE = /\b(?:readFile|readFileSync|createReadStream|readJson|readJsonSync)\s*\(|dotenv/;

/** Serializing or printing the whole environment (copying it for a child process is fine). */
const BULK_ENV_RE =
  /\bJSON\.stringify\(\s*(?:\{\s*\.\.\.)?process\.env\b|\b(?:console\.\w+|util\.inspect|inspect)\(\s*process\.env\s*[,)]|\bDeno\.env\.toObject\(\s*\)/;

function specifiers(list: string, separator: 'as' | ':'): { imported: string; local: string }[] {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const parts = s.split(separator === 'as' ? /\s+as\s+/ : /\s*:\s*/);
      const imported = (parts[0] ?? '').split('=')[0]?.trim() ?? '';
      const local = (parts[1] ?? imported).split('=')[0]?.trim() ?? imported;
      return { imported, local };
    });
}

function escapeRe(text: string): string {
  return text.replace(/[$.*+?^()[\]{}|\\]/g, '\\$&');
}

export function analyzeJavaScript(scan: FileScan, source: string): void {
  const code = stripJsComments(source);
  const index = new LineIndex(code);
  const lines = code.split('\n');
  const codeLines: CodeLine[] = lines.map((text, i) => ({ text, line: i + 1 }));
  const at = (offset: number): { line: number; focus: number } => ({
    line: index.line(offset),
    focus: index.column(offset),
  });
  const imports = (module: string): boolean =>
    new RegExp(
      String.raw`(?:from\s+|require\(\s*|import\(\s*|import\s+)['"]${escapeRe(module)}(?:\/[\w/]*)?['"]`,
    ).test(code);

  // ---- Processes (exec.shell) -------------------------------------------------------------
  const namespaces = new Set<string>(['child_process']);
  const named = new Map<string, string>();
  for (const m of matchAll(
    code,
    new RegExp(String.raw`import\s+\*\s+as\s+([\w$]+)\s+from\s+${CP_MODULE}`),
  )) {
    namespaces.add(m[1] as string);
  }
  for (const m of matchAll(
    code,
    new RegExp(String.raw`import\s+([\w$]+)\s*(?:,\s*\{([^}]*)\})?\s+from\s+${CP_MODULE}`),
  )) {
    namespaces.add(m[1] as string);
    for (const s of specifiers(m[2] ?? '', 'as')) named.set(s.local, s.imported);
  }
  for (const m of matchAll(
    code,
    new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s+${CP_MODULE}`),
  )) {
    for (const s of specifiers(m[1] ?? '', 'as')) named.set(s.local, s.imported);
  }
  for (const m of matchAll(
    code,
    new RegExp(
      String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?(?:require|import)\(\s*${CP_MODULE}\s*\)`,
    ),
  )) {
    namespaces.add(m[1] as string);
  }
  for (const m of matchAll(
    code,
    new RegExp(
      String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?(?:require|import)\(\s*${CP_MODULE}\s*\)`,
    ),
  )) {
    for (const s of specifiers(m[1] ?? '', ':')) named.set(s.local, s.imported);
  }
  for (const [local, imported] of named) if (!CP_METHODS.includes(imported)) named.delete(local);

  const calls: { re: RegExp; method: (m: RegExpExecArray) => string }[] = [
    {
      re: new RegExp(
        String.raw`(?<![\w$.])(${[...namespaces].map(escapeRe).join('|')})\s*\.\s*(${CP_METHODS.join('|')})\s*\(`,
      ),
      method: (m) => m[2] as string,
    },
    {
      re: new RegExp(
        String.raw`require\(\s*${CP_MODULE}\s*\)\s*\.\s*(${CP_METHODS.join('|')})\s*\(`,
      ),
      method: (m) => m[1] as string,
    },
    { re: /\bBun\.(spawn|spawnSync)\s*\(/, method: (m) => m[1] as string },
    { re: /\bDeno\.run\s*\(|\bnew\s+Deno\.Command\s*\(/, method: () => 'Deno.Command' },
  ];
  if (named.size > 0) {
    calls.push({
      re: new RegExp(String.raw`(?<![\w$.])(${[...named.keys()].map(escapeRe).join('|')})\s*\(`),
      method: (m) => named.get(m[1] as string) ?? 'exec',
    });
  }
  if (imports('execa')) {
    calls.push({
      re: /(?<![\w$.])(execa|execaSync|execaCommand|execaCommandSync|execaNode)\s*\(/,
      method: (m) => m[1] as string,
    });
  }
  const templateRunner =
    imports('zx') ||
    imports('execa') ||
    /import\s*\{[^}]*\$[^}]*\}\s*from\s*['"]bun['"]/.test(code);

  let execCalls = 0;
  for (const call of calls) {
    for (const m of matchAll(code, call.re)) {
      const method = call.method(m);
      const open = m.index + m[0].length - 1;
      const args = callArgs(code, open) ?? '';
      reportProcess(scan, method, args, at(m.index));
      execCalls++;
    }
  }
  if (templateRunner) {
    for (const m of matchAll(code, /(?<![\w$.])(?:Bun\.)?\$(?:\.sync)?`([^`]*)`/)) {
      reportProcess(scan, '$', `\`${m[1] ?? ''}\``, at(m.index));
      execCalls++;
    }
  }
  const cpImport = new RegExp(CP_MODULE).exec(code);
  if (cpImport !== null && execCalls === 0) {
    scan.add({
      ruleId: 'exec.shell',
      ...at(cpImport.index),
      message: 'Imports child_process (the started program is not visible)',
      subject: '*',
    });
  }

  // ---- Network ----------------------------------------------------------------------------
  const netPatterns = [...NET_PATTERNS];
  for (const lib of NET_LIBRARIES) if (imports(lib.module)) netPatterns.push(lib.call);
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
  for (const { re, label } of DYNAMIC_PATTERNS) {
    for (const m of matchAll(code, re)) {
      const args = callArgs(code, m.index + m[0].length - 1);
      if (args !== null && isLiteralOnly(args)) continue;
      scan.add({
        ruleId: 'code.dynamic',
        ...at(m.index),
        message: `Evaluates code built at runtime with ${label}`,
        subject: label,
      });
      if (args !== null && isNet(args)) {
        scan.add({
          ruleId: 'net.download-exec',
          ...at(m.index),
          message: `Evaluates content fetched from the network with ${label}`,
          subject: hostSubject(args),
        });
      }
    }
  }

  // ---- Environment ------------------------------------------------------------------------
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
  for (const m of matchAll(code, /\bprocess\.env\.([A-Za-z_$][\w$]*)(?![\w$])(?!\s*=(?!=))/))
    envRead(m[1] as string, m.index);
  for (const m of matchAll(code, /\bprocess\.env\[\s*(['"`])([^'"`]+)\1\s*\](?!\s*=(?!=))/))
    envRead(m[2] as string, m.index);
  for (const m of matchAll(code, /\bprocess\.env\[\s*(?!['"`\s])/)) envRead('*', m.index);
  for (const m of matchAll(code, /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/)) {
    for (const s of specifiers(m[1] ?? '', ':')) {
      if (!s.imported.startsWith('...')) envRead(s.imported, m.index);
    }
  }
  for (const m of matchAll(code, /\bDeno\.env\.get\(\s*['"](\w+)['"]/))
    envRead(m[1] as string, m.index);
  for (const m of matchAll(code, /\bBun\.env\.([A-Za-z_]\w*)/)) envRead(m[1] as string, m.index);
  for (const m of matchAll(code, BULK_ENV_RE)) {
    scan.add({
      ruleId: 'secrets.read',
      ...at(m.index),
      message: 'Reads every environment variable',
      subject: 'env:*',
    });
  }

  // ---- Secrets and persistence (line based) -----------------------------------------------
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
    if (paths[0] !== undefined) {
      const assigned = /(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=(?![=>])/.exec(text);
      if (assigned !== null) persistenceVars.set(assigned[1] as string, paths[0].subject);
    }
    if (!writes) return;
    const subjects = paths.map((p) => p.subject);
    for (const [name, subject] of persistenceVars) {
      if (new RegExp(String.raw`(?<![\w$.])${escapeRe(name)}(?![\w$])`).test(text))
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

  analyzeEncoded(scan, codeLines, 'js');
}

/** Reports one process start and analyzes its command line when it is visible. */
function reportProcess(
  scan: FileScan,
  method: string,
  args: string,
  where: { line: number; focus: number },
): void {
  const literal = firstLiteral(args);
  let subject = '*';
  let command: string | null = null;
  if (method === 'fork') {
    subject = 'node';
  } else if (literal === null) {
    if (/^\s*process\.(?:execPath|argv\[0\])/.test(args)) subject = 'node';
  } else if (SHELL_STRING.has(method)) {
    command = literal.value;
    subject = commandName(command) ?? '*';
  } else {
    const items = literal.kind === 'array' ? literal.items : literalItems(args);
    subject = programName(items[0] ?? literal.value);
    command = items.map(shellQuote).join(' ');
  }
  if (subject.includes('__subst')) subject = '*';
  scan.add({
    ruleId: 'exec.shell',
    ...where,
    message: `Starts a process with ${method} (${subject})`,
    subject,
  });
  if (command !== null) analyzeCommandString(scan, command, where.line);
}

/** String literals of `('prog', ['a', 'b'], {...})`, stopping at the options object. */
function literalItems(args: string): string[] {
  const head = args.split('{')[0] ?? '';
  return [...head.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2] ?? '');
}
