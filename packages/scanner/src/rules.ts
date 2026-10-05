import type { FindingCategory } from '@agenthub/core';

export interface RuleInfo {
  category: FindingCategory;
  /**
   * Default severity. `code.dynamic` is raised to high per file (see context.ts) and
   * `ext.remote-instructions` lowered to medium when the URL is pinned (see externals.ts).
   */
  severity: 'medium' | 'high';
  /** False when the behavior can never be declared away (design §8.2). */
  declarable: boolean;
  title: string;
}

/** Scanner rules, design §9. */
export const RULES = {
  'exec.shell': {
    category: 'exec',
    severity: 'medium',
    declarable: true,
    title: 'Runs external programs',
  },
  'net.access': {
    category: 'network',
    severity: 'medium',
    declarable: true,
    title: 'Accesses the network',
  },
  'net.download-exec': {
    category: 'download-exec',
    severity: 'high',
    declarable: false,
    title: 'Downloads and runs code',
  },
  'secrets.read': {
    category: 'secrets',
    severity: 'high',
    declarable: true,
    title: 'Reads secrets or credentials',
  },
  'env.read': {
    category: 'env',
    severity: 'medium',
    declarable: true,
    title: 'Reads environment variables',
  },
  'code.dynamic': {
    category: 'dynamic',
    severity: 'medium',
    declarable: true,
    title: 'Evaluates dynamic code',
  },
  'code.obfuscated': {
    category: 'obfuscation',
    severity: 'high',
    declarable: false,
    title: 'Contains an obfuscated payload',
  },
  'fs.persistence': {
    category: 'persistence',
    severity: 'high',
    declarable: false,
    title: 'Installs persistence',
  },
  'deps.remote': {
    category: 'deps',
    severity: 'medium',
    declarable: true,
    title: 'Installs packages at runtime',
  },
  'prompt.injection': {
    category: 'prompt',
    severity: 'medium',
    declarable: true,
    title: 'Suspicious prompt phrase',
  },
  'prompt.hidden': {
    category: 'hidden',
    severity: 'high',
    declarable: false,
    title: 'Hidden instructions',
  },
  'file.binary': {
    category: 'binary',
    severity: 'medium',
    declarable: true,
    title: 'Unexpected binary file',
  },
  /** Prose that tells the agent to fetch and follow remote text; lowered to medium when pinned. */
  'ext.remote-instructions': {
    category: 'remote-instructions',
    severity: 'high',
    declarable: true,
    title: 'Follows instructions fetched from a URL',
  },
} as const satisfies Record<string, RuleInfo>;

export type RuleId = keyof typeof RULES;

export const RULE_IDS = Object.keys(RULES) as RuleId[];
