/**
 * The slash-command palette (and argument suggestions): a dropdown above the prompt that opens
 * with a short staggered reveal.
 */
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/context';
import { useReveal } from '../hooks/motion';
import { fit } from '../sanitize';
import { KeyHints, T } from './primitives';

export interface PaletteEntry {
  id: string;
  /** Text inserted on completion, e.g. "/install " or "web-testing". */
  value: string;
  label: string;
  /** Matched character indices in `label`. */
  positions?: readonly number[];
  args?: string;
  description: string;
  tag?: string;
}

export const PALETTE_ROWS = 8;

/** The window of rows to show so that `selected` stays visible. */
export function windowStart(selected: number, total: number, rows: number): number {
  if (total <= rows) return 0;
  const half = Math.floor(rows / 2);
  return Math.min(Math.max(0, selected - half), total - rows);
}

function Highlighted({
  label,
  positions,
  active,
}: {
  label: string;
  positions: readonly number[];
  active: boolean;
}) {
  const set = new Set(positions);
  return (
    <Text>
      {Array.from(label).map((char, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: characters of a fixed label
        <T key={index} tone={set.has(index) ? 'signal' : 'text'} bold={active || set.has(index)}>
          {char}
        </T>
      ))}
    </Text>
  );
}

export function Palette({
  title,
  entries,
  selected,
  width,
  empty,
  openKey,
}: {
  title: string;
  entries: readonly PaletteEntry[];
  selected: number;
  width: number;
  empty: string;
  /** Changes when the palette opens, restarting the reveal. */
  openKey: number;
}) {
  const theme = useTheme();
  const g = theme.glyphs;
  const rows = Math.min(PALETTE_ROWS, entries.length);
  const shown = useReveal(rows, { interval: 60, step: 3, key: openKey });
  const start = windowStart(selected, entries.length, PALETTE_ROWS);
  const visible = entries.slice(start, start + rows).slice(0, Math.max(1, shown));
  const labelWidth = Math.min(
    24,
    Math.max(10, ...entries.map((entry) => Array.from(entry.label).length + 2)),
  );
  const argsWidth = Math.min(
    22,
    Math.max(0, ...entries.map((entry) => (entry.args?.length ?? 0) + 2)),
  );
  const inner = Math.max(20, width - 4);
  const descWidth = Math.max(10, inner - 3 - labelWidth - argsWidth - 8);
  return (
    <Box
      flexDirection="column"
      borderStyle={g.border}
      borderColor={theme.palette.border}
      paddingX={1}
      marginX={1}
    >
      <Box justifyContent="space-between">
        <T tone="muted" bold>
          {title.toUpperCase()}
        </T>
        <T tone="subtle">{entries.length === 0 ? '' : `${selected + 1}/${entries.length}`}</T>
      </Box>
      {entries.length === 0 ? <T tone="subtle">{empty}</T> : null}
      {visible.map((entry, offset) => {
        const index = start + offset;
        const active = index === selected;
        return (
          <Box key={entry.id}>
            <Box width={3}>
              <T tone="signal">{active ? g.pointer : ' '}</T>
            </Box>
            <Box width={labelWidth}>
              <Highlighted label={entry.label} positions={entry.positions ?? []} active={active} />
            </Box>
            <Box width={argsWidth}>
              <T tone="subtle">{fit(entry.args ?? '', Math.max(0, argsWidth - 1))}</T>
            </Box>
            <Box flexGrow={1}>
              <T tone={active ? 'text' : 'muted'}>{fit(entry.description, descWidth)}</T>
            </Box>
            {entry.tag === undefined ? null : (
              <Box width={8} justifyContent="flex-end">
                <T tone="subtle">{entry.tag}</T>
              </Box>
            )}
          </Box>
        );
      })}
      <Box marginTop={entries.length === 0 ? 0 : 0}>
        <KeyHints
          hints={[
            [`${g.up}${g.down}`, 'select'],
            ['tab', 'complete'],
            ['enter', 'run'],
            ['esc', 'close'],
          ]}
        />
      </Box>
    </Box>
  );
}
