/**
 * Installed skills (/list) and verification (/verify): approval state, status, agents, and
 * per-file drift.
 */
import type { ListedSkill, VerifyReport } from '@agenthub/core';
import { Box, Text } from 'ink';
import { approvalStateText } from '../../capability-format';
import { AgentIds, ApprovalWord, StatusWord } from '../components/badges';
import { Panel, T } from '../components/primitives';
import { useApp, useKeys, useTheme } from '../hooks/context';
import { moveSelection, useSelection } from '../hooks/list';
import { formatMs, useReveal } from '../hooks/motion';
import { useTask } from '../hooks/task';
import { fit, safe } from '../sanitize';
import { Footer, ScreenTitle, Scroll, TaskView } from './common';

export function ListScreen() {
  const app = useApp();
  const [state] = useTask(() => app.session.list(), []);
  return (
    <Box flexDirection="column" paddingX={1}>
      <TaskView state={state} loading="Reading the lock" what="Could not list installed skills">
        {(skills) => <Installed skills={skills} />}
      </TaskView>
    </Box>
  );
}

const COLUMNS = [
  ['SKILL', 22],
  ['VERSION', 10],
  ['SCOPE', 9],
  ['AGENTS', 20],
  ['STATUS', 11],
  ['APPROVAL', 14],
] as const;

function Installed({ skills }: { skills: ListedSkill[] }) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const [selected, setSelected] = useSelection(skills.length);
  const shown = useReveal(skills.length, { interval: 60, step: 2 });
  const current = skills[selected];
  const capacity = Math.max(3, app.rows - 9);
  const start = Math.min(
    Math.max(0, selected - Math.floor(capacity / 2)),
    Math.max(0, skills.length - capacity),
  );

  useKeys((input, key) => {
    const next = moveSelection(selected, skills.length, input, key);
    if (next !== null) {
      setSelected(next);
      return true;
    }
    if (current === undefined) return false;
    const name = current.name;
    const actions: Record<string, () => void> = {
      v: () => app.navigate({ kind: 'verify', name }),
      a: () => app.navigate({ kind: 'approve', name }),
      d: () => app.navigate({ kind: 'diff', name }),
      u: () => app.navigate({ kind: 'update-flow', name }),
      b: () => app.navigate({ kind: 'rollback', name }),
      x: () => app.navigate({ kind: 'remove', name }),
    };
    const action = actions[input];
    if (action !== undefined) {
      action();
      return true;
    }
    if (key.return) {
      app.navigate({ kind: 'detail', name });
      return true;
    }
    return false;
  });

  const approved = skills.filter((s) => s.approval === 'approved').length;
  const drift = skills.filter((s) => s.status !== 'ok').length;
  return (
    <Box flexDirection="column">
      <ScreenTitle
        title={
          <Text>
            <T tone="text" bold>
              Installed
            </T>
            <T tone="muted">{`  ${skills.length} skill${skills.length === 1 ? '' : 's'}`}</T>
          </Text>
        }
        meta={
          <Text>
            <T tone="signal">{`${g.ok} ${approved} approved`}</T>
            <T tone="subtle">{`  ${g.sep}  `}</T>
            <T tone={drift > 0 ? 'warn' : 'subtle'}>{`${drift} need attention`}</T>
          </Text>
        }
      />
      {skills.length === 0 ? (
        <Box flexDirection="column">
          <T tone="text">No skills installed.</T>
          <T tone="muted">Find one with /search, or install a folder with /install ./my-skill.</T>
        </Box>
      ) : (
        <Box>
          <Box width={2} />
          {COLUMNS.map(([label, width]) => (
            <Box key={label} width={width}>
              <T tone="subtle" bold>
                {label}
              </T>
            </Box>
          ))}
          <T tone="subtle" bold>
            SOURCE
          </T>
        </Box>
      )}
      {skills
        .slice(start, start + capacity)
        .slice(0, Math.max(0, shown - start))
        .map((skill, offset) => {
          const index = start + offset;
          const active = index === selected;
          return (
            <Box
              key={`${skill.scope}:${skill.name}`}
              backgroundColor={active ? theme.palette.surface : undefined}
            >
              <Box width={2}>
                <T tone="signal">{active ? g.pointer : ' '}</T>
              </Box>
              <Box width={22}>
                <T tone={active ? 'signal' : 'text'} bold>
                  {fit(safe(skill.name), 21)}
                </T>
              </Box>
              <Box width={10}>
                <T tone="muted">{fit(safe(skill.version), 9)}</T>
              </Box>
              <Box width={9}>
                <T tone="muted">{skill.scope}</T>
              </Box>
              <Box width={20}>
                <AgentIds ids={skill.agents} />
              </Box>
              <Box width={11}>
                <StatusWord status={skill.status} />
              </Box>
              <Box width={14}>
                <ApprovalWord approval={skill.approval} />
              </Box>
              <T tone="subtle">
                {fit(safe(skill.registry ?? skill.source), Math.max(8, app.columns - 96))}
              </T>
            </Box>
          );
        })}
      {skills.some((skill) => skill.approval !== 'approved') ? (
        <Box marginTop={1}>
          <T tone="subtle">
            recheck = approved under other scanner rules (verify rescans); unapproved = review with
            a
          </T>
        </Box>
      ) : null}
      {skills.length > 0 ? (
        <Footer
          hints={[
            ['enter', 'details'],
            ['v', 'verify'],
            ['a', 'approve'],
            ['d', 'diff'],
            ['u', 'update'],
            ['b', 'roll back'],
            ['x', 'remove'],
            ['esc', 'back'],
          ]}
        />
      ) : null}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

export function VerifyScreen({ name }: { name?: string }) {
  const app = useApp();
  const [state] = useTask(() => app.session.verify(name), [name]);
  return (
    <Box flexDirection="column" paddingX={1}>
      <TaskView
        state={state}
        loading="Re-hashing installed files against the lock"
        what="Verify failed"
      >
        {(found) => <Reports reports={found.value} ms={found.ms} />}
      </TaskView>
    </Box>
  );
}

function ApprovalLine({ report }: { report: VerifyReport }) {
  const caps = report.capabilities;
  if (caps === undefined) return null;
  if (caps.lockMatches === false) {
    return <T tone="block">capabilities: the lock record does not match the installed files</T>;
  }
  if (caps.missingBlock)
    return <T tone="warn">approval: no capability record yet — review with /approve</T>;
  if (!caps.checked) return <T tone="subtle">approval: cannot recheck (no intact copy or cache)</T>;
  const ok = caps.state === 'approved' || caps.state === 'approved-carried';
  return (
    <Box flexDirection="column">
      <T tone={ok ? 'signal' : 'warn'}>{`approval: ${approvalStateText(caps.state)}`}</T>
      {caps.stale.length > 0 ? (
        <T tone="warn">{`new under the current scanner rules: ${caps.stale.map(safe).join(', ')} — /approve ${safe(report.name)}`}</T>
      ) : null}
    </Box>
  );
}

function Reports({ reports, ms }: { reports: VerifyReport[]; ms: number }) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const shown = useReveal(reports.length, { interval: 90 });
  const drifted = reports.filter((r) => !r.ok).length;
  const forged = reports.filter((r) => r.capabilities?.lockMatches === false).length;
  const mark: Record<string, { glyph: string; tone: 'warn' | 'block' | 'info' }> = {
    modified: { glyph: g.tilde, tone: 'warn' },
    missing: { glyph: g.minus, tone: 'block' },
    extra: { glyph: g.plus, tone: 'info' },
  };
  return (
    <Box flexDirection="column">
      <ScreenTitle
        title={
          <Text>
            <T tone="text" bold>
              Verify
            </T>
            <T tone="muted">{`  ${reports.length} skill${reports.length === 1 ? '' : 's'}`}</T>
          </Text>
        }
        meta={
          <Text>
            {drifted + forged === 0 ? (
              <T tone="signal">{`${g.ok} everything matches the lock`}</T>
            ) : (
              <T tone="block">{`${g.block} ${drifted + forged} differ from the lock`}</T>
            )}
            <T tone="subtle">{`  ${g.sep}  ${formatMs(ms)}`}</T>
          </Text>
        }
      />
      {reports.length === 0 ? <T tone="muted">No skills to verify in this scope.</T> : null}
      <Scroll height={Math.max(5, app.rows - 7)}>
        {reports.slice(0, shown).map((report) => (
          <Panel
            key={`${report.scope}:${report.name}`}
            tone={report.ok ? undefined : 'block'}
            heading={`${safe(report.name)} ${safe(report.version)}`}
            aside={
              report.ok ? (
                <T tone="signal">{`${g.ok} ok`}</T>
              ) : (
                <T tone="block">{`${g.block} drift`}</T>
              )
            }
          >
            {report.targets.map((target) => {
              const bad = target.files.filter((file) => file.status !== 'ok');
              return (
                <Box key={target.lockPath} flexDirection="column">
                  <Text>
                    <T tone={target.ok && bad.length === 0 ? 'signal' : 'block'}>
                      {target.ok && bad.length === 0 ? `${g.ok} ` : `${g.block} `}
                    </T>
                    <T tone="text">{safe(target.lockPath)}</T>
                    <T tone="subtle">{`  ${target.files.length} file${target.files.length === 1 ? '' : 's'}`}</T>
                  </Text>
                  {bad.map((file) => {
                    const m = mark[file.status] ?? { glyph: '?', tone: 'warn' as const };
                    return (
                      <Box key={file.path} paddingLeft={2}>
                        <T tone={m.tone} bold>{`${m.glyph} ${file.status.padEnd(9)}`}</T>
                        <T tone="text">{safe(file.path)}</T>
                      </Box>
                    );
                  })}
                </Box>
              );
            })}
            <ApprovalLine report={report} />
          </Panel>
        ))}
      </Scroll>
      <Footer
        hints={[
          [`${g.up}${g.down}`, 'scroll'],
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}
