import { cn } from '../../lib/cn';
import { AGENT_META, type AgentId, Container, Eyebrow, FolderIcon, Reveal } from '../ui';

/**
 * Which project skills folder each agent reads. Mirrors AGENT_PATHS in
 * packages/adapters/src/paths.ts (and FOLDER_READERS in the skill page's CompatibilityPanel).
 */
const FOLDERS: { dir: string; readers: AgentId[]; y: number }[] = [
  { dir: '.agents/skills', readers: ['codex', 'cursor', 'vscode'], y: 25 },
  { dir: '.claude/skills', readers: ['claude-code', 'cursor', 'vscode'], y: 75 },
];

/** Agents ordered so the lines do not cross; `y` is the row center in percent. */
const AGENT_ROWS: { id: AgentId; short: string; y: number }[] = [
  { id: 'codex', short: 'Codex', y: 12.5 },
  { id: 'cursor', short: 'Cursor', y: 37.5 },
  { id: 'vscode', short: 'VS Code', y: 62.5 },
  { id: 'claude-code', short: 'Claude Code', y: 87.5 },
];

const LIST = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' });

const EDGES = AGENT_ROWS.flatMap((agent) =>
  FOLDERS.filter((f) => f.readers.includes(agent.id)).map((f) => ({
    key: `${agent.id}->${f.dir}`,
    d: `M0 ${agent.y} C 50 ${agent.y}, 50 ${f.y}, 100 ${f.y}`,
  })),
);

function Port({ side }: { side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute top-1/2 size-2 -translate-y-1/2 rounded-full border border-signal-ink bg-signal',
        side === 'right' ? '-right-1' : '-left-1',
      )}
    />
  );
}

/** The drawn map. Decorative: the same facts are in a visually hidden list beside it. */
function MapDiagram() {
  return (
    <div
      aria-hidden="true"
      className="grid grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)] grid-rows-4 sm:grid-cols-[minmax(0,1fr)_minmax(3rem,0.6fr)_minmax(0,1.25fr)]"
    >
      {AGENT_ROWS.map((agent, index) => (
        <div
          key={agent.id}
          className="col-start-1 flex items-center py-1.5"
          style={{ gridRowStart: index + 1 }}
        >
          <div
            title={AGENT_META[agent.id].name}
            className="relative flex w-full min-w-0 items-center gap-2 rounded-control border border-border-strong bg-surface-1 px-2.5 py-2 sm:gap-2.5 sm:px-3"
          >
            <span className="inline-flex h-7 w-8 shrink-0 items-center justify-center rounded-chip border border-signal-line bg-signal-tint font-medium font-mono text-[0.6875rem] text-signal-ink tracking-[0.04em]">
              {AGENT_META[agent.id].monogram}
            </span>
            <span className="min-w-0 text-[0.8125rem] text-text leading-tight sm:text-small">
              {agent.short}
            </span>
            <Port side="right" />
          </div>
        </div>
      ))}

      <svg
        className="col-start-2 row-span-4 row-start-1 h-full w-full overflow-visible"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {EDGES.map((edge) => (
          <path
            key={edge.key}
            d={edge.d}
            fill="none"
            stroke="var(--signal-ink)"
            strokeOpacity={0.55}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>

      {FOLDERS.map((folder, index) => (
        <div
          key={folder.dir}
          className="col-start-3 row-span-2 flex items-center py-1.5"
          style={{ gridRowStart: index * 2 + 1 }}
        >
          <div className="relative w-full min-w-0 rounded-card border border-signal-line bg-surface-2 px-2.5 py-3 sm:px-4 sm:py-4">
            <Port side="left" />
            <span className="flex items-center gap-2">
              <FolderIcon size={15} className="hidden shrink-0 text-signal-ink sm:inline" />
              <span className="min-w-0 font-mono text-[0.75rem] text-text leading-5 [overflow-wrap:anywhere] sm:text-mono">
                {folder.dir}
              </span>
            </span>
            <span className="mt-1 block font-mono text-[0.6875rem] text-subtle leading-4 sm:text-[0.75rem]">
              read by {folder.readers.length} agents
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Home compatibility map: four agents, two skills folders, lines for who reads what. */
export function CompatibilityMap() {
  return (
    <section aria-labelledby="compat-heading" className="border-border border-t py-14 lg:py-24">
      <Container className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] lg:gap-16">
        <div className="min-w-0">
          <Eyebrow className="mb-3">Compatibility</Eyebrow>
          <h2 id="compat-heading" className="display-2 text-text">
            Four agents, two <em className="text-signal-ink italic">folders</em>.
          </h2>
          <p className="mt-4 text-body text-muted">
            Skills are plain folders with a SKILL.md. Each agent reads one or both project folders,
            so agenthub writes the fewest copies that reach every agent you use, and records each
            one in the lockfile.
          </p>
          <ul className="sr-only">
            {FOLDERS.map((f) => (
              <li key={f.dir}>
                {f.dir} is read by {LIST.format(f.readers.map((id) => AGENT_META[id].name))}.
              </li>
            ))}
          </ul>
        </div>

        <Reveal className="min-w-0">
          <div className="rounded-panel border border-border bg-surface-1 p-4 shadow-panel sm:p-8">
            <MapDiagram />
            <p className="mt-5 border-border border-t pt-4 font-mono text-[0.75rem] text-subtle leading-5">
              Lines show which folder each agent reads.
            </p>
          </div>
        </Reveal>
      </Container>
    </section>
  );
}
