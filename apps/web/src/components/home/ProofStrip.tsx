import { Container } from '../ui';

export interface ProofStripProps {
  /** Skills with at least one active version in the registry. */
  skillCount: number;
}

/** Four mono facts under the hero, separated by hairlines. */
export function ProofStrip({ skillCount }: ProofStripProps) {
  const stats = [
    { value: '4', label: 'agents', note: 'Claude Code, Codex, Cursor, VS Code' },
    { value: '12', label: 'scanner rules', note: 'Run on upload and again on install' },
    {
      value: String(skillCount),
      label: skillCount === 1 ? 'curated skill' : 'curated skills',
      note: 'Each version immutable and scanned',
    },
    { value: '0', label: 'scripts run at install', note: 'Files are copied, never executed' },
  ];

  return (
    <section aria-label="agenthub at a glance" className="border-border border-y bg-surface-1">
      <Container width="wide">
        <dl className="-mx-4 grid grid-cols-2 gap-px bg-border sm:-mx-6 lg:grid-cols-4">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="flex min-w-0 flex-col-reverse justify-end gap-1 bg-surface-1 px-4 py-6 sm:px-6 sm:py-8"
            >
              <dt className="min-w-0">
                <span className="block font-mono text-[0.8125rem] text-text leading-5">
                  {stat.label}
                </span>
                <span className="mt-1 block text-[0.8125rem] text-subtle leading-5">
                  {stat.note}
                </span>
              </dt>
              <dd className="m-0 font-mono text-[2rem] text-text leading-none tracking-[-0.03em] tabular-nums sm:text-[2.5rem]">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}
