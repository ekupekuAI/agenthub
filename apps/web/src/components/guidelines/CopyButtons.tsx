'use client';

import { cn } from '../../lib/cn';
import { CheckIcon, CopyIcon, LinkIcon, useCopy } from '../ui';

export interface CopyLinkButtonProps {
  /** Id of the heading the link points to. */
  id: string;
  /** The heading text, for the button's accessible name. */
  label: string;
  className?: string;
}

/**
 * Copies a link to one heading. It shows on hover and on keyboard focus, and always on touch
 * screens, where there is no hover.
 */
export function CopyLinkButton({ id, label, className }: CopyLinkButtonProps) {
  const { copied, copy } = useCopy(1500);
  return (
    <button
      type="button"
      onClick={() => copy(`${window.location.origin}${window.location.pathname}#${id}`)}
      aria-label={`Copy link to “${label}”`}
      title="Copy link to this section"
      className={cn(
        'hit-area relative inline-flex size-8 shrink-0 items-center justify-center rounded-chip transition-[opacity,color,background-color] duration-150',
        'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100',
        copied ? 'text-signal-ink opacity-100' : 'text-subtle hover:bg-surface-2 hover:text-text',
        className,
      )}
    >
      {copied ? <CheckIcon size={15} /> : <LinkIcon size={15} />}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Link copied' : ''}
      </span>
    </button>
  );
}

export interface CopyTextButtonProps {
  text: string;
  /** What is copied, for the accessible name, e.g. "agenthub.yaml". */
  label: string;
}

/** Small "Copy" button for a file header. */
export function CopyTextButton({ text, label }: CopyTextButtonProps) {
  const { copied, copy } = useCopy(1500);
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      aria-label={`Copy ${label}`}
      className={cn(
        'hit-area relative inline-flex h-7 items-center gap-1.5 rounded-chip px-2 font-medium text-[0.75rem] transition-colors duration-150',
        copied ? 'text-signal-ink' : 'text-muted hover:bg-surface-3 hover:text-text',
      )}
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      <span aria-hidden="true">{copied ? 'Copied' : 'Copy'}</span>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}
