import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  Badge,
  DecisionBadge,
  OutcomeBadge,
  StatusBadge,
  VerifiedBadge,
} from '../../../src/components/Badges';
import { CopyCommand } from '../../../src/components/CopyCommand';
import { SafeMarkdown } from '../../../src/components/SafeMarkdown';
import type { SkillInfoVersion } from '../../../src/lib/api-types';
import { isApiError } from '../../../src/lib/errors';
import { findingKey, keyed } from '../../../src/lib/keys';
import { getRegistry, type SkillDetail } from '../../../src/lib/registry';
import { AGENT_LABELS, AGENTS, SLUG_RE } from '../../../src/lib/validation';

type Params = Promise<{ slug: string }>;

async function load(slug: string): Promise<SkillDetail | null> {
  if (!SLUG_RE.test(slug) || slug.length > 64) return null;
  try {
    return await (await getRegistry()).getSkill(slug);
  } catch (error) {
    if (isApiError(error) && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const detail = await load(slug);
  if (!detail) return { title: 'Skill not found' };
  return {
    title: detail.info.name,
    description: detail.info.summary.slice(0, 200),
  };
}

function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12);
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-xl border border-line bg-canvas p-5">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Permissions({ version }: { version: SkillInfoVersion }) {
  const p = version.permissions ?? {};
  const network =
    p.network === true
      ? 'Any host'
      : Array.isArray(p.network) && p.network.length
        ? p.network.join(', ')
        : null;
  const rows: [string, string | null][] = [
    ['Network', network],
    ['Commands it may run', p.exec?.length ? p.exec.join(', ') : null],
    ['Environment variables', p.env?.length ? p.env.join(', ') : null],
    ['Secrets', p.secrets?.length ? p.secrets.join(', ') : null],
    ['File writes', p.fs?.write?.length ? p.fs.write.join(', ') : null],
  ];
  return (
    <dl className="grid gap-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-wrap justify-between gap-x-4">
          <dt className="text-muted">{label}</dt>
          <dd className={value ? 'font-mono text-ink' : 'text-muted'}>
            {value ?? 'None declared'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default async function SkillPage({ params }: { params: Params }) {
  const { slug } = await params;
  const detail = await load(slug);
  if (!detail) notFound();

  const { info, shown } = detail;
  const findings = shown?.scan?.findings ?? [];
  const counts = { INFO: 0, WARN: 0, BLOCK: 0 };
  for (const f of findings) counts[f.decision] += 1;
  const installable = shown?.status === 'active';

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/">Search</Link> <span aria-hidden="true">/</span>{' '}
        <span aria-current="page">{info.slug}</span>
      </nav>

      <header className="mt-4 flex flex-col gap-4 border-b border-line pb-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="break-words text-3xl font-bold tracking-tight">{info.name}</h1>
            {shown ? <span className="font-mono text-lg text-muted">v{shown.version}</span> : null}
            {shown ? <StatusBadge status={shown.status} /> : null}
          </div>
          <p className="mt-2 max-w-3xl text-muted">{info.summary}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            {info.publisher ? (
              <>
                <span>
                  Published by <strong>{info.publisher.name}</strong>
                </span>
                <VerifiedBadge verified={info.publisher.verified} />
              </>
            ) : null}
            {info.category ? (
              <Link
                href={`/?category=${encodeURIComponent(info.category)}`}
                className="rounded-full border border-line px-2 py-0.5 text-xs no-underline"
              >
                {info.category}
              </Link>
            ) : null}
            {detail.license ? <Badge tone="neutral">License: {detail.license}</Badge> : null}
          </div>
        </div>
        <div className="w-full shrink-0 lg:w-[26rem]">
          {installable ? (
            <>
              <p className="mb-1.5 text-sm font-semibold">Install</p>
              <CopyCommand command={`agenthub install ${info.slug}`} />
              <p className="mt-2 text-xs text-muted">
                The CLI shows the install plan and every finding before it writes anything.{' '}
                <Link href="/guidelines#installing-safely">Installing safely</Link>
              </p>
            </>
          ) : (
            <div
              role="alert"
              className="rounded-lg border border-warn-line bg-warn-bg p-3 text-sm text-warn-fg"
            >
              <p className="font-semibold">
                {shown?.status === 'revoked'
                  ? 'This version has been revoked.'
                  : 'This version is quarantined and cannot be installed.'}
              </p>
              {detail.statusReason ? <p className="mt-1">Reason: {detail.statusReason}</p> : null}
            </div>
          )}
        </div>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <section
            aria-labelledby="trust-heading"
            className="rounded-xl border border-line bg-canvas p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="trust-heading" className="text-base font-semibold">
                Trust evidence
              </h2>
              <OutcomeBadge outcome={shown?.scan?.outcome} />
            </div>
            {shown ? (
              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-muted">Content digest</dt>
                  <dd className="break-all font-mono text-xs">{shown.digest}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted">Archive digest</dt>
                  <dd className="break-all font-mono text-xs">{shown.archiveDigest}</dd>
                </div>
                <div>
                  <dt className="text-muted">Scanner</dt>
                  <dd>
                    {shown.scan ? (
                      <>
                        <span className="font-mono">{shown.scan.scannerVersion}</span> · scanned{' '}
                        {formatDate(shown.scan.scannedAt)}
                      </>
                    ) : (
                      'Not scanned'
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Findings</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    <Badge tone="bad">{counts.BLOCK} BLOCK</Badge>
                    <Badge tone="warn">{counts.WARN} WARN</Badge>
                    <Badge tone="info">{counts.INFO} INFO</Badge>
                  </dd>
                </div>
              </dl>
            ) : null}

            {findings.length === 0 ? (
              <p className="mt-4 text-sm text-muted">
                The scanner reported no findings for this version. That is evidence, not a
                guarantee: read the files you install.
              </p>
            ) : (
              <div className="table-wrap mt-4">
                <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
                  <caption className="sr-only">Scanner findings for this version</caption>
                  <thead>
                    <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                      <th scope="col" className="py-2 pr-3 font-semibold">
                        Decision
                      </th>
                      <th scope="col" className="py-2 pr-3 font-semibold">
                        Rule
                      </th>
                      <th scope="col" className="py-2 pr-3 font-semibold">
                        Location
                      </th>
                      <th scope="col" className="py-2 pr-3 font-semibold">
                        Evidence
                      </th>
                      <th scope="col" className="py-2 font-semibold">
                        Declared
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {keyed(findings, findingKey).map(({ item: f, key }) => (
                      <tr key={key} className="border-b border-line align-top">
                        <td className="py-2 pr-3">
                          <DecisionBadge decision={f.decision} />
                        </td>
                        <td className="py-2 pr-3">
                          <span className="font-mono text-xs">{f.ruleId}</span>
                          <p className="mt-0.5 text-xs text-muted">{f.message}</p>
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs break-all">
                          {f.file}
                          {f.line > 0 ? `:${f.line}` : ''}
                        </td>
                        <td className="py-2 pr-3">
                          <code className="text-xs break-all">{f.evidence}</code>
                        </td>
                        <td className="py-2">{f.declared ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section
            aria-labelledby="readme-heading"
            className="rounded-xl border border-line bg-canvas p-5"
          >
            <h2 id="readme-heading" className="text-base font-semibold">
              SKILL.md
            </h2>
            <p className="mt-1 text-xs text-muted">
              Shown as plain text. Nothing in a skill is ever rendered as HTML here.
            </p>
            <div className="mt-4 border-t border-line pt-2">
              {detail.readme.trim() ? (
                <SafeMarkdown source={detail.readme} />
              ) : (
                <p className="text-muted">This skill has no body text.</p>
              )}
            </div>
          </section>

          {shown?.releaseNotes ? (
            <Section id="notes-heading" title={`Release notes for v${shown.version}`}>
              <p className="whitespace-pre-wrap text-sm">{shown.releaseNotes}</p>
            </Section>
          ) : null}

          <section
            aria-labelledby="versions-heading"
            className="rounded-xl border border-line bg-canvas p-5"
          >
            <h2 id="versions-heading" className="text-base font-semibold">
              Versions
            </h2>
            <div className="table-wrap mt-3">
              <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
                <caption className="sr-only">All published versions</caption>
                <thead>
                  <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Version
                    </th>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Status
                    </th>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Channel
                    </th>
                    <th scope="col" className="py-2 pr-3 font-semibold">
                      Published
                    </th>
                    <th scope="col" className="py-2 font-semibold">
                      Digest
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {info.versions.map((v) => (
                    <tr
                      key={v.version}
                      className={`border-b border-line align-top ${v.status !== 'active' ? 'text-muted' : ''}`}
                    >
                      <td className="py-2 pr-3 font-mono">
                        {v.status === 'revoked' ? <s>{v.version}</s> : v.version}
                      </td>
                      <td className="py-2 pr-3">
                        <StatusBadge status={v.status} />
                        {v.revokedReason ? (
                          <p className="mt-1 text-xs">Reason: {v.revokedReason}</p>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">{v.channel}</td>
                      <td className="py-2 pr-3">{formatDate(v.createdAt)}</td>
                      <td className="py-2 font-mono text-xs" title={v.digest}>
                        {shortDigest(v.digest)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="flex flex-col gap-6" aria-label="Compatibility and requirements">
          <Section id="compat-heading" title="Compatibility">
            <table className="w-full border-collapse text-left text-sm">
              <caption className="sr-only">Supported agents and install mode</caption>
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
                  <th scope="col" className="py-1.5 pr-2 font-semibold">
                    Agent
                  </th>
                  <th scope="col" className="py-1.5 pr-2 font-semibold">
                    Supported
                  </th>
                  <th scope="col" className="py-1.5 font-semibold">
                    Mode
                  </th>
                </tr>
              </thead>
              <tbody>
                {AGENTS.map((agent) => {
                  const ok = shown?.agents?.includes(agent) ?? false;
                  return (
                    <tr key={agent} className="border-b border-line last:border-0">
                      <th scope="row" className="py-1.5 pr-2 font-medium">
                        {AGENT_LABELS[agent]}
                      </th>
                      <td className="py-1.5 pr-2">
                        {ok ? (
                          <span className="font-semibold text-ok-fg">
                            <span aria-hidden="true">✓ </span>Yes
                          </span>
                        ) : (
                          <span className="text-muted">
                            <span aria-hidden="true">– </span>No
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-muted">{ok ? 'native' : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {detail.compatibility ? (
              <p className="mt-3 text-xs text-muted">Author note: {detail.compatibility}</p>
            ) : null}
          </Section>

          <Section id="perm-heading" title="Declared permissions">
            {shown ? <Permissions version={shown} /> : null}
            <p className="mt-3 text-xs text-muted">
              Declared behavior downgrades matching findings; undeclared behavior is flagged.
            </p>
          </Section>

          <Section id="req-heading" title="Requirements">
            {shown?.requirements?.length ? (
              <ul className="grid gap-1.5 text-sm">
                {shown.requirements.map((r) => (
                  <li key={`${r.kind}-${r.name}`} className="flex justify-between gap-3">
                    <span>
                      <span className="text-muted">{r.kind}</span>{' '}
                      <span className="font-mono">{r.name}</span>
                    </span>
                    {r.constraint ? (
                      <span className="font-mono text-muted">{r.constraint}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No runtime, command or MCP requirements.</p>
            )}
          </Section>

          <Section id="files-heading" title={`Files (${detail.files.length})`}>
            <ul className="grid gap-1 text-xs">
              {detail.files.map((f) => (
                <li key={f.path} className="flex justify-between gap-3">
                  <span className="break-all font-mono">{f.path}</span>
                  <span className="shrink-0 text-muted">{f.size.toLocaleString('en-US')} B</span>
                </li>
              ))}
            </ul>
          </Section>
        </aside>
      </div>
    </div>
  );
}
