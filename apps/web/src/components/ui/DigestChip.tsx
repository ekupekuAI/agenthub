'use client';

import { cn } from '../../lib/cn';
import { shortenDigest } from './format';
import { useCopy } from './hooks';
import { CheckIcon, CopyIcon } from './icons';

export interface DigestChipProps {
  /** The full digest, e.g. `sha256:<64 hex>`. Clicking copies exactly this value. */
  digest: string;
  /** What the digest identifies, used in the accessible name: "content digest". */
  label?: string;
  /** Hex digits kept at the start and end of the shortened form. */
  head?: number;
  tail?: number;
  className?: string;
}

/**
 * `sha256:9f2c…e1` as a mono chip. Click copies the full digest. The full value is in the
 * tooltip and in the accessible name, so nothing is hidden from keyboard or screen readers.
 */
export function DigestChip({
  digest,
  label = 'digest',
  head = 4,
  tail = 2,
  className,
}: DigestChipProps) {
  const { copied, copy } = useCopy(1500);
  return (
    <button
      type="button"
      title={digest}
      onClick={() => copy(digest)}
      className={cn(
        'hit-area inline-flex h-7 max-w-full items-center gap-1.5 rounded-chip border px-2 font-mono text-[0.8125rem] leading-none transition-colors duration-150',
        copied
          ? 'border-signal-line bg-signal-tint text-signal-ink'
          : 'border-border bg-surface-2 text-muted hover:border-border-strong hover:text-text',
        className,
      )}
    >
      <span className="sr-only">Copy {label} </span>
      <span aria-hidden="true" className="truncate">
        {shortenDigest(digest, head, tail)}
      </span>
      <span className="sr-only">{digest}</span>
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}
