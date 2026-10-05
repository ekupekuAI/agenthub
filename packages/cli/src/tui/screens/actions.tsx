/**
 * Diff, approve, remove and rollback: each previews what it would do (read-only), asks, then
 * acts through the engine.
 */
import type { ApproveResult, InstallResult, RemoveResult, SkillDiff } from '@agenthub/core';
import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { approvalStateText, fileSummaryLine, INVENTORY_CAPTION } from '../../capability-format';
import { shortDigest } from '../../format';
import { Stamp } from '../components/badges';
import { ErrorCard } from '../components/cards';
import { Panel, T } from '../components/primitives';
import { StageList } from '../components/stages';
import { useApp, useKeys, useTheme } from '../hooks/context';
import { useTask } from '../hooks/task';
import { safe } from '../sanitize';
import type { Timed } from '../session';
import { DeltaRows, InventoryRows } from './capabilities';
import { Footer, Loading, TaskView } from './common';
import { ConfirmBar, useStageCursor } from './flow';
import { ResultCard } from './plan';

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export function DiffScreen({ name }: { name: string }) {
  const app = useApp();
  const [state] = useTask(() => app.session.diff(name), [name]);
  return (
    <Box flexDirection="column" paddingX={1}>
      <TaskView
        state={state}
        loading={`Downloading and scanning the next version of ${safe(name)}`}
        what="Diff failed"
      >
        {(diff) => <Diff diff={diff} />}
      </TaskView>
    </Box>
  );
}

function Diff({ diff }: { diff: SkillDiff }) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  useKeys((input) => {
    if (input === 'u') {
      app.navigate({ kind: 'update-flow', name: diff.name });
      return true;
    }
    return false;
  });
  const same = diff.from.digest === diff.to.digest;
  return (
    <Box flexDirection="column">
      <Panel
        heading={`${safe(diff.name)} ${safe(diff.from.version)} ${g.arrow} ${safe(diff.to.version)}`}
        tone={diff.approvalRequired ? 'warn' : undefined}
        aside={<T tone="subtle">{INVENTORY_CAPTION}</T>}
      >
        <Box marginTop={1} flexDirection="column">
          {same ? (
            <T tone="muted">the same files as installed</T>
          ) : (
            <DeltaRows delta={diff.delta} />
          )}
        </Box>
        {!same && diff.candidate.undeclared.length > 0 ? (
          <T tone="warn">{`observed but not declared by the publisher: ${diff.candidate.undeclared.map(safe).join(', ')}`}</T>
        ) : null}
        {same ? null : <T tone="muted">{fileSummaryLine(diff.files)}</T>}
        <Text>
          <T tone="subtle">installed version: </T>
          <T tone="text">
            {diff.baseline === 'unavailable'
              ? 'no intact copy to rescan'
              : approvalStateText(diff.baseline)}
          </T>
        </Text>
        <Text>
          <T tone="subtle">digests: </T>
          <T tone="info">{shortDigest(diff.from.digest)}</T>
          <T tone="subtle">{` ${g.arrow} `}</T>
          <T tone="info">{shortDigest(diff.to.digest)}</T>
        </Text>
      </Panel>
      {same ? null : diff.approvalRequired ? (
        <Box
          borderStyle={g.border}
          borderColor={theme.palette.warn}
          paddingX={1}
          flexDirection="column"
        >
          <T tone="warn" bold>
            {`${g.warn} Expansion: ${diff.unapproved.length} capabilit${diff.unapproved.length === 1 ? 'y needs' : 'ies need'} approval before this update can be applied.`}
          </T>
          {diff.unapproved.map((token) => (
            <T key={token} tone="warn">{`  + ${safe(token)}`}</T>
          ))}
        </Box>
      ) : (
        <Box paddingX={1}>
          <T tone="muted">
            No expansion found by static analysis. A capability diff cannot see prose-only changes:
            read the SKILL.md change.
          </T>
        </Box>
      )}
      <Footer
        hints={[
          ['u', 'update'],
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Approve
// ---------------------------------------------------------------------------

export function ApproveScreen({ name }: { name: string }) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const [state] = useTask(() => app.session.approvePreview(name), [name]);
  const [step, setStep] = useState<'review' | 'saving' | 'cancelled'>('review');
  const [done, setDone] = useState<ApproveResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const preview = state.status === 'done' ? state.value : null;

  useKeys(
    (input, key) => {
      if (preview === null || done !== null || error !== null) return false;
      if (step !== 'review') return true;
      if (input === 'y' || input === 'Y') {
        setStep('saving');
        app.setBusy(true);
        app.session.approve(name).then(
          (result) => {
            app.setBusy(false);
            setDone(result);
            app.refresh();
          },
          (failure: unknown) => {
            app.setBusy(false);
            setError(failure);
          },
        );
        return true;
      }
      if (input === 'n' || input === 'N' || key.return || key.escape) {
        setStep('cancelled');
        return true;
      }
      return false;
    },
    { modal: preview !== null && done === null && error === null && step === 'review' },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <TaskView
        state={state}
        loading={`Verifying and rescanning ${safe(name)}`}
        what="Cannot approve"
      >
        {(p) => (
          <Box flexDirection="column">
            <Panel
              heading={`${safe(name)} ${safe(p.version)} (${p.scope})`}
              aside={<T tone="info">{shortDigest(p.approval.digest)}</T>}
            >
              <Box marginTop={1} flexDirection="column">
                <InventoryRows report={p.report} />
              </Box>
              <Box marginTop={1} flexDirection="column">
                <Text>
                  <T tone="subtle">current approval: </T>
                  <T tone="text">{approvalStateText(p.previousState)}</T>
                </Text>
                {p.newlyApproved.length > 0 ? (
                  <T tone="warn">{`not approved before: ${p.newlyApproved.map(safe).join(', ')}`}</T>
                ) : null}
                <T tone="subtle">{INVENTORY_CAPTION}</T>
              </Box>
            </Panel>
            {done !== null ? (
              <Panel
                tone="signal"
                title="Approved"
                aside={<Stamp tone="signal" glyph={g.ok} word="approved" />}
              >
                <Text>
                  <T tone="signal">{`${g.ok} `}</T>
                  <T tone="text" bold>{`Approved ${safe(name)} ${safe(done.version)}`}</T>
                  <T tone="subtle">{`  capabilities ${shortDigest(done.approval.capabilityDigest)}`}</T>
                </Text>
              </Panel>
            ) : error !== null ? (
              <ErrorCard what="Approval failed" error={error} />
            ) : step === 'cancelled' ? (
              <T tone="muted">{`${g.minus} Cancelled — nothing was changed.`}</T>
            ) : step === 'saving' ? (
              <Loading label="Recording the approval in the lock" />
            ) : (
              <>
                <ConfirmBar
                  question={`Approve what ${safe(name)} ${safe(p.version)} can do?`}
                  defaultYes={false}
                  tone="warn"
                />
                <Footer
                  hints={[
                    ['y', 'approve'],
                    ['n', 'cancel'],
                    ['enter', 'no'],
                  ]}
                />
              </>
            )}
            {done !== null || error !== null || step === 'cancelled' ? (
              <Footer hints={[['esc', 'back']]} />
            ) : null}
          </Box>
        )}
      </TaskView>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export function RemoveScreen({ name }: { name: string }) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const [state] = useTask(() => app.session.remove(name, true), [name]);
  const [step, setStep] = useState<'review' | 'removing' | 'cancelled'>('review');
  const [done, setDone] = useState<RemoveResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const preview = state.status === 'done' ? state.value : null;
  const asking = preview !== null && step === 'review' && done === null && error === null;

  useKeys(
    (input, key) => {
      if (!asking) return false;
      if (input === 'y' || input === 'Y') {
        setStep('removing');
        app.setBusy(true);
        app.session.remove(name, false).then(
          (result) => {
            app.setBusy(false);
            setDone(result);
            app.refresh();
          },
          (failure: unknown) => {
            app.setBusy(false);
            setError(failure);
          },
        );
        return true;
      }
      if (input === 'n' || input === 'N' || key.return || key.escape) {
        setStep('cancelled');
        return true;
      }
      return false;
    },
    { modal: asking },
  );

  const shown = done ?? preview;
  return (
    <Box flexDirection="column" paddingX={1}>
      <TaskView
        state={state}
        loading={`Checking what removing ${safe(name)} would delete`}
        what="Cannot remove"
      >
        {() =>
          shown === null ? null : (
            <Box flexDirection="column">
              <Panel
                heading={`${done === null ? 'Remove' : 'Removed'} ${safe(name)} (${shown.scope})`}
                tone={done === null ? 'warn' : 'signal'}
              >
                {shown.removed.map((path) => (
                  <T
                    key={path}
                    tone={done === null ? 'text' : 'muted'}
                  >{`${g.minus} ${safe(path)}`}</T>
                ))}
                {shown.kept.length > 0 ? (
                  <Box flexDirection="column" marginTop={1}>
                    <T tone="warn">{`${g.warn} ${shown.kept.length} modified or extra file(s) are kept:`}</T>
                    {shown.kept.map((path) => (
                      <T key={path} tone="muted">{`  ${safe(path)}`}</T>
                    ))}
                    <T tone="subtle">
                      to delete the folders entirely, run agenthub remove {safe(name)} --force
                    </T>
                  </Box>
                ) : null}
              </Panel>
              {done !== null ? (
                <T tone="signal">{`${g.ok} Removed ${safe(name)}`}</T>
              ) : error !== null ? (
                <ErrorCard what="Remove failed" error={error} />
              ) : step === 'cancelled' ? (
                <T tone="muted">{`${g.minus} Cancelled — nothing was changed.`}</T>
              ) : step === 'removing' ? (
                <Loading label={`Removing ${safe(name)}`} />
              ) : (
                <>
                  <ConfirmBar question={`Remove ${safe(name)}?`} defaultYes={false} tone="warn" />
                  <Footer
                    hints={[
                      ['y', 'remove'],
                      ['n', 'cancel'],
                      ['enter', 'no'],
                    ]}
                  />
                </>
              )}
              {asking || step === 'removing' ? null : <Footer hints={[['esc', 'back']]} />}
            </Box>
          )
        }
      </TaskView>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

const ROLLBACK_STAGES = ['Snapshot', 'Staging', 'Swapping', 'Committed'] as const;

export function RollbackScreen({ name }: { name: string }) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const [state] = useTask(() => app.session.installedVersion(name), [name]);
  const [step, setStep] = useState<'review' | 'running' | 'cancelled'>('review');
  const [result, setResult] = useState<Timed<InstallResult> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [finished, setFinished] = useState(false);
  const asking = state.status === 'done' && step === 'review';
  const phase = error !== null ? 'failed' : result !== null ? 'finished' : 'running';
  const cursor = useStageCursor(step === 'running' ? phase : 'failed', ROLLBACK_STAGES.length);

  useEffect(() => {
    if (result === null || cursor < ROLLBACK_STAGES.length) return undefined;
    const timer = setTimeout(() => setFinished(true), theme.motion ? 200 : 0);
    return () => clearTimeout(timer);
  }, [result, cursor, theme.motion]);

  useKeys(
    (input, key) => {
      if (!asking) return false;
      // Same default as the classic prompt: [Y/n].
      if (input === 'y' || input === 'Y' || key.return) {
        setStep('running');
        app.setBusy(true);
        app.session.rollback(name).then(
          (value) => {
            app.setBusy(false);
            setResult(value);
            app.refresh();
          },
          (failure: unknown) => {
            app.setBusy(false);
            setError(failure);
          },
        );
        return true;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        setStep('cancelled');
        return true;
      }
      return false;
    },
    { modal: asking },
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <TaskView state={state} loading="Reading the lock" what="Cannot roll back">
        {(version) => (
          <Box flexDirection="column">
            {step === 'review' ? (
              <>
                <Panel title="Roll back">
                  <T tone="text">{`${safe(name)}${version === null ? '' : ` ${safe(version)}`} returns to the version saved in its last snapshot.`}</T>
                  <T tone="muted">
                    It goes through the same transaction as an install: all folders or none.
                  </T>
                </Panel>
                <ConfirmBar
                  question={`Roll back ${safe(name)}${version === null ? '' : ` ${safe(version)}`} to its previous version?`}
                  defaultYes
                />
                <Footer
                  hints={[
                    ['y', 'roll back'],
                    ['n', 'cancel'],
                    ['enter', 'yes'],
                  ]}
                />
              </>
            ) : step === 'cancelled' ? (
              <>
                <T tone="muted">{`${g.minus} Cancelled — nothing was changed.`}</T>
                <Footer hints={[['esc', 'back']]} />
              </>
            ) : finished && result !== null ? (
              <>
                <ResultCard verb="Rolled back" result={result.value} ms={result.ms} />
                <Footer hints={[['esc', 'back']]} />
              </>
            ) : (
              <>
                <Panel
                  heading={`Rolling back ${safe(name)}`}
                  tone={error === null ? undefined : 'block'}
                  marginTop={1}
                >
                  <Box marginTop={1}>
                    <StageList
                      stages={ROLLBACK_STAGES.map((label, index) => ({
                        label,
                        state:
                          index < cursor
                            ? 'done'
                            : index === cursor
                              ? error === null
                                ? 'active'
                                : 'failed'
                              : 'pending',
                      }))}
                    />
                  </Box>
                </Panel>
                {error === null ? null : (
                  <>
                    <ErrorCard what="Rollback failed" error={error} />
                    <Footer hints={[['esc', 'back']]} />
                  </>
                )}
              </>
            )}
          </Box>
        )}
      </TaskView>
    </Box>
  );
}
