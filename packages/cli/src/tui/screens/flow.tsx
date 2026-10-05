/**
 * Install and update flow: plan (download, verify, scan) → review → confirm → apply → result.
 *
 * Confirmation follows the classic prompt's rules (plan-flow.ts interactiveConfirmation): WARN
 * findings default to No, and a plan that expands capabilities needs its own explicit approval
 * ("a", then a second yes) — a plain "y" never approves new capabilities. The engine checks the
 * same gate again when applying.
 */
import type { InstallPlan, InstallResult } from '@agenthub/core';
import { Box, Text } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { type InteractiveConfirmation, interactiveConfirmation } from '../../commands/plan-flow';
import { BlockedCard, ErrorCard } from '../components/cards';
import { Panel, T } from '../components/primitives';
import { type Stage, StageList } from '../components/stages';
import { useApp, useKeys, useTheme } from '../hooks/context';
import { formatMs, useTick } from '../hooks/motion';
import { safe } from '../sanitize';
import type { Timed } from '../session';
import { Footer, Loading, Scroll } from './common';
import { PlanView, ResultCard } from './plan';

export const APPLY_STAGES = ['Scanning', 'Staging', 'Swapping', 'Verifying', 'Committed'] as const;

const STAGE_DETAIL: Record<(typeof APPLY_STAGES)[number], string> = {
  Scanning: 'digest verified, files scanned, policy evaluated',
  Staging: 'journal written, verified copy staged per folder',
  Swapping: 'folders swapped in one transaction',
  Verifying: 'installed files checked',
  Committed: 'lock written',
};

/**
 * Index of the active apply stage. While the engine works it advances to "Verifying" and waits;
 * once the engine is done it runs through to the end. Without motion it jumps.
 */
export function useStageCursor(phase: 'running' | 'finished' | 'failed', count: number): number {
  const theme = useTheme();
  const [cursor, setCursor] = useState(1);
  const target = phase === 'finished' ? count : count - 2;
  const moving = phase !== 'failed' && cursor < target;
  const frame = useTick(phase === 'finished' ? 70 : 120, moving);
  useEffect(() => {
    if (!moving) return;
    if (!theme.motion) {
      setCursor(target);
      return;
    }
    if (frame > 0 && (phase === 'finished' || frame % 2 === 0)) {
      setCursor((c) => Math.min(target, c + 1));
    }
  }, [frame, moving, target, phase, theme.motion]);
  return theme.motion ? cursor : phase === 'finished' ? count : cursor;
}

export function applyStages(
  cursor: number,
  phase: 'running' | 'finished' | 'failed',
  planMs: number,
  applyMs: number | null,
): Stage[] {
  return APPLY_STAGES.map((label, index) => {
    const state =
      index < cursor
        ? 'done'
        : index === cursor
          ? phase === 'failed'
            ? 'failed'
            : 'active'
          : 'pending';
    const stage: Stage = { label, state, detail: STAGE_DETAIL[label] };
    if (index === 0) stage.note = formatMs(planMs);
    if (label === 'Committed' && state === 'done' && applyMs !== null)
      stage.note = formatMs(applyMs);
    return stage;
  });
}

/** y / n question line with the default in capitals. */
export function ConfirmBar({
  question,
  defaultYes,
  tone = 'text',
}: {
  question: string;
  defaultYes: boolean;
  tone?: 'text' | 'warn';
}) {
  const theme = useTheme();
  return (
    <Box
      borderStyle={theme.glyphs.border}
      borderColor={theme.palette[tone === 'warn' ? 'warn' : 'signal']}
      paddingX={1}
      marginTop={1}
    >
      <T tone={tone === 'warn' ? 'warn' : 'signal'} bold>
        {`? `}
      </T>
      <T tone="text" bold>
        {safe(question)}
      </T>
      <T tone="muted">{defaultYes ? '  [Y/n]' : '  [y/N]'}</T>
    </Box>
  );
}

type Phase =
  | { step: 'planning' }
  | { step: 'uptodate' }
  | { step: 'plan-error'; error: unknown }
  | { step: 'review'; plan: InstallPlan; planMs: number }
  | { step: 'approve-caps'; plan: InstallPlan; planMs: number }
  | {
      step: 'applying';
      plan: InstallPlan;
      planMs: number;
      result: Timed<InstallResult> | null;
      error: unknown;
    }
  | { step: 'done'; plan: InstallPlan; result: Timed<InstallResult> }
  | { step: 'apply-error'; plan: InstallPlan; planMs: number; error: unknown; cursor: number }
  | { step: 'cancelled'; plan: InstallPlan };

export interface FlowProps {
  mode: 'install' | 'update';
  /** Install target (name[@range], ./folder, file.skillpkg) or the skill to update. */
  target: string;
}

export function InstallFlow({ mode, target }: FlowProps) {
  const app = useApp();
  const theme = useTheme();
  const g = theme.glyphs;
  const [phase, setPhase] = useState<Phase>({ step: 'planning' });
  const [sourceChange, setSourceChange] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    setPhase({ step: 'planning' });
    const work =
      mode === 'install'
        ? app.session
            .planInstall(target)
            .then((t) => ({ plan: t.value as InstallPlan | null, ms: t.ms, change: null }))
        : app.session
            .planUpdate(target)
            .then((t) => ({ plan: t.value.plan, ms: t.ms, change: t.value.sourceChange }));
    work.then(
      ({ plan, ms, change }) => {
        if (!live.current) return;
        setSourceChange(change);
        setPhase(plan === null ? { step: 'uptodate' } : { step: 'review', plan, planMs: ms });
      },
      (error: unknown) => {
        if (live.current) setPhase({ step: 'plan-error', error });
      },
    );
    return () => {
      live.current = false;
    };
  }, [mode, target, app.session]);

  const plan = 'plan' in phase ? phase.plan : null;
  const verb = mode === 'install' ? 'Install' : 'Update';
  const question =
    plan === null
      ? ''
      : mode === 'install'
        ? `Install ${plan.skill.name} ${plan.skill.version}?`
        : `Update ${plan.skill.name} ${plan.previous?.version ?? ''} → ${plan.skill.version}?`;
  const confirmation: InteractiveConfirmation | null =
    plan === null
      ? null
      : interactiveConfirmation(plan, { question, caution: sourceChange !== null });

  const start = (confirmed: 'plan' | 'capabilities', current: InstallPlan, planMs: number) => {
    setPhase({ step: 'applying', plan: current, planMs, result: null, error: undefined });
    app.setBusy(true);
    app.session.apply(current, confirmed).then(
      (result) => {
        app.setBusy(false);
        setPhase((p) => (p.step === 'applying' ? { ...p, result } : p));
        app.refresh();
      },
      (error: unknown) => {
        app.setBusy(false);
        setPhase((p) =>
          p.step === 'applying' ? { ...p, error: error ?? new Error('failed') } : p,
        );
      },
    );
  };

  const reviewing = phase.step === 'review' || phase.step === 'approve-caps';
  const blocked = plan !== null && plan.blockers.length > 0;
  useKeys(
    (input, key) => {
      if (phase.step === 'review') {
        if (blocked) {
          if (key.escape || key.return) {
            app.back();
            return true;
          }
          return false;
        }
        if (confirmation?.kind === 'capabilities') {
          if (input === 'a') {
            setPhase({ step: 'approve-caps', plan: phase.plan, planMs: phase.planMs });
            return true;
          }
          if (input === 'y' || key.return) {
            app.toast(
              'warn',
              `"${input === 'y' ? 'y' : 'enter'}" does not approve new capabilities — review them, then press a`,
            );
            return true;
          }
          if (input === 'n' || key.escape) {
            setPhase({ step: 'cancelled', plan: phase.plan });
            return true;
          }
          return false;
        }
        const yes =
          input === 'y' || input === 'Y' || (key.return && confirmation?.defaultYes === true);
        const no =
          input === 'n' ||
          input === 'N' ||
          key.escape ||
          (key.return && confirmation?.defaultYes === false);
        if (yes) {
          start('plan', phase.plan, phase.planMs);
          return true;
        }
        if (no) {
          setPhase({ step: 'cancelled', plan: phase.plan });
          return true;
        }
        return false;
      }
      if (phase.step === 'approve-caps') {
        if (input === 'y' || input === 'Y') {
          start('capabilities', phase.plan, phase.planMs);
          return true;
        }
        if (input === 'n' || input === 'N' || key.return || key.escape) {
          setPhase({ step: 'cancelled', plan: phase.plan });
          return true;
        }
        return false;
      }
      if (phase.step === 'done') {
        if (input === 'r' && mode === 'update') {
          app.replace({ kind: 'rollback', name: phase.result.value.name });
          return true;
        }
        if (input === 'l') {
          app.replace({ kind: 'list' });
          return true;
        }
        if (input === 'v') {
          app.replace({ kind: 'verify', name: phase.result.value.name });
          return true;
        }
        if (key.return || key.escape) {
          app.back();
          return true;
        }
        return false;
      }
      if (phase.step === 'applying') return true; // keys wait until the transaction ends
      if (key.escape || key.return) {
        app.back();
        return true;
      }
      return false;
    },
    { modal: reviewing || phase.step === 'applying' || phase.step === 'done' },
  );

  if (phase.step === 'planning') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Loading
          label={
            mode === 'install'
              ? `Planning ${safe(target)} ${g.sep} resolving, verifying the digest, scanning`
              : `Planning the update of ${safe(target)} ${g.sep} downloading and scanning the candidate`
          }
        />
      </Box>
    );
  }
  if (phase.step === 'uptodate') {
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <T tone="signal">{`${g.ok} ${safe(target)} is up to date.`}</T>
        <Footer hints={[['esc', 'back']]} />
      </Box>
    );
  }
  if (phase.step === 'plan-error') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <ErrorCard what={`${verb} plan failed`} error={phase.error} />
        <Footer hints={[['esc', 'back']]} />
      </Box>
    );
  }
  if (phase.step === 'applying' || phase.step === 'apply-error') {
    return <Applying phase={phase} verb={verb} onFinish={setPhase} />;
  }
  if (phase.step === 'done') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <ResultCard
          verb={mode === 'install' ? 'Installed' : 'Updated'}
          result={phase.result.value}
          ms={phase.result.ms}
        />
        <Footer
          hints={[
            ...(mode === 'update' ? ([['r', 'roll back']] as const) : []),
            ['v', 'verify'],
            ['l', 'installed'],
            ['enter', 'done'],
          ]}
        />
      </Box>
    );
  }
  if (phase.step === 'cancelled') {
    return (
      <Box flexDirection="column" paddingX={1} marginTop={1}>
        <T tone="muted">{`${g.minus} Cancelled — nothing was changed.`}</T>
        <Footer hints={[['esc', 'back']]} />
      </Box>
    );
  }

  // Review and capability approval.
  const current = phase.plan;
  const height = Math.max(6, app.rows - (blocked ? 4 : 6));
  return (
    <Box flexDirection="column" paddingX={1}>
      {sourceChange === null ? null : (
        <T tone="warn">{`${g.warn} ${safe(sourceChange)}; updating replaces it with the registry's package`}</T>
      )}
      <Scroll height={height}>
        {blocked ? <BlockedCard plan={current} /> : null}
        <PlanView plan={current} home={app.session.home} />
      </Scroll>
      {blocked ? (
        <Footer
          hints={[
            ['esc', 'back'],
            [`${g.up}${g.down}`, 'scroll'],
          ]}
        />
      ) : phase.step === 'approve-caps' ? (
        <>
          <ConfirmBar question={confirmation?.question ?? ''} defaultYes={false} tone="warn" />
          <Footer
            hints={[
              ['y', 'approve and update'],
              ['n', 'cancel'],
              ['enter', 'no'],
            ]}
          />
        </>
      ) : confirmation?.kind === 'capabilities' ? (
        <>
          <Box borderStyle={g.border} borderColor={theme.palette.warn} paddingX={1} marginTop={1}>
            <T tone="warn" bold>
              {`${g.warn} ${confirmation.count} new capabilit${confirmation.count === 1 ? 'y needs' : 'ies need'} your explicit approval. `}
            </T>
            <T tone="muted">A plain yes never approves them.</T>
          </Box>
          <Footer
            hints={[
              ['a', 'approve capabilities'],
              ['n', 'cancel'],
              [`${g.up}${g.down}`, 'scroll'],
              ['esc', 'back'],
            ]}
          />
        </>
      ) : (
        <>
          <ConfirmBar
            question={question}
            defaultYes={confirmation?.defaultYes === true}
            tone={confirmation?.defaultYes ? 'text' : 'warn'}
          />
          <Footer
            hints={[
              ['y', 'yes'],
              ['n', 'no'],
              ['enter', confirmation?.defaultYes ? 'yes' : 'no'],
              [`${g.up}${g.down}`, 'scroll'],
            ]}
          />
        </>
      )}
    </Box>
  );
}

function Applying({
  phase,
  verb,
  onFinish,
}: {
  phase: Extract<Phase, { step: 'applying' } | { step: 'apply-error' }>;
  verb: string;
  onFinish: (next: Phase) => void;
}) {
  const app = useApp();
  const theme = useTheme();
  const failed =
    phase.step === 'apply-error' || (phase.step === 'applying' && phase.error !== undefined);
  const finished = phase.step === 'applying' && phase.result !== null;
  const stagePhase = failed ? 'failed' : finished ? 'finished' : 'running';
  const cursor = useStageCursor(stagePhase, APPLY_STAGES.length);
  const result = phase.step === 'applying' ? phase.result : null;

  useEffect(() => {
    if (phase.step === 'applying' && phase.error !== undefined) {
      onFinish({
        step: 'apply-error',
        plan: phase.plan,
        planMs: phase.planMs,
        error: phase.error,
        cursor,
      });
    }
  }, [phase, cursor, onFinish]);
  useEffect(() => {
    if (finished && result !== null && cursor >= APPLY_STAGES.length) {
      const timer = setTimeout(
        () => onFinish({ step: 'done', plan: phase.plan, result }),
        theme.motion ? 220 : 0,
      );
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [finished, result, cursor, phase.plan, onFinish, theme.motion]);

  const shownCursor = phase.step === 'apply-error' ? phase.cursor : cursor;
  const stages = applyStages(shownCursor, stagePhase, phase.planMs, result?.ms ?? null);
  const skill = phase.plan.skill;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Panel
        heading={`${verb === 'Install' ? 'Installing' : 'Updating'} ${safe(skill.name)} ${safe(skill.version)}`}
        tone={failed ? 'block' : finished ? 'signal' : undefined}
        marginTop={1}
      >
        <Box marginTop={1}>
          <StageList stages={stages} width={Math.min(48, Math.max(16, app.columns - 20))} />
        </Box>
      </Panel>
      {phase.step === 'apply-error' ? (
        <>
          <ErrorCard what={`${verb} failed`} error={phase.error} />
          <Box marginTop={1}>
            <Text>
              <T tone="muted">A transaction that fails part-way is undone: </T>
              <T tone="text">the previous state is intact.</T>
            </Text>
          </Box>
          <Footer hints={[['esc', 'back']]} />
        </>
      ) : null}
    </Box>
  );
}
