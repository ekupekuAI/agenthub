import { AgentHubError } from './errors';
import { errorMessage, isPlainObject, parseYamlSafe, stripBom } from './safe-yaml';
import type { SkillFrontmatter, ValidationIssue } from './types';

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_COMPATIBILITY_LENGTH = 500;
export const MAX_BODY_LINES = 500;

/** Frontmatter keys defined by the Agent Skills spec (design §5.1). */
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

export interface ParsedSkillMd {
  /** Parsed frontmatter. Only trustworthy when `issues` contains no errors. */
  frontmatter: SkillFrontmatter;
  /** Everything after the closing `---` line. */
  body: string;
  /** Errors and warnings from {@link validateFrontmatter} plus body checks. */
  issues: ValidationIssue[];
}

/** Length in Unicode code points, matching the spec's "characters". */
function charLength(value: string): number {
  return [...value].length;
}

function error(code: string, message: string, path?: string): ValidationIssue {
  return path === undefined
    ? { level: 'error', code, message }
    : { level: 'error', code, message, path };
}

function warning(code: string, message: string, path?: string): ValidationIssue {
  return path === undefined
    ? { level: 'warning', code, message }
    : { level: 'warning', code, message, path };
}

function structuralError(code: string, message: string): never {
  throw new AgentHubError('VALIDATION', message, {
    issues: [error(code, message, 'SKILL.md')],
  });
}

/**
 * Validate SKILL.md frontmatter against design §5.1. `path` on each issue is the frontmatter
 * field (e.g. 'name', 'metadata.author'). When `folderName` is given, `name` must equal it.
 */
export function validateFrontmatter(
  fm: Record<string, unknown>,
  folderName?: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const name = fm.name;
  if (name === undefined || name === null) {
    issues.push(error('name.missing', 'name is required', 'name'));
  } else if (typeof name !== 'string') {
    issues.push(error('name.type', 'name must be a string', 'name'));
  } else {
    if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
      issues.push(
        error(
          'name.length',
          `name must be 1-${MAX_NAME_LENGTH} characters (got ${name.length})`,
          'name',
        ),
      );
    }
    if (name.length > 0 && !SKILL_NAME_PATTERN.test(name)) {
      issues.push(
        error(
          'name.format',
          `name "${name}" may only contain a-z, 0-9 and single hyphens, and cannot start or end with a hyphen`,
          'name',
        ),
      );
    }
    if (folderName !== undefined && name !== folderName) {
      issues.push(
        error(
          'name.folder-mismatch',
          `name "${name}" must equal the skill folder name "${folderName}"`,
          'name',
        ),
      );
    }
  }

  const description = fm.description;
  if (description === undefined || description === null) {
    issues.push(error('description.missing', 'description is required', 'description'));
  } else if (typeof description !== 'string') {
    issues.push(error('description.type', 'description must be a string', 'description'));
  } else {
    const length = charLength(description);
    if (description.trim().length === 0 || length > MAX_DESCRIPTION_LENGTH) {
      issues.push(
        error(
          'description.length',
          `description must be 1-${MAX_DESCRIPTION_LENGTH} characters (got ${length})`,
          'description',
        ),
      );
    }
  }

  if (Object.hasOwn(fm, 'license') && typeof fm.license !== 'string') {
    issues.push(error('license.type', 'license must be a string', 'license'));
  }

  if (Object.hasOwn(fm, 'compatibility')) {
    const compatibility = fm.compatibility;
    if (typeof compatibility !== 'string') {
      issues.push(error('compatibility.type', 'compatibility must be a string', 'compatibility'));
    } else {
      const length = charLength(compatibility);
      if (length < 1 || length > MAX_COMPATIBILITY_LENGTH) {
        issues.push(
          error(
            'compatibility.length',
            `compatibility must be 1-${MAX_COMPATIBILITY_LENGTH} characters (got ${length})`,
            'compatibility',
          ),
        );
      }
    }
  }

  if (Object.hasOwn(fm, 'metadata')) {
    const metadata = fm.metadata;
    if (!isPlainObject(metadata)) {
      issues.push(error('metadata.type', 'metadata must be a map of string to string', 'metadata'));
    } else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== 'string') {
          issues.push(
            warning(
              'metadata.value-type',
              `metadata.${key} should be a string (got ${Array.isArray(value) ? 'array' : typeof value})`,
              `metadata.${key}`,
            ),
          );
        }
      }
    }
  }

  if (Object.hasOwn(fm, 'allowed-tools')) {
    const tools = fm['allowed-tools'];
    if (Array.isArray(tools)) {
      issues.push(
        warning(
          'allowed-tools.list',
          'allowed-tools should be a space-separated string; a list is accepted by some agents only',
          'allowed-tools',
        ),
      );
    } else if (typeof tools !== 'string') {
      issues.push(
        error(
          'allowed-tools.type',
          'allowed-tools must be a space-separated string',
          'allowed-tools',
        ),
      );
    }
  }

  for (const key of Object.keys(fm)) {
    if (!KNOWN_KEYS.has(key)) {
      issues.push(
        warning(
          'frontmatter.unknown-key',
          `unknown frontmatter key "${key}" (kept as a vendor extension)`,
          key,
        ),
      );
    }
  }

  return issues;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * Split SKILL.md into frontmatter and body, parse the frontmatter safely and validate it.
 * Throws AgentHubError('VALIDATION') when the frontmatter block is missing, unterminated, not
 * valid YAML, or not a mapping. Rule violations are returned in `issues`, not thrown.
 */
export function parseSkillMd(text: string, opts: { folderName?: string } = {}): ParsedSkillMd {
  const source = stripBom(text).replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  if (lines[0] !== '---') {
    structuralError('frontmatter.missing', 'SKILL.md must start with a "---" frontmatter block');
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) {
    structuralError(
      'frontmatter.unterminated',
      'SKILL.md frontmatter is not closed by a "---" line',
    );
  }

  let data: unknown;
  try {
    data = parseYamlSafe(lines.slice(1, end).join('\n'));
  } catch (cause) {
    structuralError(
      'frontmatter.yaml',
      `SKILL.md frontmatter is not valid YAML: ${errorMessage(cause)}`,
    );
  }
  if (!isPlainObject(data)) {
    structuralError('frontmatter.type', 'SKILL.md frontmatter must be a YAML mapping');
  }

  const body = lines.slice(end + 1).join('\n');
  const issues = validateFrontmatter(data, opts.folderName);
  const bodyLines = countLines(body);
  if (bodyLines > MAX_BODY_LINES) {
    issues.push(
      warning(
        'body.too-long',
        `SKILL.md body has ${bodyLines} lines; keep it under ${MAX_BODY_LINES} and move detail into reference files`,
      ),
    );
  }
  return { frontmatter: data as SkillFrontmatter, body, issues };
}
