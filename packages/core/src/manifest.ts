import { Buffer } from 'node:buffer';
import semver from 'semver';
import { z } from 'zod';
import { AgentHubError } from './errors';
import { YAML_LIMITS } from './limits';
import { escapeUnsafeChars } from './paths';
import { errorMessage, findHiddenChars, isPlainObject, parseYamlSafe, stripBom } from './safe-yaml';
import type { SkillManifest, ValidationIssue } from './types';
import { AGENT_IDS } from './types';

export const MANIFEST_FILE = 'agenthub.yaml';

const COMMAND_NAME = /^[A-Za-z0-9._-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RUNTIME_NAME = /^[A-Za-z0-9._-]+$/;
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOSTNAME = new RegExp(`^(?:\\*\\.)?${LABEL}(?:\\.${LABEL})*$`);

const commandName = z
  .string()
  .regex(COMMAND_NAME, 'must be a command name (letters, digits, ".", "_", "-")');

const hostname = z
  .string()
  .max(253)
  .regex(HOSTNAME, 'must be a hostname such as "api.example.com" or "*.example.com"');

const strictVersion = z
  .string()
  .refine((value) => semver.valid(value) === value, 'must be a semver version such as "1.2.3"');

const versionRange = z
  .string()
  .min(1)
  .refine((value) => semver.validRange(value) !== null, 'must be a semver range such as ">=22"');

/** Strict zod schema for agenthub.yaml, schema 1 (design §5.2). Unknown keys are errors. */
export const manifestSchema = z.strictObject({
  schema: z.literal(1),
  version: strictVersion,
  targets: z.array(z.enum(AGENT_IDS)).optional(),
  requires: z
    .strictObject({
      runtimes: z
        .record(
          z.string().regex(RUNTIME_NAME, 'must be a runtime name such as "node"'),
          versionRange,
        )
        .optional(),
      commands: z.array(commandName).optional(),
      mcp: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  permissions: z
    .strictObject({
      network: z.union([z.boolean(), z.array(hostname)]).optional(),
      exec: z.array(commandName).optional(),
      env: z.array(z.string().regex(ENV_NAME, 'must be an environment variable name')).optional(),
      secrets: z.array(z.string().min(1)).optional(),
      fs: z
        .strictObject({
          write: z.array(z.enum(['project', 'home', 'temp'])).optional(),
        })
        .optional(),
    })
    .optional(),
  channel: z.enum(['stable', 'beta']).optional(),
});

function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) {
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? String(key) : `.${String(key)}`;
  }
  return out;
}

function invalid(issues: ValidationIssue[]): never {
  const first = issues[0];
  const summary = first === undefined ? 'invalid' : first.message;
  const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : '';
  throw new AgentHubError('VALIDATION', `${MANIFEST_FILE} is invalid: ${summary}${more}`, {
    issues,
  });
}

/** Validate already-parsed manifest data. Returns the manifest or the list of issues. */
export function validateManifest(
  data: unknown,
): { ok: true; manifest: SkillManifest } | { ok: false; issues: ValidationIssue[] } {
  const result = manifestSchema.safeParse(data);
  if (result.success) {
    const manifest: SkillManifest = result.data;
    return { ok: true, manifest };
  }
  const issues = result.error.issues.map((issue): ValidationIssue => {
    // Keys and messages can echo untrusted input (e.g. an unrecognized key): escape them.
    const path = escapeUnsafeChars(formatPath(issue.path));
    const text = escapeUnsafeChars(issue.message);
    return {
      level: 'error',
      code: `manifest.${issue.code}`,
      message: path === '' ? text : `${path}: ${text}`,
      path: path === '' ? MANIFEST_FILE : path,
    };
  });
  return { ok: false, issues };
}

/**
 * Parse and strictly validate agenthub.yaml text. Throws AgentHubError('VALIDATION') with
 * `details.issues` listing every problem (path such as `requires.runtimes.node`).
 */
export function parseManifest(text: string): SkillManifest {
  const source = stripBom(text);
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > YAML_LIMITS.maxBytes) {
    invalid([
      {
        level: 'error',
        code: 'manifest.too-large',
        message: `is ${bytes} bytes; the limit is ${YAML_LIMITS.maxBytes}`,
        path: MANIFEST_FILE,
      },
    ]);
  }
  let data: unknown;
  try {
    data = parseYamlSafe(source);
  } catch (cause) {
    const message = `not valid YAML: ${errorMessage(cause)}`;
    invalid([{ level: 'error', code: 'manifest.yaml', message, path: MANIFEST_FILE }]);
  }
  if (!isPlainObject(data)) {
    invalid([
      {
        level: 'error',
        code: 'manifest.type',
        message: 'must be a YAML mapping',
        path: MANIFEST_FILE,
      },
    ]);
  }
  const hidden = findHiddenChars(data).map(
    ({ path, char }): ValidationIssue => ({
      level: 'error',
      code: 'manifest.hidden-char',
      message: `${path}: contains the control or invisible character ${char}`,
      path,
    }),
  );
  const result = validateManifest(data);
  if (!result.ok) invalid([...hidden, ...result.issues]);
  if (hidden.length > 0) invalid(hidden);
  return result.manifest;
}
