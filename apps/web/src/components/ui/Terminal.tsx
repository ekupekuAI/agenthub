'use client';

import { motion, useInView } from 'motion/react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '../../lib/cn';
import { keyed } from '../../lib/keys';
import { usePrefersReducedMotion } from './hooks';
import { CheckIcon, RotateCcwIcon } from './icons';
import { TabList, tabId, tabPanelId } from './Tabs';

/*
 * Sequenced terminal, adapted from the Magic UI "Terminal". Items inside a sequence run one
 * at a time: each starts when it becomes the active index and reports completion so the
 * next one can begin. The sequence only advances while the terminal is on screen.
 */

interface SequenceValue {
  activeIndex: number;
  /** False while the terminal is off screen: nothing starts and typing pauses. */
  playing: boolean;
  completeItem: (index: number) => void;
}

const SequenceContext = createContext<SequenceValue | null>(null);
const ItemIndexContext = createContext<number | null>(null);

export interface AnimatedSpanProps {
  children: ReactNode;
  /** Milliseconds to wait before the reveal starts. */
  delay?: number;
  /** Outside a Terminal sequence: wait until the element scrolls into view. */
  startOnView?: boolean;
  className?: string;
}

/** A line that fades in and settles 4px. Inside a Terminal it waits for its turn. */
export function AnimatedSpan({
  children,
  delay = 0,
  startOnView = false,
  className,
}: AnimatedSpanProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { amount: 0.3, once: true });
  const sequence = useContext(SequenceContext);
  const index = useContext(ItemIndexContext);
  const inSequence = sequence !== null && index !== null;
  const [started, setStarted] = useState(false);

  const isTurn = inSequence && sequence.playing && sequence.activeIndex === index;
  useEffect(() => {
    if (isTurn) setStarted(true);
  }, [isTurn]);

  const show = inSequence ? started : startOnView ? inView : true;

  return (
    <motion.div
      ref={ref}
      data-reveal=""
      className={className}
      initial={{ opacity: 0, y: -4 }}
      animate={show ? { opacity: 1, y: 0 } : { opacity: 0, y: -4 }}
      transition={{ duration: 0.3, ease: 'easeOut', delay: delay / 1000 }}
      onAnimationComplete={() => {
        if (show && inSequence) sequence.completeItem(index);
      }}
    >
      {children}
    </motion.div>
  );
}

export interface TypingAnimationProps {
  /** The text to type. */
  children: string;
  /** Milliseconds per character. */
  duration?: number;
  /** Milliseconds to wait before typing starts. */
  delay?: number;
  /** Outside a Terminal sequence: wait until the element scrolls into view. Default true. */
  startOnView?: boolean;
  /** Show a block cursor while typing. */
  cursor?: boolean;
  className?: string;
}

/** Types its text one character at a time. Inside a Terminal it waits for its turn. */
export function TypingAnimation({
  children: text,
  duration = 28,
  delay = 0,
  startOnView = true,
  cursor = false,
  className,
}: TypingAnimationProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const inView = useInView(ref, { amount: 0.3, once: true });
  const sequence = useContext(SequenceContext);
  const index = useContext(ItemIndexContext);
  const inSequence = sequence !== null && index !== null;
  const [started, setStarted] = useState(false);
  const [count, setCount] = useState(0);

  const playing = inSequence ? sequence.playing : true;
  const isTurn = inSequence
    ? sequence.playing && sequence.activeIndex === index
    : !startOnView || inView;
  const done = count >= text.length;
  const completeItem = sequence?.completeItem;

  useEffect(() => {
    if (started || !isTurn) return;
    const timer = setTimeout(() => setStarted(true), delay);
    return () => clearTimeout(timer);
  }, [started, isTurn, delay]);

  useEffect(() => {
    if (!started || done || !playing) return;
    const timer = setInterval(() => setCount((current) => current + 1), duration);
    return () => clearInterval(timer);
  }, [started, done, playing, duration]);

  useEffect(() => {
    if (started && done && completeItem && index !== null) completeItem(index);
  }, [started, done, completeItem, index]);

  return (
    <span ref={ref} className={className}>
      {text.slice(0, count)}
      {cursor && started && !done ? <TerminalCursor /> : null}
    </span>
  );
}

function TerminalCursor({ blink = false }: { blink?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'ml-px inline-block h-[1.05em] w-[0.55em] translate-y-[0.18em] rounded-[1px] bg-signal',
        blink && 'animate-cursor',
      )}
    />
  );
}

export type TerminalLineKind =
  | 'command'
  | 'out'
  | 'info'
  | 'warn'
  | 'block'
  | 'ok'
  | 'error'
  | 'dim';

export interface TerminalLine {
  /**
   * `command` is typed after a `$` prompt. `info`, `warn` and `block` get a colored
   * INFO / WARN / BLOCK tag, `ok` gets a check mark: do not repeat those in `text`.
   * `error` is an untagged failure line in the block color (write its own glyph, e.g. ✘).
   * `out` is plain output and `dim` is de-emphasized output.
   */
  kind: TerminalLineKind;
  text: string;
}

export interface TerminalScenario {
  id: string;
  /** Tab label. Keep it short (one or two words). */
  label: string;
  lines: TerminalLine[];
  /** One sentence describing the outcome, used as the accessible name of the recording. */
  summary?: string;
}

export interface TerminalProps {
  scenarios: TerminalScenario[];
  /** Window title shown in the chrome from 640px up. */
  title?: string;
  /** Milliseconds per typed character. */
  typingSpeed?: number;
  className?: string;
}

const TAGS: Partial<Record<TerminalLineKind, { tag: string; color: string }>> = {
  info: { tag: 'INFO', color: 'text-info' },
  warn: { tag: 'WARN', color: 'text-warn' },
  block: { tag: 'BLOCK', color: 'text-block' },
};

const TEXT_COLOR: Record<TerminalLineKind, string> = {
  command: 'text-text',
  out: 'text-muted',
  info: 'text-muted',
  warn: 'text-text',
  block: 'text-text',
  ok: 'text-text',
  error: 'font-medium text-block',
  dim: 'text-subtle',
};

const ROW = 'flex min-h-[1.375rem] items-baseline gap-[1ch]';
const WRAP = 'min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]';

function transcriptOf(line: TerminalLine): string {
  if (line.kind === 'command') return `$ ${line.text}`;
  if (line.kind === 'ok') return `✔ ${line.text}`;
  const tag = TAGS[line.kind]?.tag;
  return tag ? `${tag} ${line.text}` : line.text;
}

function OutputRow({ line }: { line: TerminalLine }) {
  const tag = TAGS[line.kind];
  return (
    <div className={cn(ROW, TEXT_COLOR[line.kind])}>
      {tag ? (
        <span className={cn('w-[5ch] shrink-0 font-medium', tag.color)}>{tag.tag}</span>
      ) : null}
      {line.kind === 'ok' ? (
        <CheckIcon size={14} className="translate-y-[2px] self-start text-signal-ink" />
      ) : null}
      <span className={WRAP}>{line.text}</span>
    </div>
  );
}

function CommandRow({
  line,
  instant,
  typingSpeed,
  delay,
}: {
  line: TerminalLine;
  instant: boolean;
  typingSpeed: number;
  delay: number;
}) {
  const sequence = useContext(SequenceContext);
  const index = useContext(ItemIndexContext);
  // The prompt of a command that has not been reached yet stays invisible but keeps its row.
  const reached = instant || sequence === null || index === null || sequence.activeIndex >= index;
  return (
    <div
      data-pending={reached ? undefined : ''}
      className={cn(ROW, 'text-text', !reached && 'invisible')}
    >
      <span className="shrink-0 select-none text-subtle">$</span>
      {instant ? (
        <span className={WRAP}>{line.text}</span>
      ) : (
        <>
          <TypingAnimation duration={typingSpeed} delay={delay} cursor className={WRAP}>
            {line.text}
          </TypingAnimation>
          {/* Nothing types without JavaScript: show the whole command instead. */}
          <noscript>
            <span className={WRAP}>{line.text}</span>
          </noscript>
        </>
      )}
    </div>
  );
}

function TerminalScreen({
  scenario,
  instant,
  typingSpeed,
  rows,
}: {
  scenario: TerminalScenario;
  instant: boolean;
  typingSpeed: number;
  rows: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref, { amount: 0.3 });
  const [activeIndex, setActiveIndex] = useState(0);
  const completeItem = useCallback((index: number) => {
    setActiveIndex((current) => (index === current ? current + 1 : current));
  }, []);
  const sequence = useMemo<SequenceValue>(
    () => ({ activeIndex, playing: inView, completeItem }),
    [activeIndex, inView, completeItem],
  );
  const lines = keyed(scenario.lines, (line) => `${line.kind}:${line.text}`);
  const finished = instant || activeIndex >= scenario.lines.length;

  return (
    <div ref={ref}>
      <div
        role="img"
        aria-label={scenario.summary ?? `Terminal recording: ${scenario.label}`}
        className="px-4 py-4 font-mono text-mono sm:px-5 sm:py-5"
        style={{ minHeight: `calc(${rows} * 1.375rem + 2.5rem)` }}
      >
        <SequenceContext.Provider value={instant ? null : sequence}>
          {lines.map(({ item: line, key }, index) => {
            const afterCommand = scenario.lines[index - 1]?.kind === 'command';
            return (
              <ItemIndexContext.Provider key={key} value={index}>
                {line.kind === 'command' ? (
                  <CommandRow
                    line={line}
                    instant={instant}
                    typingSpeed={typingSpeed}
                    delay={index === 0 ? 350 : 650}
                  />
                ) : instant ? (
                  <OutputRow line={line} />
                ) : (
                  <AnimatedSpan delay={afterCommand ? 320 : 70}>
                    <OutputRow line={line} />
                  </AnimatedSpan>
                )}
              </ItemIndexContext.Provider>
            );
          })}
        </SequenceContext.Provider>
        <div className={cn(ROW, 'text-text', !finished && 'invisible')}>
          <span className="shrink-0 select-none text-subtle">$</span>
          <TerminalCursor blink />
        </div>
      </div>
      <div className="sr-only">
        <p>Transcript: {scenario.label}</p>
        <ol>
          {lines.map(({ item: line, key }) => (
            <li key={key}>{transcriptOf(line)}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * A terminal window that plays scripted CLI sessions. Commands are typed, output lines are
 * revealed in order, and tabs switch between scenarios (switching replays). It pauses while
 * off screen, and under prefers-reduced-motion every line is shown at once. The animated
 * screen is exposed as an image with a summary; a visually hidden transcript holds the text.
 * The window is always dark, on both themes.
 */
export function Terminal({
  scenarios,
  title = 'agenthub',
  typingSpeed = 28,
  className,
}: TerminalProps) {
  const idBase = useId();
  const reduced = usePrefersReducedMotion();
  const [selected, setSelected] = useState(scenarios[0]?.id ?? '');
  const [run, setRun] = useState(0);
  const scenario = scenarios.find((item) => item.id === selected) ?? scenarios[0];
  if (!scenario) return null;

  const rows = Math.max(...scenarios.map((item) => item.lines.length)) + 1;
  const hasTabs = scenarios.length > 1;
  // Remounting restarts the sequence: on tab change, on replay and when motion is reduced.
  const screen = (
    <TerminalScreen
      key={`${scenario.id}:${run}:${reduced ? 'static' : 'play'}`}
      scenario={scenario}
      instant={reduced}
      typingSpeed={typingSpeed}
      rows={rows}
    />
  );

  return (
    <div
      className={cn(
        'theme-dark overflow-hidden rounded-panel border border-border-strong bg-surface-1 text-left shadow-panel',
        className,
      )}
    >
      <div className="flex min-h-11 items-center gap-2 border-border border-b bg-surface-2 py-1 pr-1.5 pl-3 sm:gap-3 sm:pl-4">
        <span aria-hidden="true" className="flex shrink-0 gap-1.5">
          <span className="size-2.5 rounded-full border border-border-strong" />
          <span className="size-2.5 rounded-full border border-border-strong" />
          <span className="size-2.5 rounded-full border border-border-strong" />
        </span>
        {hasTabs ? (
          <TabList
            tabs={scenarios.map((item) => ({ id: item.id, label: item.label }))}
            value={scenario.id}
            onChange={(id) => {
              setSelected(id);
              setRun(0);
            }}
            idBase={idBase}
            label="Terminal scenarios"
            variant="chrome"
            className="min-w-0 flex-1"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-subtle">
            {title}
          </span>
        )}
        {hasTabs ? (
          <span className="hidden shrink-0 font-mono text-[0.75rem] text-subtle sm:block">
            {title}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setRun((current) => current + 1)}
          className="tap-target inline-flex size-8 shrink-0 items-center justify-center rounded-chip text-subtle transition-colors duration-150 hover:bg-surface-3 hover:text-text"
        >
          <RotateCcwIcon size={15} />
          <span className="sr-only">Replay</span>
        </button>
      </div>
      {hasTabs ? (
        <div
          role="tabpanel"
          id={tabPanelId(idBase, scenario.id)}
          aria-labelledby={tabId(idBase, scenario.id)}
        >
          {screen}
        </div>
      ) : (
        screen
      )}
    </div>
  );
}
