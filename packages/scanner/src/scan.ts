import type { Finding, ScanResult } from '@agenthub/core';
import { stripBatchComments, stripPowerShellComments, stripShellComments } from './comments';
import { FileScan } from './context';
import { extractFileExternals, type FileExternals, finishExternals } from './externals';
import { analyzeBinary } from './lang/binary';
import { analyzeEncoded } from './lang/encoded';
import { analyzeJavaScript } from './lang/javascript';
import { analyzePackageJson, analyzeRequirements } from './lang/manifests';
import { analyzeMarkdown } from './lang/markdown';
import { analyzeProse } from './lang/prose';
import { analyzePython } from './lang/python';
import { analyzeShell, type Dialect } from './lang/shell';
import { RULESET_DIGEST, SCANNER_VERSION } from './ruleset';
import { decodeText, splitLines } from './text';

export { RULESET_DIGEST, SCANNER_VERSION } from './ruleset';

export interface ScanFile {
  /** POSIX path relative to the skill root. */
  path: string;
  content: Uint8Array;
  /** Detected from the content when absent (UTF-8 without NUL bytes = text). */
  kind?: 'text' | 'binary';
}

export type Language = 'js' | 'py' | 'sh' | 'ps' | 'bat' | 'markdown' | 'text';

/** Picks the analyzer for a file from its extension, or from a `#!` line. */
export function languageOf(path: string, text: string): Language {
  const p = path.toLowerCase();
  if (/\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$/.test(p)) return 'js';
  if (/\.pyw?$/.test(p)) return 'py';
  if (/\.(?:sh|bash|zsh|ksh|command)$/.test(p)) return 'sh';
  if (/\.(?:ps1|psm1|psd1)$/.test(p)) return 'ps';
  if (/\.(?:bat|cmd)$/.test(p)) return 'bat';
  if (/\.(?:md|markdown|mdx)$/.test(p)) return 'markdown';
  if (text.startsWith('#!')) {
    const shebang = text.slice(0, text.indexOf('\n') >>> 0);
    if (/\b(?:node|deno|bun|tsx|ts-node)\b/.test(shebang)) return 'js';
    if (/\bpython[\d.]*\b/.test(shebang)) return 'py';
    if (/\b(?:pwsh|powershell)\b/.test(shebang)) return 'ps';
    if (/\b(?:ba|z|da|k|a)?sh\b/.test(shebang)) return 'sh';
  }
  return 'text';
}

const STRIP: Record<Dialect, (text: string) => string> = {
  sh: stripShellComments,
  ps: stripPowerShellComments,
  bat: stripBatchComments,
};

interface FileResult {
  findings: Finding[];
  externals: FileExternals | null;
}

function scanFile(file: ScanFile, packagePaths: ReadonlySet<string>): FileResult {
  let text: string | null = null;
  if (file.kind !== 'binary') {
    text = decodeText(file.content);
    if (text === null && file.kind === 'text') text = new TextDecoder().decode(file.content);
  }
  if (text === null) {
    const scan = new FileScan(file.path, [], packagePaths);
    analyzeBinary(scan, file.content);
    return { findings: scan.toFindings(), externals: null };
  }

  text = text.replace(/\r\n/g, '\n');
  const scan = new FileScan(file.path, splitLines(text), packagePaths);
  const language = languageOf(file.path, text);
  switch (language) {
    case 'js':
      analyzeJavaScript(scan, text);
      break;
    case 'py':
      analyzePython(scan, text);
      break;
    case 'sh':
    case 'ps':
    case 'bat': {
      const lines = STRIP[language](text)
        .split('\n')
        .map((t, i) => ({ text: t, line: i + 1 }));
      analyzeShell(scan, lines, language);
      analyzeEncoded(scan, lines, 'shell');
      break;
    }
    case 'markdown':
      analyzeMarkdown(scan);
      break;
    case 'text':
      break;
  }
  const base = file.path.slice(file.path.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'package.json') analyzePackageJson(scan, text);
  if (/^requirements[\w.-]*\.(?:txt|in)$/.test(base)) analyzeRequirements(scan);
  analyzeProse(scan, text, {
    comments: language === 'markdown' || language === 'text',
    code: language !== 'markdown' && language !== 'text',
  });
  return {
    findings: scan.toFindings(),
    externals: extractFileExternals(file.path, text, language),
  };
}

function compareFindings(a: Finding, b: Finding): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  const sa = a.subject ?? '';
  const sb = b.subject ?? '';
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/**
 * Scans a skill's files and reports what it finds, with its outbound references. Pure: it reads
 * only the given bytes and never executes, imports or fetches anything. It never claims a skill
 * is safe.
 */
export function scanPackage(files: readonly ScanFile[]): ScanResult {
  const packagePaths = new Set(files.map((f) => f.path));
  const results = files.map((f) => ({ path: f.path, result: scanFile(f, packagePaths) }));
  const extracted = finishExternals(
    results.flatMap(({ path, result }) =>
      result.externals === null ? [] : [{ path, result: result.externals }],
    ),
  );
  const findings = [
    ...results.flatMap(({ result }) => result.findings),
    ...extracted.findings,
  ].sort(compareFindings);
  return {
    scannerVersion: SCANNER_VERSION,
    rulesetDigest: RULESET_DIGEST,
    findings,
    externals: extracted.externals,
  };
}
