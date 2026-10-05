'use client';

import {
  type FormEvent,
  startTransition,
  useActionState,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  PublishIdle,
  PublishPending,
  PublishReceipt,
} from '../../src/components/publish/PublishResult';
import {
  MAX_RELEASE_NOTES,
  PACKAGE_ACCEPT,
  PUBLISH_FIELDS,
  type PublishFieldErrors,
  packageFileError,
  validatePublishForm,
} from '../../src/components/publish/package-rules';
import { TokenField } from '../../src/components/publish/TokenField';
import {
  ArrowRightIcon,
  Button,
  Callout,
  Dropzone,
  LockIcon,
  TextareaField,
  TextField,
} from '../../src/components/ui';
import { type PublishState, publishAction } from './actions';

const NUMBER = new Intl.NumberFormat('en-US');

export function PublishForm() {
  const [state, action, pending] = useActionState<PublishState, FormData>(publishAction, {
    status: 'idle',
  });
  const formRef = useRef<HTMLFormElement | null>(null);
  const resultHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const [clientErrors, setClientErrors] = useState<PublishFieldErrors>({});
  const [fileError, setFileError] = useState<string | undefined>();
  const [notesLength, setNotesLength] = useState(0);

  // The server's answer about one field shows under that field; anything else is a form alert.
  const serverError = state.status === 'error' && !pending ? state : undefined;
  const errors: PublishFieldErrors = {
    ...(serverError?.field ? { [serverError.field]: serverError.message } : {}),
    ...clientErrors,
  };
  if (fileError) errors.file = fileError;
  const formAlert = serverError && !serverError.field ? serverError.message : undefined;

  // Once the server answers, move focus to what needs attention.
  useEffect(() => {
    if (state.status === 'done') {
      formRef.current?.reset();
      setNotesLength(0);
      resultHeadingRef.current?.focus();
    } else if (state.status === 'error' && state.field) {
      document.getElementById(state.field)?.focus();
    }
  }, [state]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    // With JavaScript the form is sent from here, so a failed upload keeps what was entered.
    // Without it, the browser posts straight to the server action.
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const found = validatePublishForm(data);
    setClientErrors(found);
    setFileError(undefined);
    const first = PUBLISH_FIELDS.find((field) => found[field]);
    if (first) {
      document.getElementById(first)?.focus();
      return;
    }
    startTransition(() => action(data));
  }

  function onFileChange(file: File | null) {
    setClientErrors(({ file: _replaced, ...rest }) => rest);
    setFileError(file ? packageFileError(file) : undefined);
  }

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <form
        ref={formRef}
        action={action}
        onSubmit={onSubmit}
        noValidate
        aria-labelledby="publish-form-title"
        className="flex min-w-0 flex-col gap-6 rounded-panel border border-border bg-surface-1 p-5 shadow-panel sm:p-7"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Upload</p>
            <h2
              id="publish-form-title"
              className="mt-1.5 font-display text-[1.75rem] text-text leading-[1.15]"
            >
              New version
            </h2>
          </div>
          <p className="inline-flex items-center gap-1.5 rounded-chip border border-border bg-surface-2 px-2 py-1 font-mono text-[0.75rem] text-muted leading-4">
            <LockIcon size={13} />
            token never stored
          </p>
        </div>

        {formAlert ? (
          <Callout tone="danger" role="alert" title="The version was not published">
            {formAlert}
          </Callout>
        ) : null}

        <TokenField
          id="token"
          name="token"
          label="Publisher token"
          required
          disabled={pending}
          placeholder="ahp_…"
          error={errors.token}
          hint="Sent only with this upload. It is never stored in your browser."
        />

        <Dropzone
          id="file"
          name="file"
          label="Package (.skillpkg)"
          accept={PACKAGE_ACCEPT}
          required
          disabled={pending}
          error={errors.file}
          onFileChange={onFileChange}
          prompt={
            <>
              Drop a <span className="font-mono">.skillpkg</span> here, or{' '}
              <span className="text-signal-ink underline underline-offset-4">browse</span>
            </>
          }
          hint={
            <>
              Build it with <code>agenthub pack ./my-skill</code>. Up to 10 MiB.
            </>
          }
        />

        <div className="grid gap-6 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
          <TextField
            id="version"
            name="version"
            label="Version"
            optional
            mono
            disabled={pending}
            autoComplete="off"
            spellCheck={false}
            placeholder="1.2.0"
            maxLength={128}
            error={errors.version}
            hint="Only for a package without agenthub.yaml."
          />
          <TextareaField
            id="releaseNotes"
            name="releaseNotes"
            label="Release notes"
            optional
            rows={3}
            disabled={pending}
            error={errors.releaseNotes}
            onChange={(event) => setNotesLength(event.currentTarget.value.length)}
            hint={
              <span className={notesLength > MAX_RELEASE_NOTES ? 'text-block' : undefined}>
                Plain text, shown on the skill page. {NUMBER.format(notesLength)} /{' '}
                {NUMBER.format(MAX_RELEASE_NOTES)} characters
              </span>
            }
          />
        </div>

        <div className="flex flex-col-reverse gap-3 border-border border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[0.8125rem] text-muted leading-5">
            Published versions are immutable and scanned before they are listed.
          </p>
          <Button
            variant="primary"
            size="lg"
            type="submit"
            loading={pending}
            trailingIcon={pending ? undefined : <ArrowRightIcon />}
          >
            {pending ? 'Uploading and scanning…' : 'Publish version'}
          </Button>
        </div>
      </form>

      <div className="min-w-0">
        {pending ? (
          <PublishPending />
        ) : state.status === 'done' ? (
          <PublishReceipt summary={state.summary} headingRef={resultHeadingRef} />
        ) : (
          <PublishIdle />
        )}
      </div>
    </div>
  );
}
