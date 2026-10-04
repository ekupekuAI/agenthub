'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { Badge, OutcomeBadge, StatusBadge, VerifiedBadge } from '../../src/components/Badges';
import { type DashboardState, dashboardAction } from './actions';

export function DashboardView() {
  const [state, action, pending] = useActionState<DashboardState, FormData>(dashboardAction, {
    status: 'idle',
  });

  return (
    <div className="flex flex-col gap-8">
      <form
        action={action}
        className="flex max-w-xl flex-col gap-3 rounded-xl border border-line bg-canvas p-5 sm:flex-row sm:items-end"
      >
        <div className="flex flex-1 flex-col gap-1.5">
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
            className="w-full rounded-md border border-line bg-canvas px-3 py-2 font-mono text-ink"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent px-5 py-2 font-semibold text-accent-ink transition-colors hover:bg-accent-strong disabled:opacity-60"
        >
          {pending ? 'Loading…' : 'Show my skills'}
        </button>
      </form>

      <div aria-live="polite">
        {state.status === 'error' ? (
          <p
            role="alert"
            className="rounded-lg border border-bad-line bg-bad-bg p-4 text-sm text-bad-fg"
          >
            {state.message}
          </p>
        ) : null}
        {state.status === 'ready' ? (
          <section aria-labelledby="mine-heading">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="mine-heading" className="text-xl font-semibold">
                {state.publisher.name}
              </h2>
              <VerifiedBadge verified={state.publisher.verified} />
            </div>
            {state.skills.length === 0 ? (
              <p className="mt-4 text-muted">
                You have not published anything yet. <Link href="/publish">Publish a skill</Link>
              </p>
            ) : (
              <ul className="mt-4 grid gap-4">
                {state.skills.map((skill) => (
                  <li key={skill.slug} className="rounded-xl border border-line bg-canvas p-5">
                    <h3 className="font-semibold">
                      <Link href={`/skills/${skill.slug}`}>{skill.name}</Link>
                    </h3>
                    <div className="table-wrap mt-3">
                      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
                        <caption className="sr-only">Versions of {skill.name}</caption>
                        <thead>
                          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                            <th scope="col" className="py-2 pr-3 font-semibold">
                              Version
                            </th>
                            <th scope="col" className="py-2 pr-3 font-semibold">
                              Status
                            </th>
                            <th scope="col" className="py-2 pr-3 font-semibold">
                              Scan
                            </th>
                            <th scope="col" className="py-2 pr-3 font-semibold">
                              Findings
                            </th>
                            <th scope="col" className="py-2 font-semibold">
                              Published
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {skill.versions.map((v) => (
                            <tr key={v.version} className="border-b border-line align-top">
                              <td className="py-2 pr-3 font-mono">{v.version}</td>
                              <td className="py-2 pr-3">
                                <StatusBadge status={v.status} />
                                {v.statusReason ? (
                                  <p className="mt-1 text-xs text-muted">{v.statusReason}</p>
                                ) : null}
                              </td>
                              <td className="py-2 pr-3">
                                <OutcomeBadge outcome={v.outcome} />
                              </td>
                              <td className="py-2 pr-3">
                                <span className="flex flex-wrap gap-1">
                                  <Badge tone="bad">{v.counts.BLOCK} BLOCK</Badge>
                                  <Badge tone="warn">{v.counts.WARN} WARN</Badge>
                                  <Badge tone="info">{v.counts.INFO} INFO</Badge>
                                </span>
                              </td>
                              <td className="py-2">{v.createdAt.slice(0, 10)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </div>
  );
}
