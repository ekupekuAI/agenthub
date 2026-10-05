import type { SkillInfoVersion } from '../../lib/api-types';
import { keyed } from '../../lib/keys';
import { RailPanel } from './RailPanel';

type Requirement = NonNullable<SkillInfoVersion['requirements']>[number];

const KINDS: readonly { kind: Requirement['kind']; label: string }[] = [
  { kind: 'runtime', label: 'Runtime' },
  { kind: 'command', label: 'Command' },
  { kind: 'mcp', label: 'MCP' },
];

export interface RequirementsPanelProps {
  requirements?: SkillInfoVersion['requirements'];
  className?: string;
}

/** Runtimes, commands and MCP servers the version needs on the machine, grouped by kind. */
export function RequirementsPanel({ requirements, className }: RequirementsPanelProps) {
  const all = requirements ?? [];
  const rows = KINDS.flatMap(({ kind, label }) =>
    all.filter((requirement) => requirement.kind === kind).map((item) => ({ label, item })),
  );

  return (
    <RailPanel
      id="requirements"
      title="Requirements"
      meta={rows.length === 0 ? 'none' : String(rows.length)}
      className={className}
    >
      {rows.length === 0 ? (
        <p className="text-muted text-small">No runtime, command or MCP server is required.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {keyed(rows, ({ item }) => `${item.kind}-${item.name}`).map(({ item: row, key }) => (
            <li key={key} className="flex min-h-8 flex-wrap items-baseline gap-x-2 py-1">
              <span className="w-[4.75rem] shrink-0 font-medium font-mono text-[0.75rem] text-subtle uppercase leading-5 tracking-[0.08em]">
                {row.label}
              </span>
              <span className="min-w-0 break-all font-mono text-mono text-text">
                {row.item.name}
              </span>
              {row.item.constraint ? (
                <>
                  <span aria-hidden="true" className="leader" />
                  <span className="break-all font-mono text-mono text-muted">
                    {row.item.constraint}
                  </span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </RailPanel>
  );
}
