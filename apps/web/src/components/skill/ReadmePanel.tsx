import { cn } from '../../lib/cn';
import { SafeMarkdown } from '../SafeMarkdown';
import { FileTextIcon } from '../ui';

export interface ReadmePanelProps {
  /** Body of SKILL.md. Untrusted: SafeMarkdown renders it as text nodes only. */
  source: string;
  /** True when the registry stored only the start of a long README. */
  truncated?: boolean;
  className?: string;
}

/** SKILL.md as a document: a file tab, then the body in ledger prose. */
export function ReadmePanel({ source, truncated, className }: ReadmePanelProps) {
  return (
    <section
      aria-labelledby="readme-heading"
      className={cn('min-w-0 rounded-card border border-border bg-surface-1', className)}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-border border-b px-5 py-3 sm:px-7">
        <h2
          id="readme-heading"
          className="flex items-center gap-2 font-medium font-mono text-mono text-text"
        >
          <FileTextIcon size={15} className="text-subtle" />
          SKILL.md
        </h2>
        <p className="text-[0.8125rem] text-subtle leading-5">
          Shown as plain text. Nothing in a skill is ever rendered as HTML here.
          {truncated ? ' Shortened: only the start of a long README is stored.' : null}
        </p>
      </header>
      <div className="px-5 py-6 sm:px-7 sm:py-8 [&_pre]:bg-bg">
        {source.trim() ? (
          <SafeMarkdown source={source} headingOffset={2} />
        ) : (
          <p className="text-muted">This skill has no body text.</p>
        )}
      </div>
    </section>
  );
}
