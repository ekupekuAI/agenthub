/**
 * Starts the interactive mode for `agenthub` with no command on a terminal. Scripts, pipes, CI
 * and every subcommand keep the classic CLI: this module is only loaded when the interactive mode
 * is requested, and Ink and React are loaded only after the decision.
 */
import type { Runtime } from '../context';
import { asciiFold, detectCaps, forceColorLevel, windowsBuild } from './theme';

export interface TuiRequest {
  /** -g / --global: start in the user scope. */
  global: boolean;
  /** false with --no-color. */
  color: boolean;
}

function truthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no' && v !== 'off';
}

/** Flags that may accompany `agenthub` without a command and still open the interactive mode. */
const TUI_FLAGS = new Set(['--no-color', '-g', '--global']);

/**
 * The interactive mode opens only for `agenthub` (optionally with --no-color or -g) when stdin
 * and stdout are terminals, outside CI, on a terminal that is not "dumb", and without
 * AGENTHUB_NO_TUI. Anything else returns null and the classic CLI runs unchanged.
 */
export function tuiRequest(
  argv: readonly string[],
  runtime: Pick<Runtime, 'env' | 'stdin' | 'stdout'>,
): TuiRequest | null {
  if (!argv.every((arg) => TUI_FLAGS.has(arg))) return null;
  const env = runtime.env;
  if (truthy(env.AGENTHUB_NO_TUI)) return null;
  if (truthy(env.CI)) return null;
  if (env.TERM === 'dumb') return null;
  if (runtime.stdin.isTTY !== true || runtime.stdout.isTTY !== true) return null;
  return {
    global: argv.includes('-g') || argv.includes('--global'),
    color: !argv.includes('--no-color'),
  };
}

/** A view of an output stream whose text is folded to ASCII (AGENTHUB_ASCII=1). */
export function asciiStream<S extends { write(chunk: string, ...rest: never[]): unknown }>(
  stream: S,
): S {
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === 'write') {
        return (chunk: unknown, ...rest: unknown[]) =>
          (target.write as (...args: unknown[]) => unknown).call(
            target,
            typeof chunk === 'string' ? asciiFold(chunk) : chunk,
            ...rest,
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Runs the interactive app until the user leaves; returns the exit code. */
export async function launchTui(
  request: TuiRequest,
  runtime: Runtime,
  version: string,
): Promise<number> {
  const caps = detectCaps({
    env: runtime.env,
    platform: process.platform,
    colorFlag: request.color,
    windowsBuild: process.platform === 'win32' ? windowsBuild() : 0,
  });
  // Ink draws through chalk, which reads FORCE_COLOR when it loads: make it draw exactly the
  // color depth the theme was built for (none with NO_COLOR or --no-color).
  if (process.env.FORCE_COLOR === undefined) process.env.FORCE_COLOR = forceColorLevel(caps.depth);
  const [{ render }, { createElement }, { App }, { Session }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./app'),
    import('./session'),
  ]);
  const session = new Session({ runtime, global: request.global, color: request.color });
  const instance = render(createElement(App, { session, caps, version }), {
    stdout: (caps.glyphs === 'ascii'
      ? asciiStream(runtime.stdout as NodeJS.WriteStream)
      : runtime.stdout) as NodeJS.WriteStream,
    stderr: runtime.stderr as NodeJS.WriteStream,
    stdin: runtime.stdin as NodeJS.ReadStream,
    exitOnCtrlC: false,
    alternateScreen: true,
    incrementalRendering: true,
    patchConsole: true,
    maxFps: 30,
  });
  await instance.waitUntilExit();
  return 0;
}
