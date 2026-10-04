/**
 * Output for humans and machines (design §10).
 *
 * Human mode: results on stdout, progress and warnings on stderr, colors only on a TTY.
 * JSON mode: exactly one JSON object on stdout; nothing else is written there.
 */
import { AgentHubError, type ErrorCode, EXIT_CODES } from '@agenthub/core';

export interface OutStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

export interface SuccessEnvelope {
  ok: true;
  command: string;
  data: unknown;
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  error: { code: string; message: string; details?: unknown };
}

export type Envelope = SuccessEnvelope | ErrorEnvelope;

// ---------------------------------------------------------------------------
// Terminal-injection guard
// ---------------------------------------------------------------------------

function isControl(code: number, keepNewlines: boolean): boolean {
  if (keepNewlines && (code === 0x0a || code === 0x09)) return false;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Removes C0 and C1 control characters (and DEL). Used on every string that came from a
 * package, a registry or the file system before it reaches a terminal.
 */
export function stripControl(text: string, opts: { keepNewlines?: boolean } = {}): string {
  const keep = opts.keepNewlines === true;
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (!isControl(code, keep)) out += char;
  }
  return out;
}

/** Shorthand for untrusted single-line values. */
export function clean(value: unknown): string {
  return stripControl(String(value ?? ''));
}

const SGR = /^\[[0-9;]*m/;

/**
 * Final pass over a human-readable line: keeps newlines, tabs and (when colors are on) our own
 * SGR color sequences; drops every other control character.
 */
export function sanitizeForTerminal(text: string, allowColor: boolean): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x1b && allowColor) {
      const match = SGR.exec(text.slice(index + 1, index + 16));
      if (match !== null) {
        out += `\u001b${match[0]}`;
        index += 1 + match[0].length;
        continue;
      }
    }
    if (!isControl(code, true)) out += text[index];
    index += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Envelopes and exit codes
// ---------------------------------------------------------------------------

const ERROR_CODES = new Set<string>(Object.keys(EXIT_CODES));

/** AgentHubError check that also accepts errors from a second copy of the core module. */
export function asAgentHubError(error: unknown): AgentHubError | null {
  if (error instanceof AgentHubError) return error;
  if (!(error instanceof Error) || error.name !== 'AgentHubError') return null;
  const { code, details } = error as Error & { code?: unknown; details?: unknown };
  if (typeof code === 'string' && ERROR_CODES.has(code)) {
    return new AgentHubError(code as ErrorCode, error.message, details);
  }
  return null;
}

export function exitCodeFor(error: unknown): number {
  const known = asAgentHubError(error);
  return known === null ? EXIT_CODES.INTERNAL : EXIT_CODES[known.code];
}

export function successEnvelope(command: string, data: unknown): SuccessEnvelope {
  return { ok: true, command, data: data ?? null };
}

export function errorEnvelope(command: string, error: unknown, verbose = false): ErrorEnvelope {
  const known = asAgentHubError(error);
  if (known !== null) {
    const body: ErrorEnvelope['error'] = { code: known.code, message: known.message };
    if (known.details !== undefined) body.details = known.details;
    return { ok: false, command, error: body };
  }
  const message = error instanceof Error ? error.message : String(error);
  const body: ErrorEnvelope['error'] = {
    code: 'INTERNAL',
    message: `unexpected internal error: ${message}`,
  };
  if (verbose && error instanceof Error && error.stack !== undefined) {
    body.details = { stack: error.stack };
  }
  return { ok: false, command, error: body };
}

/**
 * Serializes an envelope. JSON.stringify already escapes C0 characters; DEL and C1 characters
 * are escaped too so raw bytes can never act as terminal controls.
 */
export function toJson(envelope: Envelope): string {
  const raw = JSON.stringify(envelope, jsonReplacer, 2);
  let out = '';
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    out += code >= 0x7f && code <= 0x9f ? `\\u${code.toString(16).padStart(4, '0')}` : char;
  }
  return out;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { bytes: value.byteLength };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

/** Colors are used only on a TTY, never with NO_COLOR set (non-empty) or --no-color. */
export function colorEnabled(
  stream: OutStream,
  env: Record<string, string | undefined>,
  flag: boolean,
): boolean {
  if (!flag) return false;
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  return stream.isTTY === true;
}

function sgr(open: number, close: number): (text: string) => string {
  return (text) => `\u001b[${open}m${text}\u001b[${close}m`;
}

const identity = (text: string): string => text;

export function createStyle(enabled: boolean): Style {
  if (!enabled) {
    return {
      bold: identity,
      dim: identity,
      red: identity,
      green: identity,
      yellow: identity,
      cyan: identity,
    };
  }
  return {
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    red: sgr(31, 39),
    green: sgr(32, 39),
    yellow: sgr(33, 39),
    cyan: sgr(36, 39),
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface OutputOptions {
  json: boolean;
  verbose: boolean;
  color: boolean;
  env: Record<string, string | undefined>;
  stdout: OutStream;
  stderr: OutStream;
}

export class Output {
  readonly json: boolean;
  readonly verbose: boolean;
  /** Style for stdout. */
  readonly style: Style;
  /** Style for stderr. */
  readonly errStyle: Style;
  private readonly stdout: OutStream;
  private readonly stderr: OutStream;
  private readonly stdoutColor: boolean;
  private readonly stderrColor: boolean;
  private emitted = false;

  constructor(opts: OutputOptions) {
    this.json = opts.json;
    this.verbose = opts.verbose;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.stdoutColor = !opts.json && colorEnabled(opts.stdout, opts.env, opts.color);
    this.stderrColor = colorEnabled(opts.stderr, opts.env, opts.color);
    this.style = createStyle(this.stdoutColor);
    this.errStyle = createStyle(this.stderrColor);
  }

  /** A result line on stdout (human mode only). */
  print(text = ''): void {
    if (this.json) return;
    this.stdout.write(`${sanitizeForTerminal(text, this.stdoutColor)}\n`);
  }

  lines(texts: string[]): void {
    for (const text of texts) this.print(text);
  }

  /** Progress on stderr (human mode only). */
  progress(text: string): void {
    if (this.json) return;
    this.stderr.write(`${sanitizeForTerminal(text, this.stderrColor)}\n`);
  }

  /** A notice on stderr, shown in both modes (stdout stays machine-readable). */
  notice(text: string): void {
    this.stderr.write(`${sanitizeForTerminal(text, this.stderrColor)}\n`);
  }

  warn(text: string): void {
    this.notice(`${this.errStyle.yellow('warning:')} ${text}`);
  }

  /** Raw prompt text on stderr (no newline). */
  promptText(text: string): void {
    this.stderr.write(sanitizeForTerminal(text, this.stderrColor));
  }

  success(command: string, data: unknown): void {
    if (!this.json || this.emitted) return;
    this.emitted = true;
    this.stdout.write(`${toJson(successEnvelope(command, data))}\n`);
  }

  failure(command: string, error: unknown): void {
    if (this.json) {
      if (this.emitted) return;
      this.emitted = true;
      this.stdout.write(`${toJson(errorEnvelope(command, error, this.verbose))}\n`);
      return;
    }
    const envelope = errorEnvelope(command, error, this.verbose);
    const s = this.errStyle;
    this.notice(`${s.red('error:')} ${clean(envelope.error.message)}`);
    for (const line of describeDetails(asAgentHubError(error)?.details)) {
      this.notice(`  ${line}`);
    }
    if (this.verbose) {
      if (asAgentHubError(error) === null && error instanceof Error && error.stack) {
        this.notice(s.dim(stripControl(error.stack, { keepNewlines: true })));
      } else if (asAgentHubError(error)?.details !== undefined) {
        this.notice(
          s.dim(
            stripControl(safeStringify(asAgentHubError(error)?.details), { keepNewlines: true }),
          ),
        );
      }
    }
  }
}

/** Human lines for the most useful error details (validation issues, paths). */
function describeDetails(details: unknown): string[] {
  if (details === null || typeof details !== 'object') return [];
  const lines: string[] = [];
  const issues = (details as { issues?: unknown }).issues;
  if (Array.isArray(issues)) {
    for (const issue of issues.slice(0, 20)) {
      if (issue === null || typeof issue !== 'object') continue;
      const { level, code, message, path } = issue as Record<string, unknown>;
      const where = typeof path === 'string' && path !== '' ? ` (${clean(path)})` : '';
      lines.push(
        `${clean(level ?? 'error')} ${clean(code ?? '')}: ${clean(message ?? '')}${where}`,
      );
    }
  }
  return lines;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, jsonReplacer, 2) ?? '';
  } catch {
    return String(value);
  }
}
