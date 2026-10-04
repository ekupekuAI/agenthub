/** `code.obfuscated`: encoded payloads decoded at runtime, char-code arrays, packed code. */
import type { FileScan } from '../context';
import { BLOB_RE, DECODE_RE, looksLikeEncodedBlob } from '../patterns';
import { LineIndex, matchAll } from './common';
import type { CodeLine } from './shell';

const NUMBER_RUN_RE = /(?:(?:0x[0-9a-fA-F]+|\d+)\s*,\s*){19,}(?:0x[0-9a-fA-F]+|\d+)/;
const PACKER_RE = /\beval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[rd]\s*\)/;
const OBFUSCATOR_ID_RE = /\b_0x[0-9a-f]{4,6}\b/g;

export function analyzeEncoded(
  scan: FileScan,
  lines: readonly CodeLine[],
  lang: 'js' | 'py' | 'shell',
): void {
  const joined = lines.map((l) => l.text).join('\n');
  const index = new LineIndex(joined);
  const lineOf = (offset: number): number => lines[index.line(offset) - 1]?.line ?? 1;
  const at = (offset: number): { line: number; focus: number } => ({
    line: lineOf(offset),
    focus: index.column(offset),
  });

  const decoder = DECODE_RE.exec(joined);
  if (decoder !== null) {
    scan.markDecodes();
    const decodeLine = lineOf(decoder.index);
    for (const m of matchAll(joined, BLOB_RE)) {
      if (!looksLikeEncodedBlob(m[0])) continue;
      scan.add({
        ruleId: 'code.obfuscated',
        ...at(m.index),
        message: `${m[0].length}-character encoded blob decoded at runtime (decoder on line ${decodeLine})`,
        subject: 'encoded-blob',
      });
    }
  }

  if (lang === 'js') {
    const charCodes = /\bString\.fromCharCode\b/.exec(joined);
    if (charCodes !== null && NUMBER_RUN_RE.test(joined)) {
      scan.add({
        ruleId: 'code.obfuscated',
        ...at(charCodes.index),
        message: 'Builds a string from a long char-code array',
        subject: 'char-codes',
      });
    }
    const packed = PACKER_RE.exec(joined);
    if (packed !== null) {
      scan.add({
        ruleId: 'code.obfuscated',
        ...at(packed.index),
        message: 'Packed JavaScript (eval(function(p,a,c,k,e,…)))',
        subject: 'packed',
      });
    }
    const ids = joined.match(OBFUSCATOR_ID_RE) ?? [];
    if (ids.length >= 10) {
      scan.add({
        ruleId: 'code.obfuscated',
        ...at(joined.search(OBFUSCATOR_ID_RE)),
        message: `Obfuscator-style identifiers (${ids.length} × _0x…)`,
        subject: 'obfuscator',
      });
    }
  }

  if (lang === 'py') {
    const chr = /\bchr\s*\(|\bbytes(?:array)?\s*\(\s*\[/.exec(joined);
    if (chr !== null && NUMBER_RUN_RE.test(joined)) {
      scan.add({
        ruleId: 'code.obfuscated',
        ...at(chr.index),
        message: 'Builds a string from a long char-code list',
        subject: 'char-codes',
      });
    }
    const marshal = /\bmarshal\.loads\s*\(/.exec(joined);
    if (marshal !== null) {
      scan.add({
        ruleId: 'code.obfuscated',
        ...at(marshal.index),
        message: 'Loads compiled code objects with marshal.loads',
        subject: 'marshal',
      });
    }
  }
}
