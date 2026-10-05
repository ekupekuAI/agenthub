/**
 * The interactive app: header, the current screen, toasts, the command palette, the prompt and
 * the status line. Keys: typing goes to the prompt; screens get keys when the prompt is empty;
 * confirmations are modal. Esc goes back, Ctrl+C quits.
 */
import type { AgentId } from '@agenthub/core';
import { Box, type Key, useApp as useInkApp, useInput, useStdout } from 'ink';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COMMANDS,
  type CommandName,
  filterCommands,
  fuzzyScore,
  paletteQuery,
  parseInput,
  resolveCommand,
} from './commands';
import { ErrorCard, type ToastItem, Toasts } from './components/cards';
import { Header, type HeaderInfo, PromptBar, StatusLine } from './components/chrome';
import { Palette, type PaletteEntry } from './components/palette';
import { type Hint, T } from './components/primitives';
import { Wordmark } from './components/wordmark';
import {
  type AppApi,
  AppContext,
  KeyContext,
  type KeyLayer,
  type KeyRouter,
  ThemeContext,
  type ToastTone,
  type View,
} from './hooks/context';
import { useTick } from './hooks/motion';
import { safe, safeInput } from './sanitize';
import { ApproveScreen, DiffScreen, RemoveScreen, RollbackScreen } from './screens/actions';
import { AgentsScreen } from './screens/agents';
import { DetailScreen } from './screens/detail';
import { DoctorScreen } from './screens/doctor';
import { InstallFlow } from './screens/flow';
import { HelpScreen } from './screens/help';
import { HomeScreen, TAGLINE } from './screens/home';
import { ListScreen, VerifyScreen } from './screens/installed';
import { SearchScreen } from './screens/search';
import { UpdatesScreen } from './screens/updates';
import type { Overview, Session } from './session';
import { createTheme, type TerminalCaps, type ThemeName } from './theme';

export interface AppProps {
  session: Session;
  caps: TerminalCaps;
  version: string;
  initialTheme?: ThemeName;
  /** Skip the launch animation (tests, reduced motion). */
  skipIntro?: boolean;
  /** Fixed size (tests); otherwise the terminal's. */
  size?: { columns: number; rows: number };
  /** First screen (tests, dumps). */
  initialView?: View;
  /** Called when the app wants to exit, after a running write has finished. */
  onExit?: () => void;
}

/** Commands whose argument is an installed skill name. */
const SKILL_ARG: ReadonlySet<CommandName> = new Set([
  'remove',
  'diff',
  'approve',
  'rollback',
  'verify',
  'update',
]);
const FIXED_ARGS: Partial<Record<CommandName, readonly (readonly [string, string])[]>> = {
  scope: [
    ['project', 'this project (.agenthub/agenthub.lock)'],
    ['user', 'your user folders (~)'],
  ],
  theme: [
    ['dark', 'ink background, lime signal'],
    ['light', 'paper background'],
    ['mono', 'no colors'],
  ],
  registry: [
    ['set', 'use another registry for this session'],
    ['reset', 'back to the configured registry'],
  ],
};

function useTerminalSize(fixed: AppProps['size']): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const read = useCallback(
    () => ({
      columns: (stdout as { columns?: number }).columns || 100,
      rows: (stdout as { rows?: number }).rows || 30,
    }),
    [stdout],
  );
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (fixed !== undefined) return undefined;
    const onResize = (): void => setSize(read());
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, read, fixed]);
  return fixed ?? size;
}

function Intro({ onDone }: { onDone: () => void }) {
  const frame = useTick(60, true);
  // ~600 ms sweep, a short hold, then home.
  const progress = Math.min(1, (frame * 60) / 600);
  useEffect(() => {
    if (frame * 60 >= 760) onDone();
  }, [frame, onDone]);
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" flexGrow={1}>
      <Wordmark progress={progress} />
      <Box marginTop={1} height={1}>
        {progress > 0.55 ? <T tone="muted">{TAGLINE}</T> : null}
      </Box>
    </Box>
  );
}

export function App(props: AppProps) {
  const { session } = props;
  const ink = useInkApp();
  const size = useTerminalSize(props.size);
  const [themeName, setThemeName] = useState<ThemeName>(props.initialTheme ?? 'dark');
  const theme = useMemo(() => createTheme(themeName, props.caps), [themeName, props.caps]);
  const [intro, setIntro] = useState(!(props.skipIntro === true || !props.caps.motion));
  const [stack, setStack] = useState<View[]>([props.initialView ?? { kind: 'home' }]);
  const view = stack[stack.length - 1] ?? { kind: 'home' };
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [typing, setTyping] = useState(false);
  const [selection, setSelection] = useState({ key: '', index: 0 });
  const wasOpen = useRef(false);
  const opens = useRef(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<unknown>(null);
  const [busy, setBusyState] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const toastId = useRef(0);
  const layers = useRef<KeyLayer[]>([]);
  const [, setLayerVersion] = useState(0);

  // ---- toasts and notices -------------------------------------------------
  const toast = useCallback((tone: ToastTone, text: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((list) => [...list.slice(-2), { id, tone, text }]);
    setTimeout(
      () => setToasts((list) => list.filter((item) => item.id !== id)),
      tone === 'block' || tone === 'warn' ? 6000 : 3500,
    );
  }, []);
  useEffect(
    () => session.onNotice((text) => toast(/^warning:/.test(text) ? 'warn' : 'info', text)),
    [session, toast],
  );

  // ---- overview -----------------------------------------------------------
  const refresh = useCallback(() => {
    session.overview().then(
      (value) => {
        setOverview(value);
        setOverviewError(null);
      },
      (error: unknown) => setOverviewError(error),
    );
  }, [session]);
  useEffect(() => refresh(), [refresh]);

  // ---- navigation ---------------------------------------------------------
  const navigate = useCallback((next: View) => setStack((s) => [...s, next]), []);
  const replace = useCallback((next: View) => setStack((s) => [...s.slice(0, -1), next]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const home = useCallback(() => setStack([{ kind: 'home' }]), []);

  const quit = useCallback(() => {
    if (busy) {
      setQuitting(true);
      toast('info', 'finishing the running transaction, then leaving');
      return;
    }
    props.onExit?.();
    ink.exit();
  }, [busy, ink, props.onExit, toast]);
  useEffect(() => {
    if (quitting && !busy) {
      props.onExit?.();
      ink.exit();
    }
  }, [quitting, busy, ink, props.onExit]);

  const router = useMemo<KeyRouter>(
    () => ({
      push(layer) {
        layers.current = [...layers.current, layer];
        setLayerVersion((v) => v + 1);
        return () => {
          layers.current = layers.current.filter((l) => l !== layer);
          setLayerVersion((v) => v + 1);
        };
      },
    }),
    [],
  );
  const modal = layers.current.some((layer) => layer.modal);

  // ---- chrome sizing --------------------------------------------------------
  const paletteText = paletteQuery(input);
  const argMatch = /^\/(\S+)\s+(\S*)$/.exec(input);
  const argCommand = argMatch === null ? null : resolveCommand(argMatch[1] ?? '');
  const suggestions: PaletteEntry[] = (() => {
    if (paletteText !== null) {
      return filterCommands(paletteText).map(({ command, positions }) => ({
        id: command.name,
        value: `/${command.name}${command.args === undefined ? '' : ' '}`,
        label: `/${command.name}`,
        positions: positions.map((p) => p + 1),
        ...(command.args === undefined ? {} : { args: command.args }),
        description: command.description,
        tag: command.group.toLowerCase(),
      }));
    }
    if (argCommand === null || argMatch === null) return [];
    const typed = argMatch[2] ?? '';
    const options: (readonly [string, string])[] = SKILL_ARG.has(argCommand.name)
      ? (overview?.installed ?? []).map((name) => [name, 'installed'] as const)
      : [...(FIXED_ARGS[argCommand.name] ?? [])];
    return options
      .map(([value, description]) => ({ value, description, score: fuzzyScore(typed, value) }))
      .filter((option) => option.score !== null)
      .sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0))
      .map(({ value, description, score }) => ({
        id: value,
        value: `/${argCommand.name} ${value}${argCommand.name === 'registry' && value === 'set' ? ' ' : ''}`,
        label: safe(value),
        positions: score?.positions ?? [],
        description,
      }));
  })();
  const paletteOpen =
    !modal && !intro && (paletteText !== null || (argCommand !== null && suggestions.length > 0));
  // The selection starts at the top whenever the typed text changes; the reveal restarts each
  // time the palette opens.
  const selectionKey = `${paletteText ?? ''}|${argMatch?.[2] ?? ''}`;
  const selected = selection.key === selectionKey ? selection.index : 0;
  const setSelected = (update: (index: number) => number): void =>
    setSelection({ key: selectionKey, index: update(selected) });
  if ((paletteText !== null) !== wasOpen.current) {
    wasOpen.current = paletteText !== null;
    if (wasOpen.current) opens.current += 1;
  }
  const openKey = opens.current;

  const paletteRows = paletteOpen ? Math.min(8, Math.max(1, suggestions.length)) + 4 : 0;
  const toastRows = toasts.length * 3;
  const chromeRows = 1 + 1 + (modal ? 0 : 3) + 1 + paletteRows + toastRows;
  const contentRows = Math.max(6, size.rows - chromeRows);

  // ---- commands -------------------------------------------------------------
  const setPrompt = useCallback((text: string) => {
    setInput(text);
    setCursor(Array.from(text).length);
  }, []);

  const runCommand = useCallback(
    async (name: CommandName, args: string[]) => {
      const arg = args.join(' ').trim();
      const need = (): boolean => {
        if (arg !== '') return true;
        const command = COMMANDS.find((c) => c.name === name);
        setPrompt(`/${name} `);
        setTyping(true);
        toast('info', `/${name} ${command?.args ?? ''}`.trim());
        return false;
      };
      switch (name) {
        case 'search':
          if (need()) navigate({ kind: 'search', query: arg });
          return;
        case 'install':
          if (need()) navigate({ kind: 'install', target: arg });
          return;
        case 'remove':
          if (need()) navigate({ kind: 'remove', name: arg });
          return;
        case 'diff':
          if (need()) navigate({ kind: 'diff', name: arg });
          return;
        case 'approve':
          if (need()) navigate({ kind: 'approve', name: arg });
          return;
        case 'rollback':
          if (need()) navigate({ kind: 'rollback', name: arg });
          return;
        case 'list':
          navigate({ kind: 'list' });
          return;
        case 'update':
          navigate(arg === '' ? { kind: 'updates' } : { kind: 'updates', name: arg });
          return;
        case 'verify':
          navigate(arg === '' ? { kind: 'verify' } : { kind: 'verify', name: arg });
          return;
        case 'doctor':
          navigate({ kind: 'doctor' });
          return;
        case 'agents':
          navigate({ kind: 'agents' });
          return;
        case 'help':
          navigate({ kind: 'help' });
          return;
        case 'clear':
          home();
          setToasts([]);
          return;
        case 'quit':
          quit();
          return;
        case 'theme': {
          const order: ThemeName[] = ['dark', 'light', 'mono'];
          const next =
            arg === ''
              ? (order[(order.indexOf(themeName) + 1) % order.length] ?? 'dark')
              : (order.find((t) => t === arg) ?? null);
          if (next === null) {
            toast('block', `unknown theme "${safe(arg)}" — dark, light or mono`);
            return;
          }
          setThemeName(next);
          toast(
            'signal',
            `theme ${next}${next !== 'mono' && props.caps.depth === 'none' ? ' (colors are off: NO_COLOR or --no-color)' : ''}`,
          );
          return;
        }
        case 'scope': {
          const current = overview?.scope ?? (await session.scope());
          const next = arg === '' ? (current === 'project' ? 'user' : 'project') : arg;
          if (next !== 'project' && next !== 'user') {
            toast('block', `unknown scope "${safe(arg)}" — project or user`);
            return;
          }
          try {
            const scope = await session.setScope(next);
            toast('signal', `scope ${scope}`);
            refresh();
          } catch (error) {
            toast('block', error instanceof Error ? error.message : String(error));
          }
          return;
        }
        case 'registry': {
          const [verb, ...rest] = args;
          try {
            if (verb === 'set') {
              const value = rest.join(' ').trim();
              if (value === '') {
                setPrompt('/registry set ');
                setTyping(true);
                toast('info', '/registry set <https://… | file:folder>');
                return;
              }
              const id = await session.setRegistry(value);
              toast(
                'signal',
                `registry ${safe(id ?? '')} for this session (persist with agenthub config set registry … -g)`,
              );
              refresh();
              return;
            }
            if (verb === 'reset') {
              const id = await session.setRegistry(null);
              toast('signal', id === null ? 'registry: none configured' : `registry ${safe(id)}`);
              refresh();
              return;
            }
            if (verb !== undefined) {
              toast(
                'block',
                `/registry ${safe(verb)}: use /registry, /registry set <url> or /registry reset`,
              );
              return;
            }
            const info = overview?.registry;
            if (info === undefined || info.id === null) {
              toast('warn', 'no registry configured — /registry set <https://… | file:folder>');
            } else {
              toast('info', `registry ${safe(info.id)} (${info.source ?? 'default'})`);
            }
          } catch (error) {
            toast('block', error instanceof Error ? error.message : String(error));
          }
          return;
        }
      }
    },
    [
      navigate,
      home,
      quit,
      toast,
      setPrompt,
      themeName,
      overview,
      session,
      refresh,
      props.caps.depth,
    ],
  );

  const submit = useCallback(
    (text: string) => {
      const parsed = parseInput(text);
      setPrompt('');
      setTyping(false);
      if (parsed.kind === 'empty') return;
      if (parsed.kind === 'search') {
        if (view.kind === 'search') replace({ kind: 'search', query: parsed.query });
        else navigate({ kind: 'search', query: parsed.query });
        return;
      }
      if (parsed.command === null) {
        toast('block', `unknown command /${safe(parsed.name)} — type / to list them`);
        return;
      }
      void runCommand(parsed.command.name, parsed.args);
    },
    [setPrompt, view.kind, replace, navigate, toast, runCommand],
  );

  // Live refine: plain text typed on the results screen updates the query.
  useEffect(() => {
    if (view.kind !== 'search' || input === '' || input.startsWith('/')) return;
    if (input.trim() !== view.query) replace({ kind: 'search', query: input.trim() });
  }, [input, view, replace]);

  const setBusy = useCallback((value: boolean) => setBusyState(value), []);
  const api: AppApi = useMemo(
    () => ({
      session,
      navigate,
      replace,
      back,
      home,
      toast,
      refresh,
      setBusy,
      rows: contentRows,
      columns: size.columns,
    }),
    [session, navigate, replace, back, home, toast, refresh, setBusy, contentRows, size.columns],
  );

  // ---- keys -----------------------------------------------------------------
  const dispatch = (list: KeyLayer[], text: string, key: Key): boolean => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.handler.current(text, key)) return true;
    }
    return false;
  };

  const edit = (text: string): void => {
    const chars = Array.from(input);
    const insert = Array.from(safeInput(text));
    if (insert.length === 0) return;
    const next = [...chars.slice(0, cursor), ...insert, ...chars.slice(cursor)].join('');
    setInput(next.slice(0, 512));
    setCursor(Math.min(cursor + insert.length, 512));
  };

  useInput((text, key) => {
    if (key.ctrl && text === 'c') {
      quit();
      return;
    }
    if (intro) {
      setIntro(false);
      return;
    }
    const all = layers.current;
    const modals = all.filter((layer) => layer.modal);
    if (modals.length > 0) {
      dispatch(modals, text, key);
      return;
    }
    const chars = Array.from(input);

    if (paletteOpen && suggestions.length > 0) {
      if (key.upArrow) {
        setSelected((s) => (s - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (key.downArrow) {
        setSelected((s) => (s + 1) % suggestions.length);
        return;
      }
      const entry = suggestions[Math.min(selected, suggestions.length - 1)];
      if (key.tab && entry !== undefined) {
        setPrompt(entry.value);
        return;
      }
      if (key.return && entry !== undefined) {
        const command = paletteText !== null ? resolveCommand(entry.id) : null;
        if (command !== null && command.needsArg === true) {
          setPrompt(entry.value);
          return;
        }
        if (entry.value.endsWith(' ') && paletteText === null) {
          setPrompt(entry.value);
          return;
        }
        submit(entry.value);
        return;
      }
    }

    if (key.return) {
      if (input.trim() === '') {
        dispatch(all, text, key);
        return;
      }
      submit(input);
      return;
    }
    if (key.escape) {
      if (input !== '' || typing) {
        setPrompt('');
        setTyping(false);
        return;
      }
      if (!dispatch(all, text, key)) back();
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        const next = [...chars.slice(0, cursor - 1), ...chars.slice(cursor)].join('');
        setInput(next);
        setCursor(cursor - 1);
      }
      return;
    }
    if (input !== '' && (key.leftArrow || key.rightArrow || key.home || key.end)) {
      if (key.leftArrow) setCursor(Math.max(0, cursor - 1));
      if (key.rightArrow) setCursor(Math.min(chars.length, cursor + 1));
      if (key.home) setCursor(0);
      if (key.end) setCursor(chars.length);
      return;
    }
    if (key.ctrl && text === 'u') {
      setPrompt('');
      return;
    }
    if (key.ctrl && text === 'w') {
      const head = chars
        .slice(0, cursor)
        .join('')
        .replace(/\S+\s*$/, '');
      setInput(head + chars.slice(cursor).join(''));
      setCursor(Array.from(head).length);
      return;
    }

    const promptActive = input !== '' || typing || view.kind === 'home';
    if (!promptActive || (input === '' && !typing)) {
      // Screen keys first while the prompt is empty.
      if (input === '' && dispatch(all, text, key)) return;
      if (input === '' && text === '?') {
        navigate({ kind: 'help' });
        return;
      }
      if (input === '' && key.tab && view.kind !== 'home') {
        setTyping(true);
        return;
      }
    }
    if (input === 'q' && text === 'q' && view.kind === 'home') {
      quit();
      return;
    }
    // Navigation keys reach the screen even while typing (e.g. moving through live results).
    if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      dispatch(all, text, key);
      return;
    }
    if (key.ctrl || key.meta || key.tab || text === '') return;
    if (!promptActive && text !== '/' && input === '') return;
    if (input === '' && text === 'q' && view.kind === 'home')
      toast('info', 'press q again to quit');
    edit(text);
  });

  // ---- screen ---------------------------------------------------------------
  const applyAgents = (agents: AgentId[] | null): void => {
    try {
      session.setAgents(agents);
      toast(
        'signal',
        agents === null ? 'targeting the detected agents' : `targeting ${agents.join(', ')}`,
      );
      refresh();
      back();
    } catch (error) {
      toast('block', error instanceof Error ? error.message : String(error));
    }
  };

  let screen: ReactNode;
  switch (view.kind) {
    case 'home':
      screen =
        overviewError !== null && overview === null ? (
          <Box paddingX={1} flexDirection="column">
            <ErrorCard what="Could not read this machine's state" error={overviewError} />
          </Box>
        ) : (
          <HomeScreen overview={overview} rows={contentRows} columns={size.columns} />
        );
      break;
    case 'search':
      screen = <SearchScreen query={view.query} />;
      break;
    case 'detail':
      screen = <DetailScreen key={view.name} name={view.name} />;
      break;
    case 'install':
      screen = <InstallFlow key={`i:${view.target}`} mode="install" target={view.target} />;
      break;
    case 'update-flow':
      screen = <InstallFlow key={`u:${view.name}`} mode="update" target={view.name} />;
      break;
    case 'updates':
      screen = <UpdatesScreen {...(view.name === undefined ? {} : { name: view.name })} />;
      break;
    case 'list':
      screen = <ListScreen />;
      break;
    case 'verify':
      screen = <VerifyScreen {...(view.name === undefined ? {} : { name: view.name })} />;
      break;
    case 'doctor':
      screen = <DoctorScreen />;
      break;
    case 'diff':
      screen = <DiffScreen key={view.name} name={view.name} />;
      break;
    case 'approve':
      screen = <ApproveScreen key={view.name} name={view.name} />;
      break;
    case 'remove':
      screen = <RemoveScreen key={view.name} name={view.name} />;
      break;
    case 'rollback':
      screen = <RollbackScreen key={view.name} name={view.name} />;
      break;
    case 'agents':
      screen = (
        <AgentsScreen
          detected={overview?.agents ?? []}
          selected={overview?.selectedAgents ?? session.selectedAgents()}
          onApply={applyAgents}
        />
      );
      break;
    case 'help':
      screen = <HelpScreen />;
      break;
  }

  const g = theme.glyphs;
  const header: HeaderInfo = {
    registry: overview?.registry.id ?? null,
    registrySource: overview?.registry.source,
    registryError: overview?.registry.error ?? null,
    scope: overview?.scope ?? null,
    agents: overview?.agents ?? [],
    selected: overview?.selectedAgents,
    loading: overview === null && overviewError === null,
  };
  const hints: Hint[] = paletteOpen
    ? []
    : view.kind === 'home'
      ? [
          ['/', 'commands'],
          ['enter', 'search'],
          ['?', 'help'],
          ['q q', 'quit'],
        ]
      : [
          ['/', 'commands'],
          ['tab', 'type'],
          ['esc', 'back'],
          ['?', 'help'],
          ['ctrl+c', 'quit'],
        ];
  const promptFocused = input !== '' || typing || view.kind === 'home';
  const ghost =
    argCommand !== null &&
    argMatch !== null &&
    (argMatch[2] ?? '') === '' &&
    argCommand.args !== undefined
      ? argCommand.args
      : undefined;

  return (
    <ThemeContext.Provider value={theme}>
      <AppContext.Provider value={api}>
        <KeyContext.Provider value={router}>
          <Box flexDirection="column" width={size.columns} height={size.rows}>
            {intro ? (
              <Intro onDone={() => setIntro(false)} />
            ) : (
              <>
                <Header info={header} version={props.version} columns={size.columns} />
                <Box paddingX={1}>
                  <T tone="border">{g.hr.repeat(Math.max(0, size.columns - 2))}</T>
                </Box>
                <Box flexDirection="column" flexGrow={1} height={contentRows} overflow="hidden">
                  <Box flexDirection="column" flexShrink={0}>
                    {screen}
                  </Box>
                </Box>
                <Toasts items={toasts} />
                {paletteOpen ? (
                  <Palette
                    title={
                      paletteText !== null
                        ? 'Commands'
                        : `/${argCommand?.name ?? ''} ${g.sep} ${SKILL_ARG.has(argCommand?.name ?? 'list') ? 'installed skills' : 'options'}`
                    }
                    entries={suggestions}
                    selected={Math.min(selected, Math.max(0, suggestions.length - 1))}
                    width={size.columns}
                    empty="No command matches. Plain text searches the registry."
                    openKey={openKey}
                  />
                ) : null}
                {modal ? null : (
                  <PromptBar
                    value={input}
                    cursor={cursor}
                    focused={promptFocused}
                    {...(ghost === undefined ? {} : { ghost })}
                  />
                )}
                <StatusLine
                  hints={hints}
                  busy={busy ? (quitting ? 'finishing, then leaving' : 'working') : null}
                />
              </>
            )}
          </Box>
        </KeyContext.Provider>
      </AppContext.Provider>
    </ThemeContext.Provider>
  );
}
