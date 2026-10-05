/**
 * Verdicts, decisions, agent chips and status words. Each carries a glyph and a word, so the
 * meaning survives without color.
 */
import type {
  AgentEnvironment,
  AgentId,
  Confidence,
  EvaluatedFinding,
  ListedSkill,
} from '@agenthub/core';
import { AGENT_IDS } from '@agenthub/core';
import { Text } from 'ink';
import { useTheme } from '../hooks/context';
import { T, type Tone } from './primitives';

export type Outcome = 'allow' | 'confirm' | 'block';

export function outcomeTone(outcome: Outcome | undefined): Tone {
  if (outcome === 'allow') return 'signal';
  if (outcome === 'confirm') return 'warn';
  if (outcome === 'block') return 'block';
  return 'subtle';
}

/** ✔ allow · ⚠ warn · ✖ block (a scan outcome of "confirm" reads as warn). */
export function VerdictBadge({ outcome }: { outcome: Outcome | undefined }) {
  const theme = useTheme();
  const g = theme.glyphs;
  if (outcome === undefined) return <T tone="subtle">{`${g.pending} unscanned`}</T>;
  const glyph = outcome === 'allow' ? g.ok : outcome === 'confirm' ? g.warn : g.block;
  const word = outcome === 'allow' ? 'allow' : outcome === 'confirm' ? 'warn' : 'block';
  return <T tone={outcomeTone(outcome)}>{`${glyph} ${word}`}</T>;
}

export function decisionTone(decision: EvaluatedFinding['decision']): Tone {
  return decision === 'BLOCK' ? 'block' : decision === 'WARN' ? 'warn' : 'info';
}

/** BLOCK / WARN / INFO tag with its glyph. */
export function DecisionTag({ decision }: { decision: EvaluatedFinding['decision'] }) {
  const theme = useTheme();
  const g = theme.glyphs;
  const glyph = decision === 'BLOCK' ? g.block : decision === 'WARN' ? g.warn : g.info;
  return (
    <T tone={decisionTone(decision)} bold>
      {`${glyph} ${decision.padEnd(5)}`}
    </T>
  );
}

export const MONOGRAM: Record<AgentId, string> = {
  'claude-code': 'CC',
  codex: 'CX',
  cursor: 'CU',
  vscode: 'VS',
};

export const AGENT_NAMES: Record<AgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  vscode: 'VS Code',
};

function confidenceTone(confidence: Confidence | undefined): Tone {
  if (confidence === 'high') return 'signal';
  if (confidence === 'medium') return 'info';
  return 'subtle';
}

/** Monogram chip, e.g. " CC ●" (the dot is the detection confidence). */
export function AgentChip({
  id,
  confidence,
  off,
}: {
  id: AgentId;
  confidence?: Confidence;
  /** Not targeted (shown dim). */
  off?: boolean;
}) {
  const theme = useTheme();
  const monogram = MONOGRAM[id];
  const label = theme.palette.surface === undefined ? `[${monogram}]` : ` ${monogram} `;
  return (
    <Text>
      <T tone={off ? 'subtle' : 'text'} bg={off ? undefined : 'surface'} bold={!off}>
        {label}
      </T>
      {confidence === undefined ? null : (
        <T tone={confidenceTone(confidence)}>{theme.glyphs.dot}</T>
      )}
    </Text>
  );
}

/** Chips for a list of agent ids (registry metadata or targets). */
export function AgentIds({ ids }: { ids: readonly AgentId[] }) {
  const known = AGENT_IDS.filter((id) => ids.includes(id));
  if (known.length === 0) return <T tone="subtle">—</T>;
  return (
    <Text>
      {known.map((id, index) => (
        <Text key={id}>
          {index === 0 ? '' : ' '}
          <AgentChip id={id} />
        </Text>
      ))}
    </Text>
  );
}

/** Detected agents with confidence, dimming the ones not targeted. */
export function DetectedAgents({
  agents,
  selected,
}: {
  agents: readonly AgentEnvironment[];
  selected: readonly AgentId[] | undefined;
}) {
  if (agents.length === 0 && (selected === undefined || selected.length === 0)) {
    return <T tone="subtle">no agents detected</T>;
  }
  const ids = AGENT_IDS.filter(
    (id) => agents.some((agent) => agent.id === id) || selected?.includes(id),
  );
  return (
    <Text>
      {ids.map((id, index) => {
        const env = agents.find((agent) => agent.id === id);
        const targeted =
          selected === undefined
            ? env !== undefined && env.confidence !== 'low'
            : selected.includes(id);
        return (
          <Text key={id}>
            {index === 0 ? '' : ' '}
            <AgentChip id={id} confidence={env?.confidence} off={!targeted} />
          </Text>
        );
      })}
    </Text>
  );
}

export function StatusWord({ status }: { status: ListedSkill['status'] }) {
  const g = useTheme().glyphs;
  if (status === 'ok') return <T tone="signal">{`${g.ok} ok`}</T>;
  if (status === 'drift') return <T tone="warn">{`${g.warn} drift`}</T>;
  return <T tone="block">{`${g.block} missing`}</T>;
}

export function ApprovalWord({ approval }: { approval: ListedSkill['approval'] }) {
  const g = useTheme().glyphs;
  if (approval === 'approved') return <T tone="signal">{`${g.ok} approved`}</T>;
  if (approval === 'recheck') return <T tone="info">{`${g.info} recheck`}</T>;
  return <T tone="warn">{`${g.warn} unapproved`}</T>;
}

/**
 * Inverted stamp, e.g. " ✔ ALLOW " on lime. Inverse keeps the terminal's own background as the
 * text color, so it reads on dark and light terminals alike (and without colors).
 */
export function Stamp({ tone, glyph, word }: { tone: Tone; glyph: string; word: string }) {
  const theme = useTheme();
  return (
    <Text color={theme.palette[tone]} inverse bold>
      {` ${glyph} ${word.toUpperCase()} `}
    </Text>
  );
}
