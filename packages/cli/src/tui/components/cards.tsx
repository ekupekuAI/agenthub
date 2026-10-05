/**
 * Error card, toasts and the plan's blocked card.
 */
import type { EvaluatedFinding, InstallPlan } from '@agenthub/core';
import { Box, Text } from 'ink';
import { asAgentHubError, errorEnvelope } from '../../output';
import { type ToastTone, useTheme } from '../hooks/context';
import { safe } from '../sanitize';
import { DecisionTag, Stamp } from './badges';
import { Panel, T } from './primitives';

const HINTS: Record<string, string> = {
  USAGE: 'Check the command and its argument (/help lists them).',
  NOT_FOUND: 'Check the name with /search, or /list for installed skills.',
  REGISTRY:
    'The registry could not be reached or answered unexpectedly; /registry shows which one is used.',
  POLICY_BLOCKED: 'The policy refuses this package. Nothing was written.',
  APPROVAL_REQUIRED: 'Review the change with /diff, then approve the new capabilities explicitly.',
  DRIFT: 'Installed files differ from the lock; /verify shows which.',
  INTEGRITY: 'The downloaded bytes did not match their digest. Nothing was written.',
  CONFLICT: 'Something else is in the way; the message names it.',
  INCOMPATIBLE: 'A requirement of the skill is not met on this machine.',
  CANCELLED: 'Nothing was changed.',
  IO: 'A file could not be read or written; the message names it.',
  VALIDATION: 'The package or a config file is not valid; the issues are listed above.',
  INTERNAL:
    'Unexpected internal error. Run the same command in the classic CLI with --verbose for a trace.',
};

/** Human lines for validation issues and paths in error details. */
function detailLines(details: unknown): string[] {
  if (details === null || typeof details !== 'object') return [];
  const issues = (details as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 8).flatMap((issue) => {
    if (issue === null || typeof issue !== 'object') return [];
    const { level, code, message, path } = issue as Record<string, unknown>;
    const where = typeof path === 'string' && path !== '' ? ` (${safe(path)})` : '';
    return [`${safe(level ?? 'error')} ${safe(code ?? '')}: ${safe(message ?? '')}${where}`];
  });
}

/** Names the exact problem: what failed, the error code, the engine's message and a next step. */
export function ErrorCard({ what, error }: { what: string; error: unknown }) {
  const theme = useTheme();
  const envelope = errorEnvelope('interactive', error);
  const code = envelope.error.code;
  const lines = detailLines(asAgentHubError(error)?.details);
  return (
    <Panel tone="block" title={what} aside={<T tone="block">{code}</T>} marginTop={1}>
      <Box marginTop={1}>
        <T tone="block" bold>
          {`${theme.glyphs.block} `}
        </T>
        <Box flexShrink={1}>
          <T tone="text">{safe(envelope.error.message)}</T>
        </Box>
      </Box>
      {lines.map((line) => (
        <T key={line} tone="muted">{`  ${line}`}</T>
      ))}
      {HINTS[code] === undefined ? null : (
        <Box marginTop={1}>
          <T tone="subtle">{HINTS[code]}</T>
        </Box>
      )}
    </Panel>
  );
}

export interface ToastItem {
  id: number;
  tone: ToastTone;
  text: string;
}

export function Toasts({ items }: { items: readonly ToastItem[] }) {
  const theme = useTheme();
  if (items.length === 0) return null;
  const g = theme.glyphs;
  const glyph: Record<ToastTone, string> = {
    signal: g.ok,
    info: g.info,
    warn: g.warn,
    block: g.block,
  };
  return (
    <Box flexDirection="column" alignItems="flex-end" paddingX={1}>
      {items.map((item) => (
        <Box
          key={item.id}
          borderStyle={g.border}
          borderColor={theme.palette[item.tone]}
          paddingX={1}
        >
          <T tone={item.tone}>{`${glyph[item.tone]} `}</T>
          <T tone="text" wrap="truncate-end">
            {safe(item.text)}
          </T>
        </Box>
      ))}
    </Box>
  );
}

function where(finding: EvaluatedFinding): string {
  return finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
}

/** One finding: decision, rule, file:line, evidence and whether it was declared. */
export function FindingRow({ finding }: { finding: EvaluatedFinding }) {
  const evidence = finding.evidence === '' ? finding.message : finding.evidence;
  return (
    <Box flexDirection="column">
      <Text>
        <DecisionTag decision={finding.decision} />
        <T tone="text" bold>{` ${safe(finding.ruleId)}`}</T>
        <T tone="info">{`  ${safe(where(finding))}`}</T>
        <T tone="subtle">{finding.declared ? '  declared' : '  undeclared'}</T>
      </Text>
      <Box paddingLeft={8}>
        <T tone="muted" wrap="truncate-end">
          {safe(evidence)}
        </T>
      </Box>
    </Box>
  );
}

/** The red card for a plan that cannot be applied, with the rule and file:line evidence. */
export function BlockedCard({ plan }: { plan: InstallPlan }) {
  const theme = useTheme();
  const blocking = plan.policy.findings.filter((finding) => finding.decision === 'BLOCK');
  return (
    <Panel
      tone="block"
      title="Blocked"
      aside={<Stamp tone="block" glyph={theme.glyphs.block} word="blocked" />}
      marginTop={1}
    >
      {plan.blockers.map((blocker) => (
        <Box key={`${blocker.code}:${blocker.message}`} marginTop={1}>
          <T tone="block">{`${theme.glyphs.block} `}</T>
          <Box flexShrink={1}>
            <Text>
              <T tone="text">{safe(blocker.message)}</T>
              <T tone="subtle">{`  [${blocker.code}]`}</T>
            </Text>
          </Box>
        </Box>
      ))}
      {blocking.length === 0 ? null : (
        <Box flexDirection="column" marginTop={1}>
          {blocking.slice(0, 6).map((finding) => (
            <FindingRow
              key={`${finding.ruleId}:${finding.file}:${finding.line}`}
              finding={finding}
            />
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <T tone="block" bold>
          Nothing was written.
        </T>
        <T tone="muted"> No skill folder or lock entry was changed.</T>
      </Box>
    </Panel>
  );
}
