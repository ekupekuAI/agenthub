/**
 * Text, panels, spinners, key hints and rules, styled from the theme. Nothing here renders
 * untrusted text without the caller passing it through `safe()` first.
 */
import { Box, type BoxProps, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../hooks/context';
import { useTick } from '../hooks/motion';
import type { Palette } from '../theme';

export type Tone = keyof Palette;

const LOUD: ReadonlySet<Tone> = new Set(['signal', 'warn', 'block', 'info']);
const QUIET: ReadonlySet<Tone> = new Set(['muted', 'subtle', 'border']);

export interface TProps {
  tone?: Tone;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  bg?: Tone;
  wrap?: 'wrap' | 'truncate' | 'truncate-end' | 'truncate-middle' | 'truncate-start';
  children?: ReactNode;
}

/**
 * Themed text. Without colors, loud tones become bold and quiet tones dim, so state still
 * shows (and every status also has a word and a glyph).
 */
export function T({
  tone = 'text',
  bold,
  dim,
  italic,
  underline,
  inverse,
  bg,
  wrap,
  children,
}: TProps) {
  const theme = useTheme();
  const color = theme.palette[tone];
  const background = bg === undefined ? undefined : theme.palette[bg];
  const mono = !theme.color;
  return (
    <Text
      color={color}
      backgroundColor={background}
      bold={bold === true || (mono && LOUD.has(tone))}
      dimColor={dim === true || (mono && QUIET.has(tone))}
      italic={italic}
      underline={underline}
      inverse={inverse}
      wrap={wrap}
    >
      {children}
    </Text>
  );
}

/** Braille spinner (dots on the classic console, |/-\ in ASCII); static without motion. */
export function Spinner({ tone = 'signal', label }: { tone?: Tone; label?: ReactNode }) {
  const theme = useTheme();
  const frame = useTick(80);
  const frames = theme.glyphs.spinner;
  const glyph = theme.motion ? (frames[frame % frames.length] ?? '') : theme.glyphs.pending;
  return (
    <Text>
      <T tone={tone}>{glyph}</T>
      {label === undefined ? null : <Text> {label}</Text>}
    </Text>
  );
}

export interface PanelProps extends Omit<BoxProps, 'borderStyle' | 'borderColor'> {
  /** Editorial label, shown in capitals. */
  title?: string;
  /** A heading that keeps its case (skill names, versions). */
  heading?: string;
  /** Right side of the title row. */
  aside?: ReactNode;
  tone?: Tone;
  children?: ReactNode;
}

/** Bordered card with an editorial uppercase label. */
export function Panel({ title, heading, aside, tone, children, ...box }: PanelProps) {
  const theme = useTheme();
  const borderColor = theme.palette[tone ?? 'border'];
  return (
    <Box
      flexDirection="column"
      borderStyle={theme.glyphs.border}
      borderColor={borderColor}
      paddingX={1}
      {...box}
    >
      {title === undefined && heading === undefined ? null : (
        <Box justifyContent="space-between">
          {heading === undefined ? (
            <T tone={tone ?? 'muted'} bold>
              {(title ?? '').toUpperCase()}
            </T>
          ) : (
            <T tone={tone ?? 'text'} bold>
              {heading}
            </T>
          )}
          {aside ?? null}
        </Box>
      )}
      {children}
    </Box>
  );
}

/** Small uppercase section label. */
export function Label({ children, tone = 'muted' }: { children: string; tone?: Tone }) {
  return (
    <T tone={tone} bold>
      {children.toUpperCase()}
    </T>
  );
}

export type Hint = readonly [key: string, label: string];

/** "key label · key label" row. */
export function KeyHints({ hints }: { hints: readonly Hint[] }) {
  const theme = useTheme();
  return (
    <Box flexWrap="wrap">
      {hints.map(([key, label], index) => (
        <Text key={`${key}-${label}`}>
          {index === 0 ? '' : <T tone="subtle">{`  ${theme.glyphs.sep}  `}</T>}
          <T tone="text" bold>
            {key}
          </T>
          <T tone="muted"> {label}</T>
        </Text>
      ))}
    </Box>
  );
}

/** Horizontal hairline. */
export function Rule({ width, tone = 'border' }: { width: number; tone?: Tone }) {
  const theme = useTheme();
  return <T tone={tone}>{theme.glyphs.hr.repeat(Math.max(0, width))}</T>;
}

/** Progress bar of `width` cells. */
export function ProgressBar({
  value,
  width,
  tone = 'signal',
}: {
  value: number;
  width: number;
  tone?: Tone;
}) {
  const theme = useTheme();
  const filled = Math.round(Math.min(1, Math.max(0, value)) * width);
  return (
    <Text>
      <T tone={tone}>{theme.glyphs.barFull.repeat(filled)}</T>
      <T tone="border">{theme.glyphs.barEmpty.repeat(Math.max(0, width - filled))}</T>
    </Text>
  );
}

/** "key   value" row with an aligned key column. */
export function Field({
  name,
  children,
  width = 10,
}: {
  name: string;
  children: ReactNode;
  width?: number;
}) {
  return (
    <Box>
      <Box width={width} flexShrink={0}>
        <T tone="subtle">{name}</T>
      </Box>
      <Box flexShrink={1}>
        <Text>{children}</Text>
      </Box>
    </Box>
  );
}
