/**
 * Shared React context: the theme, the session and navigation, and keyboard routing.
 */
import type { Key } from 'ink';
import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { Session } from '../session';
import { createTheme, type Theme } from '../theme';

export const ThemeContext = createContext<Theme>(
  createTheme('dark', { depth: 'none', glyphs: 'unicode', motion: false }),
);

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export type ToastTone = 'signal' | 'info' | 'warn' | 'block';

/** Screens of the interactive mode. */
export type View =
  | { kind: 'home' }
  | { kind: 'search'; query: string }
  | { kind: 'detail'; name: string }
  | { kind: 'install'; target: string }
  | { kind: 'update-flow'; name: string }
  | { kind: 'updates'; name?: string }
  | { kind: 'list' }
  | { kind: 'verify'; name?: string }
  | { kind: 'doctor' }
  | { kind: 'diff'; name: string }
  | { kind: 'approve'; name: string }
  | { kind: 'remove'; name: string }
  | { kind: 'rollback'; name: string }
  | { kind: 'agents' }
  | { kind: 'help' };

export interface AppApi {
  session: Session;
  navigate(view: View): void;
  /** Replaces the current view (no new history entry). */
  replace(view: View): void;
  back(): void;
  home(): void;
  toast(tone: ToastTone, text: string): void;
  /** Re-reads the header (agents, registry, scope, installed skills) after a change. */
  refresh(): void;
  /** Marks a write in progress (Ctrl+C then waits for it before leaving). */
  setBusy(busy: boolean): void;
  /** Rows available to the screen's content. */
  rows: number;
  columns: number;
}

export const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const api = useContext(AppContext);
  if (api === null) throw new Error('useApp outside the app');
  return api;
}

// ---------------------------------------------------------------------------
// Keyboard routing
// ---------------------------------------------------------------------------

/** Returns true when the key was handled. */
export type KeyHandler = (input: string, key: Key) => boolean;

export interface KeyLayer {
  handler: { current: KeyHandler };
  /** Modal layers (confirmations) receive every key first and hide the prompt. */
  modal: boolean;
}

export interface KeyRouter {
  push(layer: KeyLayer): () => void;
}

export const KeyContext = createContext<KeyRouter | null>(null);

/**
 * Registers a key handler for the current screen. Screen keys are delivered when the prompt is
 * empty (so typing always goes to the prompt); `modal` handlers get every key first.
 */
export function useKeys(
  handler: KeyHandler,
  opts: { modal?: boolean; active?: boolean } = {},
): void {
  const router = useContext(KeyContext);
  const ref = useRef(handler);
  ref.current = handler;
  const modal = opts.modal === true;
  const active = opts.active !== false;
  // Layout effect: the handler is in place before the frame that shows the screen is written,
  // so a key pressed right after the screen appears is never lost.
  useLayoutEffect(() => {
    if (router === null || !active) return undefined;
    return router.push({ handler: ref, modal });
  }, [router, modal, active]);
}
