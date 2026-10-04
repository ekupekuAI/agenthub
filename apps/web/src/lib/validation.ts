import semver from 'semver';
import { z } from 'zod';

export const AGENTS = ['claude-code', 'codex', 'cursor', 'vscode'] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_LABELS: Record<Agent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code / Copilot',
};

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(SLUG_RE, 'Slug must be lowercase letters, digits and single hyphens');

/** An exact semver version without build metadata. */
export const versionSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => semver.valid(v) === v && !v.includes('+'), 'Not a valid semver version');

export const agentSchema = z.enum(AGENTS);
export const channelSchema = z.enum(['stable', 'beta']);

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .optional()
    .transform((s) => (s ? s : undefined));

export const searchQuerySchema = z.object({
  q: optionalText(200),
  agent: agentSchema.optional(),
  category: z
    .string()
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'Invalid category')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const resolveQuerySchema = z.object({
  agent: agentSchema.optional(),
  version: z
    .string()
    .max(128)
    .optional()
    .refine(
      (r) => r === undefined || r === 'latest' || semver.validRange(r) !== null,
      'Not a valid semver range',
    ),
  channel: channelSchema.optional(),
});

export const slugParamsSchema = z.object({ slug: slugSchema });
export const downloadParamsSchema = z.object({ slug: slugSchema, version: versionSchema });

export const reasonSchema = z.string().trim().min(3, 'A reason is required').max(500);

export const revokeBodySchema = z.object({ version: versionSchema, reason: reasonSchema });
export const statusBodySchema = z.object({
  version: versionSchema,
  status: z.enum(['active', 'quarantined', 'revoked']),
  reason: reasonSchema,
});
export const scanBodySchema = z.object({ version: versionSchema });
export const createPublisherSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, 'Use letters, digits, spaces, dots, dashes'),
  verified: z.boolean().default(false),
});
export const releaseNotesSchema = z.string().max(5000).optional();

/** Turn URLSearchParams into a plain object (first value wins; empty values dropped). */
export function paramsToObject(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!(key in out) && value !== '') out[key] = value;
  }
  return out;
}
