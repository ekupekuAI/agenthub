import type { ReactNode } from 'react';

/**
 * Renders SKILL.md text as React text nodes only: headings, paragraphs, lists, block quotes,
 * fenced code and inline code. Raw HTML, links and images are shown as literal text, never
 * interpreted. There is deliberately no dangerouslySetInnerHTML anywhere in this app.
 */

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; text: string; lang: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'rule' };

const MAX_LINES = 2000;

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n').slice(0, MAX_LINES);
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '') {
      i++;
      continue;
    }
    const fence = /^(```|~~~)\s*([\w+-]*)/.exec(trimmed);
    if (fence) {
      const marker = fence[1] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker)) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++; // closing fence
      blocks.push({ kind: 'code', text: body.join('\n'), lang: fence[2] ?? '' });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length,
        text: (heading[2] ?? '').replace(/\s+#+$/, ''),
      });
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }
    if (trimmed.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push((lines[i] ?? '').trim());
        i++;
      }
      blocks.push({ kind: 'table', text: rows.join('\n') });
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        quote.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', text: quote.join(' ') });
      continue;
    }
    const bullet = /^([-*+]|\d+[.)])\s+/;
    if (bullet.test(trimmed)) {
      const ordered = /^\d/.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const current = (lines[i] ?? '').trim();
        if (bullet.test(current)) {
          items.push(current.replace(bullet, ''));
        } else if (current !== '' && /^\s{2,}/.test(lines[i] ?? '') && items.length > 0) {
          items[items.length - 1] += ` ${current}`;
        } else {
          break;
        }
        i++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const current = (lines[i] ?? '').trim();
      if (
        current === '' ||
        /^(#{1,6})\s/.test(current) ||
        /^(```|~~~)/.test(current) ||
        /^([-*+]|\d+[.)])\s+/.test(current) ||
        current.startsWith('>') ||
        current.startsWith('|')
      ) {
        break;
      }
      para.push(current);
      i++;
    }
    blocks.push({ kind: 'para', text: para.join(' ') });
  }
  return blocks;
}

/** Inline formatting: `code` and **bold** only; everything else stays literal text. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(re)) {
    const index = match.index ?? 0;
    if (index > last) out.push(text.slice(last, index));
    const token = match[0];
    if (token.startsWith('`')) out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    last = index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function SafeMarkdown({
  source,
  headingOffset = 1,
}: {
  source: string;
  headingOffset?: number;
}) {
  const blocks = parseBlocks(source);
  return (
    <div className="prose-ledger" data-density="compact">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        switch (block.kind) {
          case 'heading': {
            const level = Math.min(block.level + headingOffset, 6);
            const Tag = `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
            return <Tag key={key}>{inline(block.text)}</Tag>;
          }
          case 'code':
            return (
              <pre key={key} data-lang={block.lang || undefined}>
                <code>{block.text}</code>
              </pre>
            );
          case 'list': {
            const items = block.items.map((item, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static text, order never changes
              <li key={n}>{inline(item)}</li>
            ));
            return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          case 'quote':
            return <blockquote key={key}>{inline(block.text)}</blockquote>;
          case 'table':
            return (
              <pre key={key}>
                <code>{block.text}</code>
              </pre>
            );
          case 'rule':
            return <hr key={key} />;
          default:
            return <p key={key}>{inline(block.text)}</p>;
        }
      })}
    </div>
  );
}
