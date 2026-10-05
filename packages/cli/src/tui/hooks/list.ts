import type { Key } from 'ink';
import { useEffect, useState } from 'react';

/** Moves a selection for arrow, page, home/end and j/k keys; returns true when handled. */
export function moveSelection(
  index: number,
  count: number,
  input: string,
  key: Key,
  page = 8,
): number | null {
  if (count === 0) return null;
  if (key.upArrow || input === 'k') return (index - 1 + count) % count;
  if (key.downArrow || input === 'j') return (index + 1) % count;
  if (key.pageUp) return Math.max(0, index - page);
  if (key.pageDown) return Math.min(count - 1, index + page);
  if (key.home) return 0;
  if (key.end) return count - 1;
  return null;
}

/** A selection index kept inside [0, count). */
export function useSelection(count: number): [number, (next: number) => void] {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (index >= count) setIndex(Math.max(0, count - 1));
  }, [count, index]);
  return [Math.min(index, Math.max(0, count - 1)), setIndex];
}
