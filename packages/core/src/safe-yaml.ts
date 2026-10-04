import { parse } from 'yaml';

/**
 * Parse untrusted YAML: duplicate keys are errors, alias expansion is capped (billion-laughs
 * guard), YAML 1.2 core schema only. Warnings (such as unknown tags) are not printed.
 * Throws the parser's error on invalid input.
 */
export function parseYamlSafe(src: string): unknown {
  return parse(src, { uniqueKeys: true, maxAliasCount: 50, prettyErrors: true, logLevel: 'error' });
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
