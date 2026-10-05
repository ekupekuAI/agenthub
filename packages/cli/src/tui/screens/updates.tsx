/**
 * Update candidates with the CHANGE column (capability change against the approved baseline).
 * Enter expands a row: an expansion shows its new capabilities in a highlighted card; "u" opens
 * the update flow, which asks for an explicit capability approval.
 */
import type { UpdateCandidate } from '@agenthub/core';
import { Box, Text } from 'ink';
import { useState } from 'react';
import { changeLabel } from '../../commands/update';
import { Panel, T, type Tone } from '../components/primitives';
import { useApp, useKeys, useTheme } from '../hooks/context';
import { moveSelection, useSelection } from '../hooks/list';
import { formatMs, useReveal } from '../hooks/motion';
import { useTask } from '../hooks/task';
import { fit, safe } from '../sanitize';
import { Footer, ScreenTitle, TaskView } from './common';

function changeTone(candidate: UpdateCandidate): Tone {
  const change = candidate.change;
  if (change === undefined) return 'subtle';
  if (change.expansion) return 'warn';
  return 'signal';
}

function statusTone(status: UpdateCandidate['status']): Tone {
  if (status === 'available') return 'info';
  if (status === 'up-to-date') return 'signal';
  if (
    status === 'current-revoked' ||
    status === 'current-quarantined' ||
    status === 'digest-mismatch'
  )
    return 'block';
  return 'warn';
}

export function UpdatesScreen({ name }: { name?: string }) {
  const app = useApp();
  const [state, reload] = useTask(() => app.session.checkUpdates(name), [name]);
  return (
    <Box flexDirection="column" paddingX={1}>
      <TaskView
        state={state}
        loading="Checking the registry and scanning candidates"
        what="Update check failed"
      >
        {(found) => <Candidates candidates={found.value} ms={found.ms} reload={reload} />}
      </TaskView>
    </Box>
  );
}

const COLUMNS = [
  ['SKILL', 22],
  ['SCOPE', 9],
  ['CURRENT', 10],
  ['LATEST', 10],
  ['CHANGE', 16],
] as const;

function Candidates({
  candidates,
  ms,
  reload,
}: {
  candidates: UpdateCandidate[];
  ms: number;
  reload: () => void;
}) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const [selected, setSelected] = useSelection(candidates.length);
  const [expanded, setExpanded] = useState<string | null>(null);
  const shown = useReveal(candidates.length, { interval: 60 });
  const current = candidates[selected];
  const available = candidates.filter((c) => c.status === 'available').length;

  useKeys((input, key) => {
    const next = moveSelection(selected, candidates.length, input, key);
    if (next !== null) {
      setSelected(next);
      return true;
    }
    if (current === undefined) return false;
    if (key.return) {
      setExpanded((value) => (value === current.name ? null : current.name));
      return true;
    }
    if (
      input === 'u' &&
      (current.status === 'available' ||
        current.status === 'current-revoked' ||
        current.status === 'current-quarantined')
    ) {
      app.navigate({ kind: 'update-flow', name: current.name });
      return true;
    }
    if (input === 'd') {
      app.navigate({ kind: 'diff', name: current.name });
      return true;
    }
    if (input === 'r') {
      reload();
      return true;
    }
    return false;
  });

  return (
    <Box flexDirection="column">
      <ScreenTitle
        title={
          <Text>
            <T tone="text" bold>
              Updates
            </T>
            <T tone="muted">{`  ${available} available`}</T>
          </Text>
        }
        meta={<T tone="subtle">{`${candidates.length} checked ${g.sep} ${formatMs(ms)}`}</T>}
        subtitle="CHANGE compares each candidate with the capabilities you approved (static analysis, not a safety verdict)."
      />
      {candidates.length === 0 ? <T tone="muted">No installed skills to check.</T> : null}
      {candidates.length > 0 ? (
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
            STATUS
          </T>
        </Box>
      ) : null}
      {candidates.slice(0, shown).map((c, index) => {
        const active = index === selected;
        const open = expanded === c.name;
        return (
          <Box key={`${c.scope}:${c.name}`} flexDirection="column">
            <Box>
              <Box width={2}>
                <T tone="signal">{active ? g.pointer : ' '}</T>
              </Box>
              <Box width={22}>
                <T tone={active ? 'signal' : 'text'} bold>
                  {fit(safe(c.name), 21)}
                </T>
              </Box>
              <Box width={9}>
                <T tone="muted">{c.scope}</T>
              </Box>
              <Box width={10}>
                <T tone="muted">{fit(safe(c.current), 9)}</T>
              </Box>
              <Box width={10}>
                <T
                  tone={
                    c.latestCompatible !== null && c.latestCompatible !== c.current
                      ? 'info'
                      : 'muted'
                  }
                >
                  {fit(safe(c.latestCompatible ?? c.latest ?? '—'), 9)}
                </T>
              </Box>
              <Box width={16}>
                <T tone={changeTone(c)} bold={c.change?.expansion === true}>
                  {`${c.change?.expansion ? `${g.warn} ` : ''}${changeLabel(c)}`}
                </T>
              </Box>
              <T tone={statusTone(c.status)}>{fit(c.status, 18)}</T>
            </Box>
            {open ? <Expansion candidate={c} /> : null}
          </Box>
        );
      })}
      {candidates.length > 0 ? (
        <Footer
          hints={[
            [`${g.up}${g.down}`, 'select'],
            ['enter', 'expand'],
            ['u', 'update'],
            ['d', 'diff'],
            ['r', 'recheck'],
            ['esc', 'back'],
          ]}
        />
      ) : null}
    </Box>
  );
}

function Expansion({ candidate }: { candidate: UpdateCandidate }) {
  const theme = useTheme();
  const g = theme.glyphs;
  const change = candidate.change;
  if (change === undefined) {
    return (
      <Box paddingLeft={2} marginBottom={1}>
        <T tone="muted">
          {candidate.reason ? safe(candidate.reason) : `status: ${candidate.status}`}
        </T>
      </Box>
    );
  }
  if (!change.expansion) {
    return (
      <Box paddingLeft={2} marginBottom={1}>
        <T tone="signal">{`${g.ok} no new capabilities`}</T>
        <T tone="muted">
          {change.removed > 0 ? ` ${g.sep} ${change.removed} removed (narrower)` : ''}
        </T>
      </Box>
    );
  }
  return (
    <Box paddingLeft={2} marginBottom={1}>
      <Panel
        tone="warn"
        heading={`${safe(candidate.name)} ${safe(candidate.current)} ${g.arrow} ${safe(candidate.latestCompatible ?? '')}`}
        aside={<T tone="warn">{`${change.unapproved.length} new`}</T>}
        flexGrow={1}
      >
        {change.unapproved.map((token) => (
          <T key={token} tone="warn" bold>
            {`+ ${safe(token).replace(':', '  ')}`}
          </T>
        ))}
        <Box marginTop={1}>
          <T tone="muted">Updating needs an explicit capability approval. Press </T>
          <T tone="text" bold>
            u
          </T>
          <T tone="muted"> to review the full plan, or </T>
          <T tone="text" bold>
            d
          </T>
          <T tone="muted"> for the diff.</T>
        </Box>
      </Panel>
    </Box>
  );
}
