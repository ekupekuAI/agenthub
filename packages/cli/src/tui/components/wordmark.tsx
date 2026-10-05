/**
 * The agenthub wordmark: a geometric lowercase pixel font drawn with half blocks (two pixels per
 * cell, so pixels are square), with a lime light sweep that reveals it from left to right.
 */
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/context';
import { gradientColor } from '../theme';

/** 8 pixel rows: 0-1 ascender, 2-5 x-height, 6-7 descender. '#' = on. */
const FONT: Record<string, readonly string[]> = {
  a: ['....', '....', '.###', '#..#', '#..#', '.###', '....', '....'],
  g: ['....', '....', '.###', '#..#', '#..#', '.###', '...#', '.##.'],
  e: ['....', '....', '.##.', '####', '#...', '.###', '....', '....'],
  n: ['....', '....', '###.', '#..#', '#..#', '#..#', '....', '....'],
  t: ['.#.', '.#.', '###', '.#.', '.#.', '.##', '...', '...'],
  h: ['#...', '#...', '###.', '#..#', '#..#', '#..#', '....', '....'],
  u: ['....', '....', '#..#', '#..#', '#..#', '.###', '....', '....'],
  b: ['#...', '#...', '###.', '#..#', '#..#', '###.', '....', '....'],
};

export const WORD = 'agenthub';
/** Letters drawn in the signal color ("hub"). */
const SIGNAL_FROM = 5;

export interface Cell {
  char: string;
  /** Column index, for the sweep. */
  x: number;
  signal: boolean;
}

/** The wordmark as rows of cells (4 text rows). */
export function wordmarkRows(glyphs: {
  pixelTop: string;
  pixelBottom: string;
  pixelFull: string;
}): Cell[][] {
  const rows: Cell[][] = [[], [], [], []];
  let x = 0;
  Array.from(WORD).forEach((letter, index) => {
    const bitmap = FONT[letter] ?? [];
    const width = bitmap[0]?.length ?? 0;
    for (let col = 0; col < width; col += 1) {
      for (let row = 0; row < 4; row += 1) {
        const top = bitmap[row * 2]?.[col] === '#';
        const bottom = bitmap[row * 2 + 1]?.[col] === '#';
        const char =
          top && bottom
            ? glyphs.pixelFull
            : top
              ? glyphs.pixelTop
              : bottom
                ? glyphs.pixelBottom
                : ' ';
        rows[row]?.push({ char, x: x + col, signal: index >= SIGNAL_FROM });
      }
    }
    x += width;
    if (index < WORD.length - 1) {
      for (const row of rows) row.push({ char: ' ', x, signal: index >= SIGNAL_FROM });
      x += 1;
    }
  });
  return rows;
}

export const WORDMARK_WIDTH = 38;

/**
 * `progress` runs from 0 (nothing revealed) to 1 (final); null = final state. The band of light
 * leads the reveal and fades into the resting colors behind it.
 */
export function Wordmark({ progress = null }: { progress?: number | null }) {
  const theme = useTheme();
  const rows = wordmarkRows(theme.glyphs);
  const width = rows[0]?.length ?? WORDMARK_WIDTH;
  const head = progress === null ? Number.POSITIVE_INFINITY : progress * (width + 12) - 4;
  return (
    <Box flexDirection="column">
      {rows.map((row, r) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed rows
        <Text key={r}>
          {row.map((cell) => {
            const rest = cell.signal ? 'signal' : 'text';
            const distance = head - cell.x;
            let color: string | undefined;
            let char = cell.char;
            if (distance < 0) {
              // Not reached yet: a faint trace.
              color = theme.palette.border;
              char = cell.char === ' ' ? ' ' : cell.char;
              if (distance < -3) char = ' ';
            } else if (distance < 8 && theme.color) {
              // Inside the band: glow fading into the resting color.
              color = gradientColor(theme.name, theme.depth, 'glow', rest, distance / 8);
            } else {
              color = theme.palette[rest];
            }
            return (
              <Text key={cell.x} color={color} bold={!theme.color && cell.signal}>
                {char}
              </Text>
            );
          })}
        </Text>
      ))}
    </Box>
  );
}
