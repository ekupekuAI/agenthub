/**
 * Doctor: the machine checked one area at a time — agents, skill folders, locks, approvals,
 * transactions and the rest — each check resolving from a spinner to its verdict.
 */
import type { DoctorProblem } from '@agenthub/core';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { displayPath, formatBytes } from '../../format';
import { AgentChip } from '../components/badges';
import { Spinner, T } from '../components/primitives';
import { useApp, useTheme } from '../hooks/context';
import { useReveal } from '../hooks/motion';
import { useTask } from '../hooks/task';
import { safe } from '../sanitize';
import type { DoctorView } from '../session';
import { Footer, Scroll, TaskView } from './common';

interface Check {
  title: string;
  summary: string;
  level: 'ok' | 'warning' | 'error' | 'info';
  details: ReactNode[];
}

function problemsWhere(
  problems: DoctorProblem[],
  test: (code: string) => boolean,
): DoctorProblem[] {
  return problems.filter((problem) => test(problem.code));
}

function levelOf(problems: DoctorProblem[]): Check['level'] {
  if (problems.some((p) => p.level === 'error')) return 'error';
  return problems.length > 0 ? 'warning' : 'ok';
}

function ProblemRow({ problem }: { problem: DoctorProblem }) {
  const g = useTheme().glyphs;
  return (
    <Text>
      <T
        tone={problem.level === 'error' ? 'block' : 'warn'}
      >{`${problem.level === 'error' ? g.block : g.warn} `}</T>
      <T tone="subtle">{`${safe(problem.code)}  `}</T>
      <T tone="text">{safe(problem.message)}</T>
    </Text>
  );
}

export function buildChecks(view: DoctorView): Check[] {
  const { report, problems, home } = view;
  const rows = (list: DoctorProblem[]): ReactNode[] =>
    list.map((problem) => (
      <ProblemRow key={`${problem.code}:${problem.message}`} problem={problem} />
    ));
  if (report === null) {
    return [
      { title: 'Configuration', summary: 'invalid', level: 'error', details: rows(problems) },
    ];
  }
  const used = new Set<DoctorProblem>();
  const take = (test: (code: string) => boolean): DoctorProblem[] => {
    const found = problemsWhere(problems, test);
    for (const p of found) used.add(p);
    return found;
  };
  const agentProblems: DoctorProblem[] = [];
  const folderProblems = take(
    (c) => c.startsWith('skill.') || c === 'tmp.leftover' || c === 'state.unsafe',
  );
  const lockProblems = take((c) => c.startsWith('lock.') || c === 'quarantine.present');
  const approvalProblems = take((c) => c.startsWith('approval.'));
  const journalProblems = take((c) => c.startsWith('journal.'));
  const configProblems = take((c) => c.startsWith('config.'));
  const requirementProblems = take((c) => c.startsWith('requirement.'));
  const other = problems.filter((p) => !used.has(p));
  const skills = report.scopes.reduce((sum, scope) => sum + scope.skills, 0);
  return [
    {
      title: 'Agents',
      summary: report.agents.length === 0 ? 'none detected' : `${report.agents.length} detected`,
      level: report.agents.length === 0 ? 'warning' : levelOf(agentProblems),
      details: report.agents.map((agent) => (
        <Text key={agent.id}>
          <AgentChip id={agent.id} confidence={agent.confidence} />
          <T tone="text">{`  ${safe(agent.displayName)}`}</T>
          <T tone="muted">{agent.version ? `  ${safe(agent.version)}` : ''}</T>
          <T tone="subtle">{`  ${agent.confidence}${agent.status === 'experimental' ? ' · experimental' : ''}  ${safe(agent.evidence[0] ?? '')}`}</T>
        </Text>
      )),
    },
    {
      title: 'Skill folders',
      summary: `path table ${safe(report.pathTableVersion)}`,
      level: levelOf(folderProblems),
      details: [
        ...report.scopes.map((scope) => (
          <Text key={scope.scope}>
            <T tone="subtle">{scope.scope.padEnd(9)}</T>
            <T tone="text">{displayPath(scope.root, home)}</T>
          </Text>
        )),
        ...(report.projectRoot === null
          ? [
              <T key="np" tone="subtle">
                (not inside a project: installs default to the user scope)
              </T>,
            ]
          : []),
        ...rows(folderProblems),
      ],
    },
    {
      title: 'Locks',
      summary: `${skills} skill${skills === 1 ? '' : 's'} recorded`,
      level: levelOf(lockProblems),
      details: [
        ...report.scopes.map((scope) => (
          <Text key={scope.scope}>
            <T tone="subtle">{scope.scope.padEnd(9)}</T>
            <T tone={scope.lockExists ? 'text' : 'subtle'}>
              {scope.lockExists ? `${scope.skills} skill(s)` : 'no lock yet'}
            </T>
          </Text>
        )),
        ...rows(lockProblems),
      ],
    },
    {
      title: 'Approvals',
      summary:
        approvalProblems.length === 0
          ? 'every installed version approved'
          : `${approvalProblems.length} to review`,
      level: levelOf(approvalProblems),
      details: rows(approvalProblems),
    },
    {
      title: 'Transactions',
      summary:
        report.pendingJournals.length === 0
          ? 'none interrupted'
          : `${report.pendingJournals.length} interrupted`,
      level: report.pendingJournals.length > 0 ? 'warning' : levelOf(journalProblems),
      details: [
        ...report.pendingJournals.map((journal) => (
          <T key={journal} tone="muted">
            {safe(journal)}
          </T>
        )),
        ...rows(journalProblems),
      ],
    },
    {
      title: 'Registry and config',
      summary: view.registry === null ? 'no registry configured' : safe(view.registry),
      level:
        view.registry === null && configProblems.length === 0 ? 'info' : levelOf(configProblems),
      details: [
        <Text key="cache">
          <T tone="subtle">cache </T>
          <T tone="text">{formatBytes(report.cacheBytes)}</T>
        </Text>,
        ...rows(configProblems),
      ],
    },
    {
      title: 'Requirements',
      summary:
        requirementProblems.length === 0
          ? 'met or not checkable'
          : `${requirementProblems.length} unmet`,
      level: levelOf(requirementProblems),
      details: rows(requirementProblems),
    },
    ...(other.length === 0
      ? []
      : [
          {
            title: 'Other',
            summary: `${other.length} problem(s)`,
            level: levelOf(other),
            details: rows(other),
          },
        ]),
  ];
}

export function DoctorScreen() {
  const app = useApp();
  const [state] = useTask(() => app.session.doctor(), []);
  return (
    <Box flexDirection="column" paddingX={1}>
      <TaskView
        state={state}
        loading="Checking agents, folders, locks and approvals"
        what="Doctor failed"
      >
        {(view) => <Checks view={view} />}
      </TaskView>
    </Box>
  );
}

function Checks({ view }: { view: DoctorView }) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const checks = buildChecks(view);
  const resolved = useReveal(checks.length, { interval: 120 });
  const errors = view.problems.filter((p) => p.level === 'error').length;
  const warnings = view.problems.length - errors;
  const glyph = { ok: g.ok, warning: g.warn, error: g.block, info: g.info } as const;
  const tone = { ok: 'signal', warning: 'warn', error: 'block', info: 'info' } as const;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between" marginBottom={1}>
        <T tone="text" bold>
          Doctor
        </T>
        {resolved < checks.length ? (
          <T tone="subtle">{`${resolved}/${checks.length}`}</T>
        ) : view.problems.length === 0 ? (
          <T tone="signal">{`${g.ok} no problems found`}</T>
        ) : (
          <T
            tone={errors > 0 ? 'block' : 'warn'}
          >{`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`}</T>
        )}
      </Box>
      <Scroll height={Math.max(6, app.rows - 6)}>
        {checks.map((check, index) => {
          const state = index < resolved ? 'done' : index === resolved ? 'active' : 'pending';
          return (
            <Box
              key={check.title}
              flexDirection="column"
              marginBottom={state === 'done' && check.details.length > 0 ? 1 : 0}
            >
              <Box>
                <Box width={3}>
                  {state === 'active' ? (
                    <Spinner />
                  ) : state === 'pending' ? (
                    <T tone="border">{g.pending}</T>
                  ) : (
                    <T tone={tone[check.level]}>{glyph[check.level]}</T>
                  )}
                </Box>
                <Box width={22}>
                  <T tone={state === 'pending' ? 'subtle' : 'text'} bold={state !== 'pending'}>
                    {check.title}
                  </T>
                </Box>
                <T
                  tone={
                    state === 'done'
                      ? check.level === 'ok'
                        ? 'muted'
                        : tone[check.level]
                      : 'subtle'
                  }
                >
                  {state === 'done'
                    ? check.summary
                    : state === 'active'
                      ? `checking${g.ellipsis}`
                      : ''}
                </T>
              </Box>
              {state === 'done'
                ? check.details.map((detail, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: detail rows are positional
                    <Box key={i} paddingLeft={5}>
                      {detail}
                    </Box>
                  ))
                : null}
            </Box>
          );
        })}
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
