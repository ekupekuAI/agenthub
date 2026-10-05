import { Buffer } from 'node:buffer';
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Node,
  parseDocument,
  Scalar,
  type YAMLError,
} from 'yaml';
import { YAML_LIMITS } from './limits';
import { escapeForDisplay } from './paths';

/** The only tags a document may use explicitly: the YAML 1.2 core schema. */
const CORE_TAGS: ReadonlySet<string> = new Set(
  ['str', 'int', 'float', 'bool', 'null', 'map', 'seq'].map((name) => `tag:yaml.org,2002:${name}`),
);

/** The %TAG handles every document has implicitly. */
const DEFAULT_TAG_HANDLES: Readonly<Record<string, string>> = {
  '!': '!',
  '!!': 'tag:yaml.org,2002:',
};

function fail(message: string): never {
  throw new Error(message);
}

function describeError(error: YAMLError, lines: LineCounter): string {
  const at = lines.linePos(error.pos[0]);
  return `${escapeForDisplay(error.message)} at line ${at.line}, column ${at.col}`;
}

/**
 * Reject `\x..`, `\u....` and `\U........` escapes (and `\ `, `\/`) in a double-quoted scalar
 * that stand for a plain printable ASCII character: there is no reason to write `\x6F` for
 * "o" except to hide words such as "ignore previous instructions" from a text scanner.
 */
function checkDoubleQuotedEscapes(source: string): void {
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '\\') continue;
    const kind = source[i + 1];
    const width = kind === 'x' ? 2 : kind === 'u' ? 4 : kind === 'U' ? 8 : 0;
    let decoded: number | null = null;
    let text = `\\${kind ?? ''}`;
    if (width > 0) {
      const hex = source.slice(i + 2, i + 2 + width);
      if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === width) {
        decoded = Number.parseInt(hex, 16);
        text += hex;
      }
    } else if (kind === ' ' || kind === '/') {
      decoded = kind.charCodeAt(0);
    }
    if (decoded !== null && decoded >= 0x20 && decoded <= 0x7e) {
      fail(
        `a double-quoted string uses the escape sequence "${escapeForDisplay(text)}" for the plain character "${String.fromCharCode(decoded)}"; write the character itself`,
      );
    }
    i++; // skip the escaped character, so "\\x41" is an escaped backslash followed by "x41"
  }
}

function keyText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Walk the document tree without recursion: no aliases, only core-schema tags, scalar keys
 * that stay unique once converted to object keys, finite numbers, and bounded depth and size.
 */
function checkTree(root: Node | null): void {
  if (root === null) return;
  const stack: { node: Node; depth: number }[] = [{ node: root, depth: 1 }];
  let count = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: Node; depth: number };
    count++;
    if (count > YAML_LIMITS.maxNodes) fail(`YAML has more than ${YAML_LIMITS.maxNodes} nodes`);
    if (depth > YAML_LIMITS.maxDepth) {
      fail(`YAML is nested deeper than ${YAML_LIMITS.maxDepth} levels`);
    }
    if (isAlias(node)) fail('YAML aliases (*name) are not allowed');
    if (node.tag !== undefined && !CORE_TAGS.has(node.tag)) {
      fail(`YAML tag "${escapeForDisplay(node.tag)}" is not allowed (core schema only)`);
    }
    if (isScalar(node)) {
      if (node.type === Scalar.QUOTE_DOUBLE) {
        const source = (node.srcToken as { source?: unknown } | undefined)?.source;
        if (typeof source === 'string') checkDoubleQuotedEscapes(source);
      }
      if (typeof node.value === 'number' && !Number.isFinite(node.value)) {
        fail('YAML numbers must be finite (.inf and .nan are not allowed)');
      }
    } else if (isMap(node)) {
      const keys = new Set<string>();
      for (const pair of node.items) {
        const key = pair.key as Node | null;
        if (key !== null && !isScalar(key)) {
          if (isAlias(key)) fail('YAML aliases (*name) are not allowed');
          fail('YAML mapping keys must be plain scalars');
        }
        const text = keyText(key?.value);
        if (keys.has(text)) fail(`duplicate YAML key "${escapeForDisplay(text)}"`);
        keys.add(text);
        if (key !== null) stack.push({ node: key, depth: depth + 1 });
        const value = pair.value as Node | null;
        if (value !== null) stack.push({ node: value, depth: depth + 1 });
      }
    } else if (isSeq(node)) {
      for (const item of node.items) {
        if (item !== null) stack.push({ node: item as Node, depth: depth + 1 });
      }
    }
  }
}

/**
 * Parse untrusted YAML into plain JSON-like data (design §5.1, §5.2). Hardened against hostile
 * input: the source is capped at {@link YAML_LIMITS} `maxBytes` before parsing; `%YAML`/`%TAG`
 * directives, aliases, merge keys and non-core tags are refused; keys must be unique scalars;
 * depth and node count are bounded; escapes that spell plain ASCII are refused. The result
 * only contains strings, finite numbers, booleans, null, arrays and plain objects, and is never
 * cyclic or shared. Warnings are not printed. Throws an Error whose message is safe to print.
 */
export function parseYamlSafe(src: string): unknown {
  const bytes = Buffer.byteLength(src, 'utf8');
  if (bytes > YAML_LIMITS.maxBytes) {
    fail(`YAML document is larger than ${YAML_LIMITS.maxBytes} bytes (${bytes} bytes)`);
  }
  const lines = new LineCounter();
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(src, {
      version: '1.2',
      schema: 'core',
      merge: false,
      resolveKnownTags: false,
      customTags: [],
      uniqueKeys: false, // checked in linear time by checkTree
      intAsBigInt: false,
      strict: true,
      prettyErrors: false,
      keepSourceTokens: true,
      logLevel: 'silent',
      lineCounter: lines,
    });
  } catch (cause) {
    if (cause instanceof RangeError) fail('YAML is nested too deeply');
    throw cause;
  }
  const first = doc.errors[0];
  if (first !== undefined) fail(describeError(first, lines));
  if (doc.directives?.yaml.explicit === true) fail('YAML %YAML directives are not allowed');
  const handles = Object.entries(doc.directives?.tags ?? {});
  if (handles.some(([handle, prefix]) => DEFAULT_TAG_HANDLES[handle] !== prefix)) {
    fail('YAML %TAG directives are not allowed');
  }
  checkTree(doc.contents as Node | null);
  return doc.toJS({ maxAliasCount: 0 });
}

/** True for a character that is invisible, a control character or an unpaired surrogate. */
function isHiddenChar(ch: string): boolean {
  const cp = ch.codePointAt(0) as number;
  // Tab and newline are ordinary text; VS15/VS16 select text or emoji style (e.g. ⚠️).
  if (cp === 0x09 || cp === 0x0a || cp === 0xfe0e || cp === 0xfe0f) return false;
  return /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(ch);
}

/**
 * The first control, invisible (zero-width, bidi, tag, variation selector, filler) or
 * unpaired-surrogate character in `value`, as `U+XXXX`, or null. Tab, newline and the emoji
 * presentation selectors U+FE0E/U+FE0F are allowed.
 */
export function findHiddenChar(value: string): string | null {
  for (const ch of value) {
    if (isHiddenChar(ch)) {
      return `U+${(ch.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }
  return null;
}

/**
 * Every key and string value in parsed YAML data that holds a hidden character, as
 * `{ path, char }` (path like `metadata.author` or `items[2]`; keys are escaped for display).
 */
export function findHiddenChars(data: unknown): { path: string; char: string }[] {
  const found: { path: string; char: string }[] = [];
  const stack: { value: unknown; path: string }[] = [{ value: data, path: '' }];
  while (stack.length > 0) {
    const { value, path } = stack.pop() as { value: unknown; path: string };
    if (typeof value === 'string') {
      const char = findHiddenChar(value);
      if (char !== null) found.push({ path, char });
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        stack.push({ value: item, path: `${path}[${i}]` });
      });
    } else if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        const child = path === '' ? escapeForDisplay(key) : `${path}.${escapeForDisplay(key)}`;
        const char = findHiddenChar(key);
        if (char !== null) found.push({ path: child, char });
        stack.push({ value: item, path: child });
      }
    }
  }
  return found.reverse();
}

/** True for `{}`-style objects (not arrays, null, Maps, Buffers or class instances). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Remove a leading UTF-8 byte order mark. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
