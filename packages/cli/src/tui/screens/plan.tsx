/**
 * The install plan, shown in the order a person needs it: what, where (and which agents read
 * each folder), safety findings, capabilities, requirements, notes.
 */
import { readersOf } from '@agenthub/adapters';
import type { InstallPlan, InstallResult } from '@agenthub/core';
import { Box, Text } from 'ink';
import { displayPath, formatInstalled, shortDigest } from '../../format';
import { createStyle } from '../../output';
import { AgentChip, AgentIds, outcomeTone, Stamp, VerdictBadge } from '../components/badges';
import { FindingRow } from '../components/cards';
import { Field, Panel, T } from '../components/primitives';
import { useTheme } from '../hooks/context';
import { useReveal } from '../hooks/motion';
import { safe } from '../sanitize';
import { PlanCapabilitiesCard } from './capabilities';

function sourceText(plan: InstallPlan, home: string): string {
  const source = plan.source;
  if (source.kind === 'dir') return `folder ${displayPath(source.path, home)}`;
  if (source.kind === 'file') return `package ${displayPath(source.path, home)}`;
  const range = source.range === undefined ? '' : `@${safe(source.range)}`;
  const registry = source.registry === undefined ? '' : `  from ${safe(source.registry)}`;
  return `registry ${safe(source.name)}${range}${registry}`;
}

const ACTION: Record<string, { mark: string; tone: 'signal' | 'warn' | 'subtle'; word: string }> = {
  create: { mark: '+', tone: 'signal', word: 'create' },
  replace: { mark: '~', tone: 'warn', word: 'replace' },
  unchanged: { mark: '=', tone: 'subtle', word: 'unchanged' },
};

export function PlanView({ plan, home }: { plan: InstallPlan; home: string }) {
  const theme = useTheme();
  const g = theme.glyphs;
  const sections = useReveal(6, { interval: 90, key: plan.id });
  const skill = plan.skill;
  const warnings = plan.issues.filter((issue) => issue.level === 'warning');
  const outcome = plan.policy.outcome;
  // New capabilities that need approval are the decision at hand: show them right after the
  // summary, ahead of targets and findings.
  const capsFirst = plan.capabilities?.approvalRequired === true;
  const capabilities =
    sections >= (capsFirst ? 1 : 4) && plan.capabilities !== undefined ? (
      <PlanCapabilitiesCard
        caps={plan.capabilities}
        name={skill.name}
        version={skill.version}
        {...(plan.previous === undefined ? {} : { previousVersion: plan.previous.version })}
        sameDigest={plan.previous?.digest === skill.digest}
      />
    ) : null;
  return (
    <Box flexDirection="column">
      <Panel
        title={plan.previous === undefined ? 'Install plan' : 'Update plan'}
        aside={<VerdictBadge outcome={outcome} />}
        tone={plan.blockers.length > 0 ? 'block' : undefined}
      >
        <Field name="skill">
          <T tone="text" bold>
            {safe(skill.name)}
          </T>
          <T tone="text">{` ${safe(skill.version)}`}</T>
          <T tone="info">{`  ${shortDigest(skill.digest)}`}</T>
        </Field>
        {plan.previous === undefined ? null : (
          <Field name="replaces">
            <T tone="muted">{safe(plan.previous.version)}</T>
            <T tone="subtle">{`  ${shortDigest(plan.previous.digest)}`}</T>
          </Field>
        )}
        <Field name="source">
          <T tone="muted">{sourceText(plan, home)}</T>
        </Field>
        <Field name="scope">
          <T tone="text">{plan.scope}</T>
          <T tone="muted">{`  ${displayPath(plan.scopeRoot, home)}`}</T>
        </Field>
        {plan.agents.length > 0 ? (
          <Field name="agents">
            {plan.agents.map((agent, index) => (
              <Text key={agent.id}>
                {index === 0 ? '' : ' '}
                <AgentChip id={agent.id} confidence={agent.confidence} />
              </Text>
            ))}
          </Field>
        ) : null}
      </Panel>

      {capsFirst ? capabilities : null}

      {sections >= 2 ? (
        <Panel title="Targets" aside={<T tone="subtle">which agents read each folder</T>}>
          {plan.targets.length === 0 ? (
            <T tone="muted">
              {plan.blockers.length > 0 ? 'none' : 'none — no agent selected (/agents)'}
            </T>
          ) : null}
          {plan.targets.map((target) => {
            const action = ACTION[target.action] ?? {
              mark: '?',
              tone: 'subtle' as const,
              word: target.action,
            };
            const others = readersOf(plan.scope, target.dir).filter(
              (id) => !target.agents.includes(id),
            );
            return (
              <Box key={target.lockPath} flexDirection="column">
                <Text>
                  <T tone={action.tone} bold>{`${action.mark} `}</T>
                  <T tone="text">{safe(target.lockPath)}</T>
                  <T tone="subtle">{`  ${g.arrow}  `}</T>
                  <AgentIds ids={target.agents} />
                  <T tone="subtle">{`  ${action.word}`}</T>
                </Text>
                {others.length > 0 ? (
                  <Box paddingLeft={2}>
                    <T tone="subtle">also read by </T>
                    <AgentIds ids={others} />
                  </Box>
                ) : null}
                {target.unmanaged ? (
                  <Box paddingLeft={2}>
                    <T tone="warn">{`${g.warn} unmanaged folder`}</T>
                  </Box>
                ) : null}
                {target.drift !== undefined && target.drift.length > 0 ? (
                  <Box paddingLeft={2}>
                    <T tone="warn">{`${g.warn} modified: ${target.drift.map(safe).join(', ')}`}</T>
                  </Box>
                ) : null}
              </Box>
            );
          })}
          {plan.duplicates.length > 0 ? (
            <T tone="subtle">{`note: ${plan.duplicates.map(safe).join(', ')} read more than one of these folders and will list the skill twice`}</T>
          ) : null}
        </Panel>
      ) : null}

      {sections >= 3 ? (
        <Panel
          title="Safety"
          tone={outcome === 'block' ? 'block' : outcome === 'confirm' ? 'warn' : undefined}
          aside={
            <Stamp
              tone={outcomeTone(outcome)}
              glyph={outcome === 'allow' ? g.ok : outcome === 'confirm' ? g.warn : g.block}
              word={outcome === 'confirm' ? 'warn' : outcome}
            />
          }
        >
          {plan.policy.findings.length === 0 ? (
            <T tone="muted">
              No findings. The scanner reports what it finds; it does not certify safety.
            </T>
          ) : null}
          {(['BLOCK', 'WARN', 'INFO'] as const).flatMap((decision) =>
            plan.policy.findings
              .filter((finding) => finding.decision === decision)
              .map((finding) => (
                <FindingRow
                  key={`${finding.ruleId}:${finding.file}:${finding.line}:${finding.evidence}`}
                  finding={finding}
                />
              )),
          )}
        </Panel>
      ) : null}

      {!capsFirst ? capabilities : null}

      {sections >= 5 && plan.requirements.length > 0 ? (
        <Panel title="Requirements">
          {plan.requirements.map((req) => {
            const mark = req.ok === true ? g.ok : req.ok === false ? g.block : '?';
            const tone = req.ok === true ? 'signal' : req.ok === false ? 'block' : 'subtle';
            const found =
              req.ok === null
                ? ' (cannot be checked locally)'
                : req.found === undefined
                  ? ''
                  : req.found === null
                    ? ' (not found)'
                    : ` (found ${safe(req.found)})`;
            return (
              <Text key={`${req.kind}:${req.name}`}>
                <T tone={tone}>{`${mark} `}</T>
                <T tone="subtle">{`${req.kind} `}</T>
                <T tone="text">{safe(req.name)}</T>
                <T tone="muted">{`${req.constraint ? ` ${safe(req.constraint)}` : ''}${found}`}</T>
              </Text>
            );
          })}
        </Panel>
      ) : null}

      {sections >= 6 && (warnings.length > 0 || plan.hints.length > 0) ? (
        <Panel title="Notes">
          {warnings.map((issue) => (
            <T key={`${issue.code}:${issue.message}`} tone="warn">
              {`${g.warn} ${safe(issue.code)}: ${safe(issue.message)}${issue.path ? ` (${safe(issue.path)})` : ''}`}
            </T>
          ))}
          {plan.hints.map((hint) => (
            <T key={hint} tone="muted">{`${g.bullet} ${safe(hint)}`}</T>
          ))}
        </Panel>
      ) : null}
    </Box>
  );
}

const plain = createStyle(false);

/** The success card: the classic success lines (same wording), styled. */
export function ResultCard({
  verb,
  result,
  ms,
}: {
  verb: 'Installed' | 'Updated' | 'Rolled back';
  result: InstallResult;
  ms: number;
}) {
  const theme = useTheme();
  const g = theme.glyphs;
  const [first = '', ...rest] = formatInstalled(verb, result, plain);
  return (
    <Panel
      tone="signal"
      title={verb}
      aside={
        <Stamp
          tone="signal"
          glyph={g.ok}
          word={verb === 'Rolled back' ? 'restored' : 'committed'}
        />
      }
      marginTop={1}
    >
      <Box marginTop={1}>
        <T tone="signal">{`${g.ok} `}</T>
        <T tone="text" bold>
          {safe(first.replace(/^✔\s*/, ''))}
        </T>
      </Box>
      {rest.map((line) => {
        const hint = line.trimStart().startsWith('→');
        return (
          <T key={line} tone={hint ? 'info' : 'muted'}>
            {hint ? `${g.arrow} ${safe(line.trimStart().slice(1).trim())}` : safe(line)}
          </T>
        );
      })}
      <Box marginTop={1}>
        <T tone="subtle">{`committed in ${ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`}`}</T>
        {result.snapshot === undefined ? null : (
          <T tone="subtle">{`  ${g.sep}  snapshot kept for rollback`}</T>
        )}
      </Box>
    </Panel>
  );
}
