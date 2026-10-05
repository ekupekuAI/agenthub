/**
 * Untrusted text (from a package, a registry, a lock file or the disk) reaches the screen only
 * through these helpers: control, bidi and zero-width characters are removed by the CLI's own
 * terminal sanitizer (output.ts) before Ink lays the text out.
 */
import { clean, stripControl } from '../output';

/** One line of untrusted text, safe to render. */
export function safe(value: unknown): string {
  return clean(value);
}

/** Multi-line untrusted text (newlines and tabs kept, tabs expanded). */
export function safeLines(value: unknown, max = 200): string[] {
  return stripControl(String(value ?? ''), { keepNewlines: true })
    .replace(/\t/g, '  ')
    .split('\n')
    .slice(0, max);
}

/** Shortens text to `width` cells (by code points) with an ellipsis. */
export function fit(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= width) return text;
  if (width <= ellipsis.length) return chars.slice(0, width).join('');
  return `${chars.slice(0, width - Array.from(ellipsis).length).join('')}${ellipsis}`;
}

/** Text typed or pasted into the prompt: printable, single line. */
export function safeInput(value: string): string {
  return stripControl(value.replace(/[\r\n\t]+/g, ' '));
}
