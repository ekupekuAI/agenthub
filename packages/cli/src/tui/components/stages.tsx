/**
 * Staged progress (Scanning → Staging → Swapping → Verifying → Committed) and a progress bar.
 */
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/context';
import { formatMs } from '../hooks/motion';
import { ProgressBar, Spinner, T } from './primitives';

export type StageState = 'pending' | 'active' | 'done' | 'failed';

export interface Stage {
  label: string;
  state: StageState;
  /** Shown on the right, e.g. a measured time. */
  note?: string;
  detail?: string;
}

export function StageList({ stages, width = 40 }: { stages: readonly Stage[]; width?: number }) {
  const theme = useTheme();
  const g = theme.glyphs;
  const done = stages.filter((stage) => stage.state === 'done').length;
  return (
    <Box flexDirection="column">
      {stages.map((stage) => (
        <Box key={stage.label}>
          <Box width={3}>
            {stage.state === 'active' ? (
              <Spinner />
            ) : stage.state === 'done' ? (
              <T tone="signal">{g.ok}</T>
            ) : stage.state === 'failed' ? (
              <T tone="block">{g.block}</T>
            ) : (
              <T tone="border">{g.pending}</T>
            )}
          </Box>
          <Box width={14}>
            <T
              tone={
                stage.state === 'pending' ? 'subtle' : stage.state === 'failed' ? 'block' : 'text'
              }
              bold={stage.state === 'active'}
            >
              {stage.label}
            </T>
          </Box>
          <Box flexShrink={1}>
            <Text>
              {stage.detail === undefined ? null : <T tone="muted">{stage.detail}</T>}
              {stage.note === undefined ? null : <T tone="subtle">{`  ${stage.note}`}</T>}
            </Text>
          </Box>
        </Box>
      ))}
      <Box marginTop={1}>
        <ProgressBar value={stages.length === 0 ? 0 : done / stages.length} width={width} />
        <T tone="subtle">{`  ${done}/${stages.length}`}</T>
      </Box>
    </Box>
  );
}

export function Elapsed({ ms }: { ms: number }) {
  return <T tone="subtle">{formatMs(ms)}</T>;
}
