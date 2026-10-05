import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { CopyCommand, DecisionBadge, StatusBadge } from '../ui';

interface Step {
  title: string;
  body: ReactNode;
  /** A real artifact of the step: the command, the finding levels, the two statuses. */
  artifact?: ReactNode;
}

const STEPS: readonly Step[] = [
  {
    title: 'Pack',
    body: (
      <>
        The CLI validates your skill folder and writes one <code>.skillpkg</code> archive. It prints
        the two digests the registry has to reproduce.
      </>
    ),
    artifact: <CopyCommand command="agenthub pack ./my-skill" label="Pack command" />,
  },
  {
    title: 'Upload',
    body: (
      <>
        Send the archive with your publisher token. The registry recomputes both digests and stores
        the bytes under their SHA-256.
      </>
    ),
  },
  {
    title: 'Scanned',
    body: 'Every file is checked against the scanner rules before the version is listed. Each finding gets a decision.',
    artifact: (
      <p className="flex flex-wrap items-center gap-1.5">
        <DecisionBadge decision="INFO" />
        <DecisionBadge decision="WARN" />
        <DecisionBadge decision="BLOCK" />
      </p>
    ),
  },
  {
    title: 'Active or quarantined',
    body: 'Without a BLOCK finding the version is installable at once. With one it is stored, but nobody can install it until a moderator reviews it.',
    artifact: (
      <p className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status="active" />
        <span className="text-[0.8125rem] text-subtle leading-5">or</span>
        <StatusBadge status="quarantined" />
      </p>
    ),
  },
];

/** The publish flow as four numbered steps joined by a hairline. */
export function PublishSteps({ className }: { className?: string }) {
  return (
    <ol className={cn('m-0 list-none p-0', className)}>
      {STEPS.map((step, index) => (
        <li
          key={step.title}
          className="relative grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 pb-8 last:pb-0"
        >
          {index < STEPS.length - 1 ? (
            <span
              aria-hidden="true"
              className="absolute top-11 bottom-2 left-[1.125rem] w-px -translate-x-1/2 bg-border-strong"
            />
          ) : null}
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-control border border-border-strong bg-surface-1 font-mono text-[0.8125rem] text-muted leading-none"
          >
            {String(index + 1).padStart(2, '0')}
          </span>
          <div className="min-w-0 pt-1.5">
            <h3 className="font-semibold text-body text-text leading-6">{step.title}</h3>
            <p className="mt-1 text-muted text-small">{step.body}</p>
            {step.artifact ? <div className="mt-3">{step.artifact}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
