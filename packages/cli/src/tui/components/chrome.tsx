/**
 * App chrome: the header bar, the prompt and the status line.
 */
import type { AgentEnvironment, AgentId, Scope } from '@agenthub/core';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/context';
import { fit, safe } from '../sanitize';
import { DetectedAgents } from './badges';
import { type Hint, KeyHints, Spinner, T } from './primitives';

export interface HeaderInfo {
  registry: string | null;
  registrySource?: string | undefined;
  registryError?: string | null;
  scope: Scope | null;
  agents: readonly AgentEnvironment[];
  selected: readonly AgentId[] | undefined;
  loading: boolean;
}

function shortRegistry(id: string | null, width: number): string {
  if (id === null) return 'none — /registry set';
  const text = safe(id).replace(/^https?:\/\//, '');
  return fit(text, width);
}

/** agenthub · registry · scope · agent chips … version */
export function Header({
  info,
  version,
  columns,
}: {
  info: HeaderInfo;
  version: string;
  columns: number;
}) {
  const theme = useTheme();
  const g = theme.glyphs;
  const sep = <T tone="border">{`  ${g.vbar}  `}</T>;
  // Everything but the registry has a fixed width; the registry gets what is left.
  const chips = Math.max(1, info.agents.length) * 6;
  const registryWidth = Math.max(10, Math.min(48, columns - 62 - chips));
  return (
    <Box paddingX={1} justifyContent="space-between">
      <Box flexShrink={0}>
        <Text>
          <T tone="signal" bold>
            {`${g.dot} agenthub`}
          </T>
          {sep}
          <T tone="subtle">registry </T>
          {info.registryError ? (
            <T tone="block">{`${g.block} invalid`}</T>
          ) : (
            <T tone={info.registry === null ? 'warn' : 'text'}>
              {shortRegistry(info.registry, registryWidth)}
            </T>
          )}
          {info.registrySource === 'project' ? <T tone="info"> (project)</T> : null}
          {sep}
          <T tone="subtle">scope </T>
          <T tone="text" bold>
            {info.scope ?? '…'}
          </T>
          {sep}
        </Text>
        <Box flexShrink={0}>
          {info.loading ? (
            <Spinner tone="subtle" label={<T tone="subtle">detecting agents</T>} />
          ) : (
            <DetectedAgents agents={info.agents} selected={info.selected} />
          )}
        </Box>
      </Box>
      {columns >= 96 ? (
        <Box flexShrink={0} marginLeft={1}>
          <T tone="subtle">{`v${version}`}</T>
        </Box>
      ) : null}
    </Box>
  );
}

export const PLACEHOLDER = 'Type / for commands, or search skills…';

export function PromptBar({
  value,
  cursor,
  focused,
  ghost,
  placeholder = PLACEHOLDER,
}: {
  value: string;
  cursor: number;
  focused: boolean;
  /** Dim completion hint after the text (argument synopsis). */
  ghost?: string;
  placeholder?: string;
}) {
  const theme = useTheme();
  const g = theme.glyphs;
  const chars = Array.from(value);
  const before = chars.slice(0, cursor).join('');
  const at = chars[cursor] ?? ' ';
  const after = chars.slice(cursor + 1).join('');
  return (
    <Box
      borderStyle={g.border}
      borderColor={focused ? theme.palette.signal : theme.palette.border}
      paddingX={1}
      marginX={1}
    >
      <T tone={focused ? 'signal' : 'subtle'} bold>
        {`${g.prompt} `}
      </T>
      {value === '' ? (
        <Text>
          {focused ? <Text inverse> </Text> : null}
          <T tone="subtle">{focused ? placeholder : `${placeholder.replace('Type', 'Press')}`}</T>
        </Text>
      ) : (
        <Text>
          <T tone="text">{before}</T>
          {focused ? <Text inverse>{at}</Text> : <T tone="text">{at}</T>}
          <T tone="text">{after}</T>
          {ghost === undefined ? null : <T tone="subtle">{ghost}</T>}
        </Text>
      )}
    </Box>
  );
}

/** Bottom line: context hints on the left, activity on the right. */
export function StatusLine({ hints, busy }: { hints: readonly Hint[]; busy: string | null }) {
  return (
    <Box paddingX={2} justifyContent="space-between">
      <KeyHints hints={hints} />
      {busy === null ? null : <Spinner tone="info" label={<T tone="muted">{busy}</T>} />}
    </Box>
  );
}
