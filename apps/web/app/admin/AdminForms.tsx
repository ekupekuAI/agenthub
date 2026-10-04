'use client';

import { useActionState } from 'react';
import {
  type CreatePublisherState,
  createPublisherAction,
  type LoginState,
  loginAction,
} from './actions';

const input = 'w-full rounded-md border border-line bg-canvas px-3 py-2 text-ink';
const primary =
  'rounded-md bg-accent px-4 py-2 font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:opacity-60';

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form
      action={action}
      className="flex max-w-md flex-col gap-3 rounded-xl border border-line bg-canvas p-5"
    >
      <label htmlFor="admin-token" className="text-sm font-semibold">
        Admin token
      </label>
      <input
        id="admin-token"
        name="token"
        type="password"
        required
        autoComplete="current-password"
        className={`${input} font-mono`}
      />
      {state.error ? (
        <p role="alert" className="text-sm text-bad-fg">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className={`${primary} self-start`}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}

export function CreatePublisherForm() {
  const [state, action, pending] = useActionState<CreatePublisherState, FormData>(
    createPublisherAction,
    { status: 'idle' },
  );
  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="displayName" className="text-sm font-semibold">
            Display name
          </label>
          <input
            id="displayName"
            name="displayName"
            required
            minLength={2}
            maxLength={64}
            className={input}
          />
        </div>
        <label className="flex items-center gap-2 text-sm sm:pb-2">
          <input type="checkbox" name="verified" className="h-4 w-4" />
          Verified identity
        </label>
        <button type="submit" disabled={pending} className={primary}>
          {pending ? 'Creating…' : 'Create publisher'}
        </button>
      </form>
      <div aria-live="polite">
        {state.status === 'error' ? (
          <p role="alert" className="text-sm text-bad-fg">
            {state.message}
          </p>
        ) : null}
        {state.status === 'created' ? (
          <div className="rounded-lg border border-warn-line bg-warn-bg p-4 text-sm text-warn-fg">
            <p className="font-semibold">
              Publisher “{state.displayName}” created
              {state.verified ? ' (verified)' : ''}. Copy the token now: it is shown only once and
              cannot be recovered.
            </p>
            <code className="mt-2 block break-all rounded-md border border-line bg-canvas p-2 text-ink">
              {state.token}
            </code>
          </div>
        ) : null}
      </div>
    </div>
  );
}
