/**
 * Motion: one shared Ink timer drives every animation. With reduced motion (or a non-animated
 * render) every hook returns its final state immediately.
 */
import { useAnimation } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { useTheme } from './context';

/** Frame interval bounds: never faster than 60 ms, never slower than 120 ms. */
export const FRAME_MS = 80;

export function clampFrame(ms: number): number {
  return Math.min(120, Math.max(60, ms));
}

/** A frame counter while `active` (and motion is on). */
export function useTick(interval = FRAME_MS, active = true): number {
  const theme = useTheme();
  const { frame } = useAnimation({
    interval: clampFrame(interval),
    isActive: active && theme.motion,
  });
  return theme.motion ? frame : 0;
}

/**
 * Staged reveal: how many of `total` items are visible, growing by `step` per frame from when
 * the hook mounts (or `key` changes). Returns `total` without motion.
 */
export function useReveal(
  total: number,
  opts: { interval?: number; step?: number; key?: unknown } = {},
): number {
  const theme = useTheme();
  const step = opts.step ?? 1;
  const [shown, setShown] = useState(theme.motion ? 0 : total);
  const keyRef = useRef(opts.key);
  useEffect(() => {
    if (keyRef.current !== opts.key) {
      keyRef.current = opts.key;
      setShown(theme.motion ? 0 : total);
    }
  }, [opts.key, theme.motion, total]);
  const done = shown >= total;
  const { frame } = useAnimation({
    interval: clampFrame(opts.interval ?? 70),
    isActive: theme.motion && !done,
  });
  useEffect(() => {
    if (!theme.motion || done) return;
    if (frame > 0) setShown((value) => Math.min(total, value + step));
  }, [frame, done, step, total, theme.motion]);
  return theme.motion ? Math.min(shown, total) : total;
}

/** Milliseconds since mount (or since `running` turned true), updated every 100 ms. */
export function useElapsed(running: boolean): number {
  const started = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (running) started.current = Date.now();
  }, [running]);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  return Math.max(0, now - started.current);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}
