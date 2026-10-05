'use client';

import { useActionState, useEffect } from 'react';
import { useFormStatus } from 'react-dom';
import { resetAdminTab } from '../../src/components/admin/AdminTabs';
import {
  ArrowRightIcon,
  Button,
  Callout,
  Checkbox,
  CopyCommand,
  PlusIcon,
  TextField,
} from '../../src/components/ui';
import {
  type CreatePublisherState,
  createPublisherAction,
  type LoginState,
  loginAction,
  logoutAction,
} from './actions';

const TOKEN_FIELD_ID = 'admin-token';

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});

  // The form clears itself after a failed attempt; put the caret back in the token field.
  useEffect(() => {
    if (state.error) document.getElementById(TOKEN_FIELD_ID)?.focus();
  }, [state]);

  return (
    <form action={action} className="grid gap-5">
      <TextField
        id={TOKEN_FIELD_ID}
        name="token"
        label="Admin token"
        type="password"
        mono
        required
        autoComplete="current-password"
        autoCapitalize="none"
        spellCheck={false}
        error={state.error}
        hint="The value this server was started with."
      />
      <Button
        type="submit"
        variant="primary"
        size="lg"
        fullWidth
        loading={pending}
        trailingIcon={<ArrowRightIcon size={16} />}
      >
        Sign in
      </Button>
    </form>
  );
}

function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" loading={pending}>
      Sign out
    </Button>
  );
}

export function SignOutForm() {
  return (
    <form action={logoutAction} onSubmit={resetAdminTab}>
      <SignOutButton />
    </form>
  );
}

export function CreatePublisherForm() {
  const [state, action, pending] = useActionState<CreatePublisherState, FormData>(
    createPublisherAction,
    { status: 'idle' },
  );
  return (
    <div className="grid gap-5">
      <form action={action} className="grid gap-5">
        <TextField
          id="displayName"
          name="displayName"
          label="Display name"
          required
          minLength={2}
          maxLength={64}
          autoComplete="off"
          hint="2 to 64 characters, starting with a letter or digit: letters, digits, spaces, dots, dashes and underscores. It appears on every skill this publisher uploads."
        />
        <div>
          <Checkbox
            id="verified"
            name="verified"
            label="Verified identity"
            aria-describedby="verified-hint"
          />
          <p id="verified-hint" className="text-[0.8125rem] text-muted leading-5 sm:pl-7">
            Tick this only after you have confirmed who the publisher is. Their skills then carry
            the verified seal.
          </p>
        </div>
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            leadingIcon={<PlusIcon size={15} />}
          >
            Create publisher
          </Button>
        </div>
      </form>

      <div aria-live="polite">
        {state.status === 'error' ? (
          <Callout tone="danger" role="alert" title="Publisher not created">
            {state.message}
          </Callout>
        ) : null}
        {state.status === 'created' ? (
          <Callout
            tone="warning"
            title={
              <>
                Publisher “{state.displayName}” created{state.verified ? ' (verified)' : ''}. Copy
                the token now
              </>
            }
          >
            <p>
              It is shown only once and cannot be recovered: the registry keeps only a hash of it.
            </p>
            <CopyCommand
              command={state.token}
              prompt={false}
              label="New publisher token"
              className="mt-3"
            />
          </Callout>
        ) : null}
      </div>
    </div>
  );
}
