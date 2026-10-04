'use client';

import { useState } from 'react';

export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <fieldset
      aria-label={label ?? 'Install command'}
      className="m-0 flex min-w-0 items-stretch overflow-hidden rounded-lg border border-line bg-code p-0"
    >
      <code className="flex-1 overflow-x-auto whitespace-nowrap px-3 py-2.5 font-mono text-sm text-ink">
        <span aria-hidden="true" className="select-none text-muted">
          ${' '}
        </span>
        {command}
      </code>
      <button
        type="button"
        onClick={copy}
        className="border-l border-line bg-surface px-3 text-sm font-medium text-ink transition-colors hover:bg-raised"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Command copied to clipboard' : ''}
      </span>
    </fieldset>
  );
}
