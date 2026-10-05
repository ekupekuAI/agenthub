'use client';

import { unstable_rethrow } from 'next/navigation';
import { type FormEvent, type ReactNode, useActionState, useId, useState } from 'react';
import {
  BanIcon,
  Button,
  type ButtonVariant,
  Callout,
  CheckIcon,
  Dialog,
  LockIcon,
  OutcomeBadge,
  ReceiptRow,
  RefreshIcon,
  type ScanOutcomeValue,
  TextareaField,
} from '../../src/components/ui';
import { cn } from '../../src/lib/cn';
import { approveAction, quarantineAction, rescanAction, revokeAction } from './actions';

/** The serializable facts about a version that the decision controls need. */
export interface ModerationTarget {
  slug: string;
  version: string;
  publisher: string;
  outcome: ScanOutcomeValue | null;
  /** Number of BLOCK findings in the latest scan. */
  blockCount: number;
}

type ReasonOp = 'approve' | 'quarantine' | 'revoke';

/** Mirrors `reasonSchema` on the server, which stays the authority. */
const REASON_MIN = 3;
const REASON_MAX = 500;

const NO_ANSWER =
  'The registry did not answer. Reload the page to see whether the change was applied before you try again.';

const OPS: Record<
  ReasonOp,
  {
    action: (formData: FormData) => Promise<void>;
    verb: string;
    description: string;
    submit: string;
    variant: ButtonVariant;
    icon: ReactNode;
    placeholder: string;
  }
> = {
  approve: {
    action: approveAction,
    verb: 'Approve',
    description: 'The version leaves quarantine and can be installed again.',
    submit: 'Approve version',
    variant: 'primary',
    icon: <CheckIcon size={15} />,
    placeholder: 'What you checked, and why the version is acceptable.',
  },
  quarantine: {
    action: quarantineAction,
    verb: 'Quarantine',
    description:
      'Installs and downloads of this version are refused until a moderator approves it again.',
    submit: 'Quarantine version',
    variant: 'secondary',
    icon: <LockIcon size={15} />,
    placeholder: 'What needs a closer look.',
  },
  revoke: {
    action: revokeAction,
    verb: 'Revoke',
    description: 'Installs and downloads of this version are refused from now on.',
    submit: 'Revoke version',
    variant: 'danger',
    icon: <BanIcon size={15} />,
    placeholder: 'What is wrong with this version.',
  },
};

/**
 * Runs a moderation server action and turns a failed request into a message. The actions
 * always answer with a redirect, which Next.js delivers as a thrown navigation signal: that
 * one is passed on untouched.
 */
function useModeration(action: (formData: FormData) => Promise<void>) {
  return useActionState(async (_previous: string | null, formData: FormData) => {
    try {
      await action(formData);
    } catch (error) {
      unstable_rethrow(error);
      return NO_ANSWER;
    }
    return null;
  }, null);
}

function TargetFields({ target }: { target: ModerationTarget }) {
  return (
    <>
      <input type="hidden" name="slug" value={target.slug} />
      <input type="hidden" name="version" value={target.version} />
    </>
  );
}

interface ReasonDialogProps {
  op: ReasonOp;
  target: ModerationTarget;
  open: boolean;
  onClose: () => void;
}

/** Confirmation for approve, quarantine and revoke. Each needs a written reason. */
function ReasonDialog({ op, target, open, onClose }: ReasonDialogProps) {
  const config = OPS[op];
  const baseId = useId();
  const formId = `${baseId}-form`;
  const reasonId = `${baseId}-reason`;
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failure, submit, pending] = useModeration(config.action);
  const subject = `${target.slug}@${target.version}`;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const length = reason.trim().length;
    if (length < REASON_MIN) {
      event.preventDefault();
      setInvalid(`Write a reason of at least ${REASON_MIN} characters.`);
      event.currentTarget.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!pending) onClose();
      }}
      tone={op === 'revoke' ? 'danger' : 'default'}
      title={
        <>
          {config.verb} <span className="break-all font-mono text-[0.9375rem]">{subject}</span>
        </>
      }
      description={config.description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={config.variant}
            loading={pending}
            leadingIcon={config.icon}
          >
            {config.submit}
          </Button>
        </>
      }
    >
      <form id={formId} action={submit} onSubmit={onSubmit} noValidate className="grid gap-4">
        <TargetFields target={target} />

        <dl className="m-0 rounded-control border border-border bg-surface-2 px-3.5 py-1.5">
          <ReceiptRow label="Publisher">
            <span className="[overflow-wrap:anywhere]">{target.publisher}</span>
          </ReceiptRow>
          <ReceiptRow label="Scan verdict">
            <OutcomeBadge outcome={target.outcome} />
          </ReceiptRow>
        </dl>

        {op === 'approve' && target.blockCount > 0 ? (
          <Callout tone="warning" title="The scanner blocked this version">
            The latest scan has {target.blockCount} BLOCK{' '}
            {target.blockCount === 1 ? 'finding' : 'findings'}. Approving overrides that verdict.
          </Callout>
        ) : null}
        {op === 'revoke' ? (
          <Callout tone="danger" title="Revocation is final">
            A revoked version cannot be approved or published again.
          </Callout>
        ) : null}

        <TextareaField
          id={reasonId}
          name="reason"
          label="Reason"
          required
          rows={3}
          minLength={REASON_MIN}
          maxLength={REASON_MAX}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            if (invalid) setInvalid(null);
          }}
          placeholder={config.placeholder}
          error={invalid}
          hint={
            <span className="flex items-baseline justify-between gap-3">
              <span>Saved with the version and visible to its publisher.</span>
              <span className="shrink-0 font-mono tabular-nums">
                {reason.length}/{REASON_MAX}
              </span>
            </span>
          }
          data-autofocus
        />

        {failure ? (
          <Callout tone="danger" role="alert" title="No answer">
            {failure}
          </Callout>
        ) : null}
      </form>
    </Dialog>
  );
}

export interface ModerationActionsProps {
  target: ModerationTarget;
  /** `quarantined` offers approve; `active` offers quarantine. Both offer rescan and revoke. */
  mode: 'quarantined' | 'active';
  /** `card` for the review queue footer, `row` for a table cell. */
  layout?: 'card' | 'row';
}

/**
 * Decision controls for one version. Approve, quarantine and revoke open a dialog that needs
 * a reason; rescan runs straight away. Revoke is permanent, so it sits apart behind a rule.
 */
export function ModerationActions({ target, mode, layout = 'card' }: ModerationActionsProps) {
  const primaryOp: ReasonOp = mode === 'quarantined' ? 'approve' : 'quarantine';
  // `run` changes on every open, so each dialog starts with an empty reason and no errors.
  const [dialog, setDialog] = useState<{ op: ReasonOp; open: boolean; run: number }>({
    op: primaryOp,
    open: false,
    run: 0,
  });
  const [rescanFailure, rescan, rescanning] = useModeration(rescanAction);
  const row = layout === 'row';
  const size = row ? 'sm' : 'md';
  const subject = <span className="sr-only"> {`${target.slug}@${target.version}`}</span>;

  function open(op: ReasonOp) {
    setDialog((current) => ({ op, open: true, run: current.run + 1 }));
  }

  return (
    <div className={cn('flex flex-col gap-2', row && 'sm:items-end')}>
      <div
        className={cn(
          'flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center',
          row && 'sm:justify-end',
        )}
      >
        {mode === 'quarantined' ? (
          <Button
            variant="primary"
            size={size}
            leadingIcon={<CheckIcon size={15} />}
            onClick={() => open('approve')}
          >
            Approve{subject}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size={size}
            leadingIcon={<LockIcon size={15} />}
            onClick={() => open('quarantine')}
          >
            Quarantine{subject}
          </Button>
        )}
        <form action={rescan} className="flex flex-col sm:block">
          <TargetFields target={target} />
          <Button
            type="submit"
            variant={row ? 'ghost' : 'secondary'}
            size={size}
            loading={rescanning}
            leadingIcon={<RefreshIcon size={15} />}
          >
            Rescan{subject}
          </Button>
        </form>
        <span
          aria-hidden="true"
          className={cn(
            'my-1 h-px bg-border sm:my-0 sm:h-5 sm:w-px',
            row ? 'sm:mx-1' : 'sm:mr-1 sm:ml-auto',
          )}
        />
        <Button
          variant="danger"
          size={size}
          leadingIcon={<BanIcon size={15} />}
          onClick={() => open('revoke')}
        >
          Revoke{subject}
        </Button>
      </div>

      {rescanFailure ? (
        <p role="alert" className="text-block text-small">
          {rescanFailure}
        </p>
      ) : null}

      <ReasonDialog
        key={dialog.run}
        op={dialog.op}
        target={target}
        open={dialog.open}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
      />
    </div>
  );
}
