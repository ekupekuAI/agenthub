/**
 * Home: the wordmark, what agenthub does, quick actions and the state of this machine.
 */
import { Box, Text } from 'ink';
import { Field, Panel, T } from '../components/primitives';
import { WORDMARK_WIDTH, Wordmark } from '../components/wordmark';
import { useTheme } from '../hooks/context';
import { useReveal } from '../hooks/motion';
import type { Overview } from '../session';
import { split } from './common';

const ACTIONS: readonly (readonly [string, string])[] = [
  ['/search', 'find a skill in the registry'],
  ['/install', 'review the plan, then install'],
  ['/list', 'installed skills and approvals'],
  ['/update', 'updates and new capabilities'],
  ['/doctor', 'check agents, folders, the lock'],
  ['/help', 'keys, commands and settings'],
];

export const TAGLINE = 'The package manager and trust layer for agent skills.';

export function HomeScreen({
  overview,
  rows,
  columns,
}: {
  overview: Overview | null;
  rows: number;
  columns: number;
}) {
  const theme = useTheme();
  const g = theme.glyphs;
  const wide = columns >= 96;
  const big = rows >= 22 && columns >= WORDMARK_WIDTH + 4;
  const shown = useReveal(3, { interval: 90 });
  const problems = overview?.problems ?? [];
  const errors = problems.filter((p) => p.level === 'error').length;
  const warnings = problems.length - errors;
  const health =
    problems.length === 0 ? (
      <T tone="signal">{`${g.ok} no problems found`}</T>
    ) : (
      <T tone={errors > 0 ? 'block' : 'warn'}>
        {`${errors > 0 ? g.block : g.warn} ${[
          errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : '',
          warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '',
        ]
          .filter((part) => part !== '')
          .join(', ')} — /doctor`}
      </T>
    );
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column" marginTop={big ? 1 : 0}>
        {big ? (
          <Wordmark />
        ) : (
          <T tone="signal" bold>
            {`${g.dot} agenthub`}
          </T>
        )}
        <Box marginTop={1}>
          <T tone="text">{TAGLINE}</T>
        </Box>
        {rows >= 26 ? (
          <T tone="muted">
            Install, verify and update SKILL.md skills for Claude Code, Codex, Cursor and VS Code.
          </T>
        ) : null}
      </Box>

      {shown >= 1 ? (
        <Box
          marginTop={1}
          flexDirection={columns >= 96 ? 'row' : 'column'}
          gap={columns >= 96 ? 2 : 0}
        >
          <Panel title="Start" {...split(wide)}>
            {ACTIONS.map(([command, text]) => (
              <Box key={command}>
                <Box width={11}>
                  <T tone="signal">{command}</T>
                </Box>
                <T tone="muted" wrap="truncate-end">
                  {text}
                </T>
              </Box>
            ))}
          </Panel>
          {shown >= 2 && !wide ? (
            <Box paddingX={1}>
              {overview === null ? (
                <T tone="subtle">reading the lock and detecting agents{g.ellipsis}</T>
              ) : (
                <Text>
                  <T tone="muted">{`${overview.installed.length} installed ${g.sep} ${overview.scope} scope ${g.sep} ${overview.agents.length} agents ${g.sep} `}</T>
                  {health}
                </Text>
              )}
            </Box>
          ) : null}
          {shown >= 2 && wide ? (
            <Panel title="This machine" {...split(wide)}>
              {overview === null ? (
                <T tone="subtle">reading the lock and detecting agents{g.ellipsis}</T>
              ) : (
                <>
                  <Field name="installed">
                    <T tone="text" bold>
                      {String(overview.installed.length)}
                    </T>
                    <T tone="muted">{` skill${overview.installed.length === 1 ? '' : 's'}`}</T>
                  </Field>
                  <Field name="scope">
                    <T tone="text">{overview.scope}</T>
                    <T tone="muted">
                      {overview.projectRoot === null ? '  (not inside a project)' : ''}
                    </T>
                  </Field>
                  <Field name="agents">
                    <T tone="text">{String(overview.agents.length)}</T>
                    <T tone="muted"> detected</T>
                    <T tone="muted">
                      {overview.selectedAgents === undefined
                        ? ''
                        : ` · ${overview.selectedAgents.length} chosen`}
                    </T>
                  </Field>
                  <Field name="health">{health}</Field>
                  {overview.registry.id === null ? (
                    <Field name="registry">
                      <T tone="warn">{`${g.warn} none — /registry set <https://… | file:folder>`}</T>
                    </Field>
                  ) : null}
                </>
              )}
            </Panel>
          ) : null}
        </Box>
      ) : null}
      {shown >= 3 && rows >= 26 ? (
        <Box marginTop={1}>
          <T tone="subtle">
            Capability inventories come from static analysis of the files; they show what a skill
            can do, not whether it is safe.
          </T>
        </Box>
      ) : null}
    </Box>
  );
}
