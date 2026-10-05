'use client';

import { cn } from '../../lib/cn';
import { useCopy } from './hooks';
import { CheckIcon, CopyIcon } from './icons';

export interface CopyCommandProps {
  /** The exact text that is copied, without the prompt. */
  command: string;
  /** Accessible name of the group. */
  label?: string;
  /** Prompt character shown before the command; `false` hides it. */
  prompt?: string | false;
  className?: string;
}

/** A mono pill showing one shell command with a copy button. "Copied" shows for 1.5s. */
export function CopyCommand({
  command,
  label = 'Install command',
  prompt = '$',
  className,
}: CopyCommandProps) {
  const { copied, copy } = useCopy(1500);

  return (
    <fieldset
      aria-label={label}
      className={cn(
        'm-0 flex min-h-11 min-w-0 max-w-full items-stretch rounded-control border border-border-strong bg-surface-1 p-0',
        className,
      )}
    >
      <code className="flex min-w-0 flex-1 items-center gap-2.5 border-0 bg-transparent py-2 pr-2 pl-3.5 font-mono text-mono text-text">
        {prompt ? (
          <span aria-hidden="true" className="select-none text-subtle">
            {prompt}
          </span>
        ) : null}
        <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {/*
           * Each word is an inline-block, so a line breaks between words rather than at a
           * hyphen inside one ("web-" / "testing"). A word longer than the line still wraps.
           */}
          {command.split(/( +)/).map((part, index) =>
            part.trim() === '' ? (
              part
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts of a fixed string never reorder
              <span key={index} className="inline-block max-w-full">
                {part}
              </span>
            ),
          )}
        </span>
      </code>
      <button
        type="button"
        onClick={() => copy(command)}
        className={cn(
          'inline-flex min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-r-[9px] border-border-strong border-l px-3 font-medium text-[0.8125rem] transition-colors duration-150',
          copied ? 'text-signal-ink' : 'text-muted hover:bg-surface-2 hover:text-text',
        )}
      >
        {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Command copied to clipboard' : ''}
      </span>
    </fieldset>
  );
}
