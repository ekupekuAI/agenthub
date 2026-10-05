/**
 * Markdown analyzer.
 *
 * Prose is never scanned for code behavior: a URL in a link, a path in a sentence or the word
 * "execute" is not network access, a secret read or process execution. Fenced blocks are
 * low-trust examples; they count only when they are executable instructions:
 *
 * - blocks tagged as a shell (`bash`, `sh`, `console`, …), PowerShell or batch are analyzed
 *   like a script of that dialect, with the same rules and severities;
 * - untagged blocks are analyzed as shell only when most lines start with a known command;
 * - blocks in other languages (`js`, `python`, `json`, …) are illustrations and are skipped.
 *
 * Each block is its own unit for raising `code.dynamic` to high, while variables assigned in
 * any shell block are known to the others. Prompt rules run on the whole file (prose.ts).
 */
import { stripBatchComments, stripPowerShellComments, stripShellComments } from '../comments';
import type { FileScan } from '../context';
import { programName } from './common';
import { analyzeEncoded } from './encoded';
import { analyzeShell, type CodeLine, type Dialect, LAUNCHERS } from './shell';

const SH_INFO = new Set([
  '',
  'sh',
  'bash',
  'shell',
  'zsh',
  'ksh',
  'fish',
  'console',
  'terminal',
  'shell-session',
  'shellsession',
  'sh-session',
  'shellscript',
  'shell-script',
]);
const SESSION_INFO = new Set([
  'console',
  'terminal',
  'shell-session',
  'shellsession',
  'sh-session',
]);
const PS_INFO = new Set(['powershell', 'pwsh', 'ps1', 'ps', 'posh']);
const BAT_INFO = new Set(['bat', 'batch', 'cmd', 'dos', 'batchfile']);

export interface FencedBlock {
  info: string;
  dialect: Dialect | null;
  lines: CodeLine[];
}

/** Fenced code blocks (CommonMark backtick and tilde fences). */
export function fencedBlocks(lines: readonly string[]): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(lines[i] as string);
    if (open === null) {
      i++;
      continue;
    }
    const fence = open[1] as string;
    const info = (open[2] ?? '').toLowerCase().replace(/^\{\.?|\}$/g, '');
    const close = new RegExp(
      String.raw`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\s*$`,
    );
    const body: CodeLine[] = [];
    let j = i + 1;
    for (; j < lines.length && !close.test(lines[j] as string); j++) {
      body.push({ text: lines[j] as string, line: j + 1 });
    }
    const dialect: Dialect | null = SH_INFO.has(info)
      ? 'sh'
      : PS_INFO.has(info)
        ? 'ps'
        : BAT_INFO.has(info)
          ? 'bat'
          : null;
    blocks.push({ info, dialect, lines: body });
    i = j + 1;
  }
  return blocks;
}

/** Removes shell prompts; in session transcripts, lines without a prompt are output. */
function withoutPrompts(block: FencedBlock): CodeLine[] {
  const session = SESSION_INFO.has(block.info);
  return block.lines.map(({ text, line }) => {
    const prompt =
      block.dialect === 'ps' ? /^\s*PS(?: [^>]*)?>\s?/.exec(text) : /^\s*(?:\$|%|>)\s/.exec(text);
    if (prompt !== null) return { text: text.slice(prompt[0].length), line };
    return { text: session ? '' : text, line };
  });
}

/** Common commands, used to tell an untagged block of commands from other untagged text. */
const COMMON_COMMANDS = new Set([
  ...LAUNCHERS,
  ...['cd', 'ls', 'cat', 'echo', 'printf', 'git', 'gh', 'mkdir', 'cp', 'mv', 'rm', 'touch'],
  ...['chmod', 'export', 'source', 'sudo', 'env', 'eval', 'make', 'docker', 'kubectl', 'grep'],
  ...['find', 'tar', 'unzip', 'curl', 'wget', 'ssh', 'scp', 'npm', 'pnpm', 'yarn', 'pip', 'uv'],
  ...['pipx', 'brew', 'apt', 'apt-get', 'cargo', 'go', 'gem', 'choco', 'winget', 'scoop', 'iwr'],
  ...['irm', 'crontab', 'systemctl', 'launchctl', 'reg', 'schtasks'],
]);

/** An untagged block counts as commands when most of its lines start with a known command. */
export function looksLikeCommands(lines: readonly CodeLine[]): boolean {
  const words = lines
    .map((l) => l.text.trim())
    .filter((t) => t !== '' && !t.startsWith('#'))
    .map((t) => /^(?:sudo\s+)?(\S+)/.exec(t)?.[1] ?? '');
  if (words.length === 0) return false;
  const known = words.filter(
    (w) => COMMON_COMMANDS.has(programName(w)) || /^\.{1,2}\//.test(w) || /^[A-Za-z_]\w*=/.test(w),
  );
  return known.length * 2 >= words.length;
}

export function analyzeMarkdown(scan: FileScan): void {
  const prepared = fencedBlocks(scan.lines)
    .map((block) => ({ block, lines: withoutPrompts(block) }))
    .filter(
      ({ block, lines }) =>
        block.dialect !== null && (block.info !== '' || looksLikeCommands(lines)),
    )
    .map(({ block, lines }) => {
      const dialect = block.dialect as Dialect;
      const strip =
        dialect === 'sh'
          ? stripShellComments
          : dialect === 'ps'
            ? stripPowerShellComments
            : stripBatchComments;
      const stripped = strip(lines.map((l) => l.text).join('\n')).split('\n');
      return { dialect, code: lines.map((l, k) => ({ text: stripped[k] ?? '', line: l.line })) };
    });
  // Variables assigned in one block are commonly used in later ones.
  const shellLines = prepared.filter((p) => p.dialect === 'sh').flatMap((p) => p.code);
  prepared.forEach(({ dialect, code }, index) => {
    scan.scope = index + 1;
    analyzeShell(scan, code, dialect, dialect === 'sh' ? shellLines : code);
    analyzeEncoded(scan, code, 'shell');
  });
  scan.scope = 0;
}
