import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { CopyCommand, FileIcon } from '../ui';
import { CopyTextButton } from './CopyButtons';

/** A run of long-form text in the ledger prose style. */
export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('prose-ledger my-4 [&_code]:[overflow-wrap:break-word]', className)}>
      {children}
    </div>
  );
}

export interface CommandItem {
  command: string;
  /** One line on what the command does. */
  note?: ReactNode;
}

/** Commands as copyable pills, each with a short note underneath. */
export function CommandList({ items }: { items: readonly CommandItem[] }) {
  return (
    <ul className="m-0 my-5 grid list-none gap-3.5 p-0">
      {items.map((item) => (
        <li key={item.command} className="min-w-0">
          <CopyCommand command={item.command} label="Command" />
          {item.note ? (
            <p className="mt-1.5 pl-3.5 text-[0.8125rem] text-muted leading-5">{item.note}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/*
 * A tiny, text-only highlighter for the YAML and Markdown examples on this page: comments,
 * keys and list markers get their own color. It never produces HTML strings.
 */
function Line({ text }: { text: string }) {
  if (text.trim() === '') return <>{'\n'}</>;
  const isMarkdownHeading = /^#{1,6}\s/.test(text);
  const hash = isMarkdownHeading ? null : /(^|\s)#/.exec(text);
  const commentAt = hash ? hash.index + (hash[1]?.length ?? 0) : -1;
  const body = commentAt === -1 ? text : text.slice(0, commentAt);
  const comment = commentAt === -1 ? '' : text.slice(commentAt);
  const key = /^(\s*(?:- )?)([A-Za-z_][\w.-]*)(:)(.*)$/.exec(body);

  let content: ReactNode;
  if (isMarkdownHeading) {
    content = <span className="font-medium text-text">{body}</span>;
  } else if (body.trim() === '---') {
    content = <span className="text-subtle">{body}</span>;
  } else if (key) {
    const [, indent = '', name = '', colon = '', rest = ''] = key;
    content = (
      <>
        {indent}
        <span className="text-text">{name}</span>
        <span className="text-subtle">{colon}</span>
        <span className="text-muted">{rest}</span>
      </>
    );
  } else {
    content = <span className="text-muted">{body}</span>;
  }

  return (
    <>
      {content}
      {comment ? <span className="text-subtle">{comment}</span> : null}
      {'\n'}
    </>
  );
}

export interface CodeFileProps {
  /** File name shown in the header, e.g. `agenthub.yaml`. */
  name: string;
  /** Short language tag, e.g. `yaml`. */
  language?: string;
  code: string;
  /** A sentence under the block. */
  caption?: ReactNode;
}

/** A source file with a header bar (icon, name, language) and a copy button. */
export function CodeFile({ name, language, code, caption }: CodeFileProps) {
  const lines = code.split('\n');
  return (
    <figure className="my-6 min-w-0">
      <div className="overflow-hidden rounded-card border border-border bg-surface-1 shadow-panel">
        <div className="flex h-10 items-center gap-2 border-border border-b bg-surface-2 pr-1.5 pl-3.5">
          <FileIcon size={14} className="shrink-0 text-subtle" />
          <span className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-text">
            {name}
          </span>
          {language ? (
            <span className="hidden font-mono text-[0.6875rem] text-subtle uppercase tracking-[0.08em] sm:inline">
              {language}
            </span>
          ) : null}
          <CopyTextButton text={code} label={name} />
        </div>
        <pre className="m-0 rounded-none border-0 bg-transparent px-4 py-3.5 text-[0.8125rem] leading-[1.375rem]">
          <code>
            {lines.map((line, index) => (
              // Lines are static and never reorder.
              // biome-ignore lint/suspicious/noArrayIndexKey: static example text
              <Line key={index} text={line} />
            ))}
          </code>
        </pre>
      </div>
      {caption ? (
        <figcaption className="mt-2 pl-1 text-[0.8125rem] text-muted leading-5">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

const EXIT_CODES: readonly [string, string, string][] = [
  ['0', 'Success', 'Everything went as planned.'],
  ['1', 'Error, or problems found', 'doctor found an issue, or a command failed.'],
  ['2', 'Usage error', 'An unknown flag or a missing argument.'],
  ['3', 'Blocked by security policy', 'A BLOCK finding stopped the plan.'],
  ['4', 'Integrity failure or drift', 'A digest did not match, or verify found changes.'],
  ['5', 'Incompatible', 'An agent, runtime or command requirement is not met.'],
  ['130', 'Cancelled', 'You pressed Ctrl+C or declined the prompt.'],
];

/** The CLI's exit codes as a ledger: code, meaning, typical cause. */
export function ExitCodes() {
  return (
    <dl className="m-0 my-6 overflow-hidden rounded-card border border-border bg-surface-1">
      {EXIT_CODES.map(([code, meaning, cause]) => (
        <div
          key={code}
          className="grid grid-cols-[3.25rem_minmax(0,1fr)] gap-x-3 border-border border-b px-4 py-3 last:border-b-0 sm:grid-cols-[3.75rem_minmax(0,14rem)_minmax(0,1fr)] sm:items-baseline"
        >
          <dt className="font-mono text-[1rem] text-text tabular-nums">{code}</dt>
          <dd className="m-0 font-medium text-small text-text">{meaning}</dd>
          <dd className="col-start-2 m-0 text-[0.8125rem] text-muted leading-5 sm:col-start-3">
            {cause}
          </dd>
        </div>
      ))}
    </dl>
  );
}
