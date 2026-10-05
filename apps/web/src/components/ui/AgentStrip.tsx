import { cn } from '../../lib/cn';
import { AGENT_IDS, AGENT_META, type AgentId } from './agents';

export type AgentStripSize = 'sm' | 'md' | 'lg';

export interface AgentStripProps {
  /** Agents this skill version supports. All four tiles are always drawn. */
  supported: readonly AgentId[];
  size?: AgentStripSize;
  /** Show the agent name under each tile (use with size="lg"). */
  showNames?: boolean;
  /** Accessible name of the list. */
  label?: string;
  className?: string;
}

const TILE: Record<AgentStripSize, string> = {
  sm: 'h-6 w-7 rounded-sm text-[0.625rem]',
  md: 'h-8 w-9 rounded-chip text-[0.6875rem]',
  lg: 'h-11 w-12 rounded-control text-[0.8125rem]',
};

/**
 * Four monogram tiles (CC, CX, CU, VS). Supported agents get a signal outline; unsupported
 * ones are dimmed and struck through. The full name and state are in `title` and in text for
 * assistive tech, so support is never conveyed by color alone.
 */
export function AgentStrip({
  supported,
  size = 'md',
  showNames = false,
  label = 'Agent compatibility',
  className,
}: AgentStripProps) {
  return (
    <ul
      aria-label={label}
      className={cn(
        'm-0 flex list-none p-0',
        showNames ? 'flex-wrap gap-x-4 gap-y-3' : 'gap-1.5',
        className,
      )}
    >
      {AGENT_IDS.map((id) => {
        const meta = AGENT_META[id];
        const ok = supported.includes(id);
        const state = ok ? 'supported' : 'not supported';
        return (
          <li
            key={id}
            title={`${meta.name}: ${state}`}
            className={cn('flex items-center', showNames ? 'gap-2' : '')}
          >
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex shrink-0 select-none items-center justify-center border font-medium font-mono leading-none tracking-[0.04em]',
                TILE[size],
                ok
                  ? 'border-signal-line bg-signal-tint text-signal-ink'
                  : 'border-border border-dashed bg-transparent text-subtle line-through',
              )}
            >
              {meta.monogram}
            </span>
            {showNames ? (
              <span
                aria-hidden="true"
                className={cn('text-small', ok ? 'text-text' : 'text-subtle line-through')}
              >
                {meta.name}
              </span>
            ) : null}
            <span className="sr-only">{`${meta.name}: ${state}`}</span>
          </li>
        );
      })}
    </ul>
  );
}
