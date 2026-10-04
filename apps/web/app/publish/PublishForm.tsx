'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { DecisionBadge, OutcomeBadge, StatusBadge } from '../../src/components/Badges';
import { findingKey, keyed } from '../../src/lib/keys';
import { type PublishState, publishAction } from './actions';

const input =
  'w-full rounded-md border border-line bg-canvas px-3 py-2 text-ink placeholder:text-muted';

export function PublishForm() {
  const [state, action, pending] = useActionState<PublishState, FormData>(publishAction, {
    status: 'idle',
  });

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form
        action={action}
        className="flex flex-col gap-5 rounded-xl border border-line bg-canvas p-5"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="token" className="text-sm font-semibold">
            Publisher token
          </label>
          <input
            id="token"
            name="token"
            type="password"
            required
            autoComplete="off"
            spellCheck={false}
            className={`${input} font-mono`}
            aria-describedby="token-help"
          />
          <p id="token-help" className="text-xs text-muted">
            Sent only with this upload. It is never stored in your browser.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="file" className="text-sm font-semibold">
            Package (.skillpkg)
          </label>
          <input
            id="file"
            name="file"
            type="file"
            required
            accept=".skillpkg,application/gzip,application/octet-stream"
            className="text-sm file:mr-3 file:rounded-md file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-ink"
            aria-describedby="file-help"
          />
          <p id="file-help" className="text-xs text-muted">
            Create it with <code>agenthub pack ./my-skill</code>. Limit: 10 MiB.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="releaseNotes" className="text-sm font-semibold">
            Release notes <span className="font-normal text-muted">(optional)</span>
          </label>
          <textarea
            id="releaseNotes"
            name="releaseNotes"
            rows={4}
            maxLength={5000}
            className={input}
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md bg-accent px-5 py-2 font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:opacity-60"
        >
          {pending ? 'Uploading and scanning…' : 'Publish version'}
        </button>
      </form>

      <section aria-labelledby="result-heading" aria-live="polite" className="min-w-0">
        <h2 id="result-heading" className="text-base font-semibold">
          Result
        </h2>
        {state.status === 'idle' ? (
          <p className="mt-3 rounded-lg border border-dashed border-line p-5 text-sm text-muted">
            The scan result appears here after you publish.
          </p>
        ) : null}
        {state.status === 'error' ? (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-bad-line bg-bad-bg p-4 text-sm text-bad-fg"
          >
            {state.message}
          </div>
        ) : null}
        {state.status === 'done' ? (
          <div className="mt-3 flex flex-col gap-4 rounded-xl border border-line bg-canvas p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">
                {state.summary.slug}@{state.summary.version}
              </span>
              <StatusBadge status={state.summary.status} />
              <OutcomeBadge outcome={state.summary.outcome} />
            </div>
            {state.summary.status === 'quarantined' ? (
              <p className="rounded-md border border-warn-line bg-warn-bg p-3 text-sm text-warn-fg">
                The scanner blocked this upload, so it is quarantined. Nobody can install it until a
                moderator reviews it. Fix the findings below and publish a new version.
              </p>
            ) : (
              <p className="text-sm">
                Published. <Link href={`/skills/${state.summary.slug}`}>View the skill page</Link>
              </p>
            )}
            <dl className="grid gap-2 text-xs">
              <div>
                <dt className="text-muted">Content digest</dt>
                <dd className="break-all font-mono">{state.summary.digest}</dd>
              </div>
              <div>
                <dt className="text-muted">Archive digest</dt>
                <dd className="break-all font-mono">{state.summary.archiveDigest}</dd>
              </div>
              <div>
                <dt className="text-muted">Scanner</dt>
                <dd className="font-mono">{state.summary.scannerVersion}</dd>
              </div>
            </dl>
            {state.summary.findings.length > 0 ? (
              <ul className="grid gap-2">
                {keyed(state.summary.findings, findingKey).map(({ item: f, key }) => (
                  <li key={key} className="rounded-md border border-line p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <DecisionBadge decision={f.decision} />
                      <span className="font-mono text-xs">{f.ruleId}</span>
                      <span className="font-mono text-xs text-muted">
                        {f.file}
                        {f.line > 0 ? `:${f.line}` : ''}
                      </span>
                      <span className="text-xs text-muted">
                        {f.declared ? 'declared' : 'undeclared'}
                      </span>
                    </div>
                    <p className="mt-1">{f.message}</p>
                    <code className="mt-1 block break-all text-xs">{f.evidence}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No findings.</p>
            )}
            {state.summary.warnings.length > 0 ? (
              <div>
                <h3 className="text-sm font-semibold">Validation warnings</h3>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {state.summary.warnings.map((w) => (
                    <li key={`${w.code}-${w.path ?? ''}`}>{w.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
