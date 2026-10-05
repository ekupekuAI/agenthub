'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import {
  Button,
  Callout,
  CopyCommand,
  Dialog,
  EmptyState,
  formatDate,
  KeyIcon,
  PlusIcon,
  Table,
  TBody,
  TD,
  TextField,
  TH,
  THead,
  TR,
  TrashIcon,
} from '../../src/components/ui';
import type { TokenSummary } from '../../src/lib/accounts';
import { type TokensState, tokensAction } from './actions';

/** CLI tokens of the signed-in publisher: create (shown once), list and revoke. */
export function TokensPanel({ initialTokens }: { initialTokens: TokenSummary[] }) {
  const [state, action, pending] = useActionState<TokensState, FormData>(tokensAction, {
    tokens: initialTokens,
  });
  const [confirm, setConfirm] = useState<TokenSummary | null>(null);
  const createForm = useRef<HTMLFormElement | null>(null);
  const revokeForm = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    if (state.created) createForm.current?.reset();
  }, [state]);

  return (
    <section aria-labelledby="tokens-heading" className="flex min-w-0 flex-col gap-6">
      <div>
        <p className="eyebrow">Command line</p>
        <h2
          id="tokens-heading"
          className="mt-2 font-display text-[1.75rem] text-text leading-[1.15]"
        >
          CLI tokens
        </h2>
        <p className="mt-1 max-w-2xl text-muted text-small">
          Tokens let <code>agenthub publish</code> and the API act as this publisher. Name each one
          after the machine or pipeline that uses it, and revoke it when that changes.
        </p>
      </div>

      <form
        ref={createForm}
        action={action}
        className="flex flex-col gap-3 rounded-panel border border-border bg-surface-1 p-5 shadow-panel sm:flex-row sm:items-end"
      >
        <input type="hidden" name="intent" value="create" />
        <TextField
          id="token-name"
          name="name"
          label="Token name"
          required
          maxLength={48}
          autoComplete="off"
          placeholder="laptop CLI"
          disabled={pending}
          fieldClassName="flex-1"
        />
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          leadingIcon={<PlusIcon size={15} />}
        >
          Create token
        </Button>
      </form>

      <div aria-live="polite" className="empty:hidden">
        {state.error ? (
          <Callout tone="danger" role="alert" title="Nothing changed">
            {state.error}
          </Callout>
        ) : null}
        {state.created ? (
          <Callout tone="warning" title={<>Token “{state.created.name}” created. Copy it now</>}>
            <p>It is shown only once: the registry keeps only a hash of it.</p>
            <CopyCommand
              command={state.created.token}
              prompt={false}
              label="New publisher token"
              className="mt-3"
            />
          </Callout>
        ) : null}
        {state.revoked ? (
          <Callout tone="success" role="status" title={<>Token “{state.revoked}” revoked</>}>
            It no longer works for publishing.
          </Callout>
        ) : null}
      </div>

      {state.tokens.length === 0 ? (
        <EmptyState
          icon={<KeyIcon size={22} />}
          title="No active tokens"
          description="You can publish from this site while signed in. Create a token to publish from the command line."
        />
      ) : (
        <Table caption="Active CLI tokens" stack>
          <THead>
            <TR>
              <TH>Name</TH>
              <TH>Created</TH>
              <TH>Last used</TH>
              <TH align="right">
                <span className="sr-only">Actions</span>
              </TH>
            </TR>
          </THead>
          <TBody>
            {state.tokens.map((token) => (
              <TR key={token.id}>
                <TD label="Name">{token.name}</TD>
                <TD label="Created">{formatDate(token.createdAt)}</TD>
                <TD label="Last used">
                  {token.lastUsedAt ? formatDate(token.lastUsedAt) : 'Never'}
                </TD>
                <TD label="Actions" align="right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setConfirm(token)}
                    leadingIcon={<TrashIcon size={14} />}
                  >
                    Revoke<span className="sr-only"> {token.name}</span>
                  </Button>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <form ref={revokeForm} action={action} hidden>
        <input type="hidden" name="intent" value="revoke" />
        <input type="hidden" name="tokenId" value={confirm?.id ?? ''} />
      </form>
      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        tone="danger"
        size="sm"
        title={<>Revoke “{confirm?.name}”?</>}
        description="Anything still using this token can no longer publish. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                revokeForm.current?.requestSubmit();
                setConfirm(null);
              }}
            >
              Revoke token
            </Button>
          </>
        }
      />
    </section>
  );
}
