import type { RawFile, ValidationIssue } from '../src/index';
import { AgentHubError } from '../src/index';

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
export const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export function skillMd(frontmatter: string, body = '# Usage\n\nRun the script.\n'): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

export const VALID_SKILL_MD = skillMd(
  'name: web-testing\ndescription: Test web apps with a headless browser.\nlicense: MIT',
);

export const VALID_MANIFEST = [
  'schema: 1',
  'version: 1.3.0',
  'targets:',
  '  - claude-code',
  '  - cursor',
  'requires:',
  '  runtimes: { node: ">=22", python: ">=3.10" }',
  '  commands: [git, npx]',
  '  mcp: [playwright]',
  'permissions:',
  '  network: true',
  '  exec: [npx, node]',
  '  env: [PLAYWRIGHT_BROWSERS_PATH]',
  '  secrets: []',
  '  fs: { write: [project, temp] }',
  'channel: stable',
  '',
].join('\n');

export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0xff, 0xfe, 0x0d, 0x0a,
]);

/** A small, valid skill with text, script, nested reference and binary files. */
export function sampleFiles(overrides: Record<string, string | Uint8Array> = {}): RawFile[] {
  const files: Record<string, string | Uint8Array> = {
    'SKILL.md': VALID_SKILL_MD,
    'agenthub.yaml': VALID_MANIFEST,
    'scripts/run.sh': '#!/bin/sh\necho "running"\n',
    'references/a/b.md': '# Reference\n\nDetails.\n',
    'assets/logo.png': PNG_BYTES,
    ...overrides,
  };
  return Object.entries(files).map(([path, content]) => ({
    path,
    content: typeof content === 'string' ? encode(content) : content,
  }));
}

export function toCrlf(text: string): string {
  return text.replace(/\n/g, '\r\n');
}

/** Run `fn` and return the AgentHubError it throws; fails the test otherwise. */
export function catchError(fn: () => unknown): AgentHubError {
  try {
    fn();
  } catch (error) {
    if (error instanceof AgentHubError) return error;
    throw error;
  }
  throw new Error('expected an AgentHubError to be thrown');
}

export async function catchErrorAsync(fn: () => Promise<unknown>): Promise<AgentHubError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof AgentHubError) return error;
    throw error;
  }
  throw new Error('expected an AgentHubError to be thrown');
}

export function issuesOf(error: AgentHubError): ValidationIssue[] {
  const details = error.details as { issues?: ValidationIssue[] } | undefined;
  return details?.issues ?? [];
}

export function issueCodes(error: AgentHubError): string[] {
  return issuesOf(error).map((issue) => issue.code);
}

/** True when the text holds a C0 or C1 control character (or DEL). */
export function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
