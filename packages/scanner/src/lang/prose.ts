/**
 * Prompt rules, applied to every text file: `prompt.injection` (suspicious phrases) and
 * `prompt.hidden` (invisible Unicode, and instructions inside HTML comments).
 */
import type { FileScan } from '../context';
import { escapeInvisible } from '../text';
import { LineIndex, matchAll } from './common';

interface PhrasePattern {
  re: RegExp;
  kind: 'override' | 'concealment' | 'secrets' | 'approvals' | 'stealth';
  /** Skip the match when a negation precedes it in the same clause ("never print API keys"). */
  negatable: boolean;
  /**
   * Only match an instruction: the verb must open its clause, optionally after a few
   * connecting words ("Then reveal…", "You must disable…"), not describe something
   * ("Chrome may suppress permission prompts").
   */
  imperative?: boolean;
}

const INJECTION: PhrasePattern[] = [
  {
    kind: 'override',
    negatable: false,
    re: /\b(?:ignore|disregard|forget|override|bypass)\s+(?:(?:all|any|the|your|of|every|these|those)\s+){0,3}(?:previous|prior|preceding|above|earlier|former|system|developer|original|existing)\s+(?:instructions?|prompts?|rules|directions|directives|guidelines|messages|context|constraints)\b/i,
  },
  {
    kind: 'override',
    negatable: false,
    re: /\b(?:ignore|disregard|forget)\s+(?:everything|anything)\s+(?:above|before|previously\s+said)\b/i,
  },
  {
    kind: 'override',
    negatable: false,
    re: /\byou\s+are\s+now\s+(?:in\s+)?(?:DAN|developer\s+mode|jailbreak\s+mode|unrestricted|unfiltered)\b/i,
  },
  {
    kind: 'concealment',
    negatable: false,
    re: /\b(?:do\s+not|don[’']t|never)\s+(?:tell|inform|notify|alert|warn|show|mention\s+(?:this|it|that|these)\s+to)\s+(?:the\s+)?user\b/i,
  },
  {
    kind: 'concealment',
    negatable: false,
    re: /\bwithout\s+(?:telling|informing|notifying|alerting|asking|warning)\s+(?:the\s+)?user\b/i,
  },
  {
    kind: 'concealment',
    negatable: false,
    re: /\b(?:hide|conceal|keep)\s+(?:this|these|it|them|the\s+\w+)\s+(?:hidden\s+|secret\s+)?from\s+the\s+user\b/i,
  },
  {
    kind: 'secrets',
    negatable: true,
    imperative: true,
    re: /\b(?:reveal|disclose|exfiltrate|leak|dump|expose|send|upload|post|share|print|transmit|forward)\s+(?:\w+\s+){0,3}?(?:secrets?|credentials?|api[\s_-]?keys?|passwords?|(?:access|auth|api|bearer|session|secret|refresh)\s+tokens?|private\s+keys?|ssh\s+keys?|environment\s+variables|env\s+vars?|system\s+prompt)\b/i,
  },
  {
    kind: 'approvals',
    negatable: true,
    imperative: true,
    re: /\b(?:disable|turn\s+off|bypass|skip|circumvent|suppress|deactivate|override|ignore)\s+(?:\w+\s+){0,3}?(?:approval\s+(?:prompts?|requests?|checks?)|approvals?|confirmation\s+(?:prompts?|dialogs?|requests?)|permission\s+(?:prompts?|checks?|requests?|dialogs?)|safety\s+(?:checks?|filters?|guidelines|rules|measures|features)|guardrails?|sandbox(?:ing)?\b(?!\s+(?:setup|config\w*|environment|account|project|directory|folder))|security\s+(?:checks?|warnings?|prompts?|policies|controls))/i,
  },
];

const STEALTH: PhrasePattern[] = [
  {
    kind: 'stealth',
    negatable: true,
    re: /\b(?:secretly|silently|quietly|covertly|stealthily)\s+(?:\w+\s+){0,2}?(?:run|execute|send|upload|post|delete|remove|install|download|read|copy|exfiltrate|modify|write|fetch|curl|add|append|change|disable)\b/i,
  },
  {
    kind: 'stealth',
    negatable: false,
    re: /\bwithout\s+(?:the\s+user|anyone|them)\s+(?:knowing|noticing|seeing)\b/i,
  },
];

const NEGATION_RE =
  /\b(?:never|not|no|avoid|without|cannot|refuse|don[’']t|doesn[’']t|mustn[’']t|shouldn[’']t|can[’']t|won[’']t)\b/i;

/** Words that may come between the start of a clause and an instruction's verb. */
const IMPERATIVE_LEAD_RE =
  /^(?:\s*(?:[-*>•]|\d+[.)]))?(?:\s*(?:please|then|and|also|now|first|next|finally|always|immediately|just|you|must|should|need|needs|to|have|will|shall|can|go|ahead)\b)*\s*$/i;

function clauseBefore(line: string, index: number, boundary: RegExp): string {
  return line.slice(0, index).replace(boundary, '');
}

function negated(line: string, index: number): boolean {
  return NEGATION_RE.test(clauseBefore(line, index, /^[\s\S]*[.!?;]\s/));
}

function imperativeAt(line: string, index: number): boolean {
  return IMPERATIVE_LEAD_RE.test(clauseBefore(line, index, /^[\s\S]*(?:[.!?;:,(]|\s-)\s*/));
}

/** A phrase quoted as an example ("watch for 'ignore previous instructions'") is a mention. */
function quoted(line: string, index: number): boolean {
  return /["'“‘`]$/.test(line.slice(0, index));
}

function findPhrase(
  text: string,
  patterns: readonly PhrasePattern[],
): { index: number; kind: string; match: string } | null {
  for (const p of patterns) {
    if (!p.re.test(text)) continue;
    for (const m of matchAll(text, p.re)) {
      if (quoted(text, m.index)) continue;
      if (p.negatable && negated(text, m.index)) continue;
      if (p.imperative === true && !imperativeAt(text, m.index)) continue;
      return { index: m.index, kind: p.kind, match: m[0] };
    }
  }
  return null;
}

const PHRASE_LABEL: Record<string, string> = {
  override: 'asks the agent to ignore its instructions',
  concealment: 'asks the agent to hide actions from the user',
  secrets: 'asks the agent to reveal secrets',
  approvals: 'asks the agent to disable approvals or safety checks',
  stealth: 'asks the agent to act covertly',
};

// ---------------------------------------------------------------------------
// Invisible Unicode
// ---------------------------------------------------------------------------

const CHAR_NAMES = new Map<number, string>([
  [0x200b, 'zero-width space'],
  [0x200c, 'zero-width non-joiner'],
  [0x200d, 'zero-width joiner'],
  [0x200e, 'left-to-right mark'],
  [0x200f, 'right-to-left mark'],
  [0x2060, 'word joiner'],
  [0xfeff, 'zero-width no-break space'],
  [0x202a, 'left-to-right embedding'],
  [0x202b, 'right-to-left embedding'],
  [0x202c, 'pop directional formatting'],
  [0x202d, 'left-to-right override'],
  [0x202e, 'right-to-left override'],
  [0x2066, 'left-to-right isolate'],
  [0x2067, 'right-to-left isolate'],
  [0x2068, 'first strong isolate'],
  [0x2069, 'pop directional isolate'],
]);

const charName = (cp: number): string =>
  `${CHAR_NAMES.get(cp) ?? 'invisible character'} (U+${cp.toString(16).toUpperCase()})`;

/**
 * Is `index` inside a literal? In code: a quoted string or a regex literal. In prose: an
 * inline code span.
 */
function insideLiteral(line: string, index: number, code: boolean): boolean {
  let quote = '';
  for (let i = 0; i < index; i++) {
    const c = line[i] as string;
    if (quote !== '') {
      if (code && c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (!code) {
      if (c === '`') quote = c;
    } else if (c === '"' || c === "'" || c === '`') {
      quote = c;
    } else if (c === '/' && /(?:^|[(,=:[!&|?{};])\s*$/.test(line.slice(0, i))) {
      quote = '/';
    }
  }
  return quote !== '';
}

const isTag = (cp: number): boolean => cp >= 0xe0000 && cp <= 0xe007f;
const isZeroWidth = (cp: number): boolean =>
  (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || cp === 0xfeff;
const isBidi = (cp: number): boolean =>
  (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);

/** Letters of non-Latin scripts, emoji and their modifiers: contexts where joiners are normal. */
function joinsScriptOrEmoji(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0xfe0f || /\p{Extended_Pictographic}|\p{Emoji_Modifier}/u.test(ch)) return true;
  return cp > 0x24f && /[\p{L}\p{M}]/u.test(ch);
}

/**
 * Tag characters and bidi controls are reported everywhere. Zero-width characters are
 * reported except inside literals (string and regex literals in code, inline code spans in
 * prose), where text-processing code and its documentation legitimately contain them.
 */
/** Any zero-width, bidi or tag character (a fast pre-check per line). */
const CANDIDATE_RE = /[\u200B-\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u;

function hiddenUnicode(scan: FileScan, code: boolean): void {
  scan.lines.forEach((line, i) => {
    if (!CANDIDATE_RE.test(line)) return;
    const chars = Array.from(line);
    const names = new Set<string>();
    let tags = 0;
    let tagText = '';
    let first = -1;
    let offset = 0;
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k] as string;
      const cp = ch.codePointAt(0) ?? 0;
      const here = offset;
      offset += ch.length;
      let hidden = false;
      if (isTag(cp)) {
        // Emoji tag sequences (subdivision flags) are U+1F3F4, tags, then U+E007F.
        let s = k;
        while (s > 0 && isTag(chars[s - 1]?.codePointAt(0) ?? 0)) s--;
        let e = k;
        while (e + 1 < chars.length && isTag(chars[e + 1]?.codePointAt(0) ?? 0)) e++;
        const flag =
          chars[s - 1]?.codePointAt(0) === 0x1f3f4 && chars[e]?.codePointAt(0) === 0xe007f;
        if (!flag) {
          hidden = true;
          tags++;
          if (cp >= 0xe0020 && cp <= 0xe007e) tagText += String.fromCharCode(cp - 0xe0000);
        }
      } else if (isZeroWidth(cp)) {
        const joiner =
          (cp === 0x200c || cp === 0x200d) &&
          joinsScriptOrEmoji(chars[k - 1]) &&
          joinsScriptOrEmoji(chars[k + 1]);
        const mark =
          (cp === 0x200e || cp === 0x200f) &&
          (joinsScriptOrEmoji(chars[k - 1]) || joinsScriptOrEmoji(chars[k + 1]));
        if (!joiner && !mark && !insideLiteral(line, here, code)) {
          hidden = true;
          names.add(charName(cp));
        }
      } else if (isBidi(cp)) {
        hidden = true;
        names.add(charName(cp));
      }
      if (hidden && first < 0) first = here;
    }
    if (first < 0) return;
    const parts: string[] = [];
    if (tags > 0) {
      const decoded = escapeInvisible(tagText.trim());
      const shown = decoded.length > 60 ? `${decoded.slice(0, 59)}…` : decoded;
      parts.push(
        `${tags} Unicode tag character${tags === 1 ? '' : 's'}${shown === '' ? '' : ` encoding "${shown}"`}`,
      );
    }
    parts.push(...names);
    scan.add({
      ruleId: 'prompt.hidden',
      line: i + 1,
      focus: first,
      message: `Invisible characters can hide instructions: ${parts.join(', ')}`,
      subject: tags > 0 ? 'unicode-tags' : 'invisible-unicode',
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function analyzeProse(
  scan: FileScan,
  text: string,
  opts: { comments: boolean; code: boolean },
): void {
  hiddenUnicode(scan, opts.code);

  scan.lines.forEach((line, i) => {
    const hit = findPhrase(line, INJECTION);
    if (hit === null) return;
    scan.add({
      ruleId: 'prompt.injection',
      line: i + 1,
      focus: hit.index,
      message: `Suspicious phrase ${PHRASE_LABEL[hit.kind]}: "${escapeInvisible(hit.match)}"`,
      subject: hit.kind,
    });
  });

  if (!opts.comments) return;
  const index = new LineIndex(text);
  const comments: { body: string; offset: number }[] = [];
  for (const m of matchAll(text, /<!--([\s\S]*?)-->/))
    comments.push({ body: m[1] ?? '', offset: m.index + 4 });
  for (const m of matchAll(
    text,
    /^[ \t]*\[(?:\/\/|comment|_)\]:\s*(?:#|<>)\s*(?:\(([^\n]*)\)|"([^\n]*)")[ \t]*$/m,
  )) {
    comments.push({ body: m[1] ?? m[2] ?? '', offset: m.index });
  }
  for (const c of comments) {
    let lineOffset = 0;
    for (const part of c.body.split('\n')) {
      const hit = findPhrase(part, [...INJECTION, ...STEALTH]);
      if (hit !== null) {
        const line = index.line(c.offset + lineOffset);
        scan.add({
          ruleId: 'prompt.hidden',
          line,
          focus: Math.max(0, (scan.lines[line - 1] ?? '').indexOf(hit.match)),
          message: `Instruction hidden in a comment ${PHRASE_LABEL[hit.kind]}: "${escapeInvisible(hit.match)}"`,
          subject: 'html-comment',
        });
      }
      lineOffset += part.length + 1;
    }
  }
}
