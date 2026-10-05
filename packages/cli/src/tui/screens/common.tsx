/**
 * Pieces shared by the screens: title rows, the loading state and a scrolling viewport.
 */
import { Box, type DOMElement, measureElement, Text } from 'ink';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ErrorCard } from '../components/cards';
import { type Hint, KeyHints, Spinner, T } from '../components/primitives';
import { useKeys, useTheme } from '../hooks/context';
import { formatMs, useElapsed } from '../hooks/motion';
import type { TaskState } from '../hooks/task';

export function ScreenTitle({
  title,
  subtitle,
  meta,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text>{title}</Text>
        {meta === undefined ? null : <Box flexShrink={0}>{meta}</Box>}
      </Box>
      {subtitle === undefined ? null : (
        <Box>{typeof subtitle === 'string' ? <T tone="muted">{subtitle}</T> : subtitle}</Box>
      )}
    </Box>
  );
}

/** "◆ Title" heading in the signal color. */
export function Heading({
  children,
  tone = 'text',
}: {
  children: ReactNode;
  tone?: 'text' | 'signal' | 'warn' | 'block';
}) {
  const theme = useTheme();
  return (
    <Text>
      <T tone="signal">{`${theme.glyphs.dot} `}</T>
      <T tone={tone} bold>
        {children}
      </T>
    </Text>
  );
}

export function Loading({ label }: { label: string }) {
  const elapsed = useElapsed(true);
  return (
    <Box marginTop={1}>
      <Spinner label={<T tone="text">{label}</T>} />
      <T tone="subtle">{elapsed >= 400 ? `  ${formatMs(elapsed)}` : ''}</T>
    </Box>
  );
}

/**
 * Renders a task: spinner while loading, an error card on failure, `children(value)` when done.
 */
export function TaskView<T>({
  state,
  loading,
  what,
  children,
}: {
  state: TaskState<T>;
  loading: string;
  what: string;
  children: (value: T) => ReactNode;
}) {
  if (state.status === 'loading') return <Loading label={loading} />;
  if (state.status === 'error') return <ErrorCard what={what} error={state.error} />;
  return <>{children(state.value)}</>;
}

/**
 * A vertical viewport of `height` rows over taller content, scrolled with ↑↓ / PgUp / PgDn
 * (when `keys` is true) by shifting the content up.
 */
export function Scroll({
  height,
  children,
  keys = true,
}: {
  height: number;
  children: ReactNode;
  keys?: boolean;
}) {
  const inner = useRef<DOMElement>(null);
  const [offset, setOffset] = useState(0);
  const [content, setContent] = useState(0);
  useEffect(() => {
    if (inner.current === null) return;
    const { height: measured } = measureElement(inner.current);
    if (measured !== content) setContent(measured);
  });
  const max = Math.max(0, content - height);
  useKeys(
    (input, key) => {
      if (max === 0) return false;
      if (key.downArrow || input === 'j') setOffset((o) => Math.min(max, o + 1));
      else if (key.upArrow || input === 'k') setOffset((o) => Math.max(0, o - 1));
      else if (key.pageDown || input === ' ')
        setOffset((o) => Math.min(max, o + Math.max(1, height - 2)));
      else if (key.pageUp) setOffset((o) => Math.max(0, o - Math.max(1, height - 2)));
      else if (key.home) setOffset(0);
      else if (key.end) setOffset(max);
      else return false;
      return true;
    },
    { active: keys },
  );
  const clamped = Math.min(offset, max);
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      <Box ref={inner} flexDirection="column" marginTop={-clamped} flexShrink={0}>
        {children}
      </Box>
      {max > 0 ? <ScrollMark offset={clamped} max={max} /> : null}
    </Box>
  );
}

function ScrollMark({ offset, max }: { offset: number; max: number }) {
  const theme = useTheme();
  return (
    <Box position="absolute" right={0} bottom={0}>
      <T
        tone="subtle"
        inverse
      >{` ${theme.glyphs.up}${theme.glyphs.down} ${Math.round((offset / max) * 100)}% `}</T>
    </Box>
  );
}

/**
 * Side-by-side columns share the width equally; stacked (narrow) they keep their natural height.
 * (flexBasis 0 in a column layout would collapse them to nothing.)
 */
export function split(wide: boolean): { flexGrow?: number; flexBasis?: number } {
  return wide ? { flexGrow: 1, flexBasis: 0 } : {};
}

export function Footer({ hints }: { hints: readonly Hint[] }) {
  return (
    <Box marginTop={1}>
      <KeyHints hints={hints} />
    </Box>
  );
}
