import Link from 'next/link';
import type { ReactNode } from 'react';
import type { SkillInfo, SkillInfoVersion } from '../../lib/api-types';
import {
  Badge,
  ChevronRightIcon,
  Container,
  CopyCommand,
  Eyebrow,
  ShieldCheckIcon,
  StatusBadge,
  UserIcon,
  VerifiedMark,
} from '../ui';

export interface SkillMastheadProps {
  info: SkillInfo;
  shown: SkillInfoVersion | null;
  license?: string;
  /** The status banner, rendered full width under the title row when the version is not installable. */
  banner?: ReactNode;
}

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="eyebrow">{label}</dt>
      <dd className="m-0 flex min-h-6 min-w-0 flex-wrap items-center gap-2 text-small text-text">
        {children}
      </dd>
    </div>
  );
}

/**
 * Header of the skill page: breadcrumb, the skill name in mono, its summary, a meta ledger
 * (version, status, publisher, license) and the install command.
 */
export function SkillMasthead({ info, shown, license, banner }: SkillMastheadProps) {
  const installable = shown?.status === 'active';
  const categoryHref = info.category ? `/?category=${encodeURIComponent(info.category)}` : null;

  return (
    <header className="dot-grid border-border border-b">
      <Container className="pt-8 pb-10 sm:pt-10 sm:pb-12">
        <nav aria-label="Breadcrumb">
          <ol className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-muted text-small">
            <li>
              <Link href="/" className="text-muted no-underline hover:text-text">
                Skills
              </Link>
            </li>
            {info.category && categoryHref ? (
              <li className="flex items-center gap-1.5">
                <ChevronRightIcon size={14} className="text-subtle" />
                <Link href={categoryHref} className="text-muted no-underline hover:text-text">
                  {info.category}
                </Link>
              </li>
            ) : null}
            <li className="flex min-w-0 items-center gap-1.5">
              <ChevronRightIcon size={14} className="text-subtle" />
              <span aria-current="page" className="break-all font-mono text-text">
                {info.slug}
              </span>
            </li>
          </ol>
        </nav>

        <div
          className={
            installable
              ? 'mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-end lg:gap-12'
              : 'mt-8'
          }
        >
          <div className="min-w-0">
            <Eyebrow dot={installable}>{installable ? 'Skill · installable' : 'Skill'}</Eyebrow>
            <h1 className="mt-3 font-medium font-mono text-[clamp(1.85rem,5.2vw,3.3rem)] text-text leading-[1.05] tracking-[-0.035em] [overflow-wrap:anywhere]">
              {info.name}
            </h1>
            <p className="mt-4 max-w-2xl text-body text-muted text-pretty [overflow-wrap:anywhere]">
              {info.summary}
            </p>

            <dl className="m-0 mt-7 grid grid-cols-2 gap-x-8 gap-y-5 sm:flex sm:flex-wrap sm:gap-x-10">
              {shown ? (
                <MetaItem label="Version">
                  <span className="font-mono text-mono">v{shown.version}</span>
                  {shown.channel === 'beta' ? <Badge mono>beta</Badge> : null}
                </MetaItem>
              ) : null}
              {shown ? (
                <MetaItem label="Status">
                  <StatusBadge status={shown.status} />
                </MetaItem>
              ) : null}
              {info.publisher ? (
                <MetaItem label="Publisher">
                  <UserIcon size={15} className="text-subtle" />
                  <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                    {info.publisher.name}
                  </span>
                  {info.publisher.verified ? (
                    <VerifiedMark showLabel />
                  ) : (
                    <span className="text-[0.8125rem] text-subtle leading-5">Not verified</span>
                  )}
                </MetaItem>
              ) : null}
              {info.category && categoryHref ? (
                <MetaItem label="Category">
                  <Link
                    href={categoryHref}
                    className="rounded-chip border border-border-strong bg-surface-1 px-2 py-0.5 font-mono text-[0.8125rem] text-muted no-underline transition-colors duration-150 hover:border-subtle hover:text-text"
                  >
                    {info.category}
                  </Link>
                </MetaItem>
              ) : null}
              {license ? (
                <MetaItem label="License">
                  <span className="font-mono text-mono [overflow-wrap:anywhere]">{license}</span>
                </MetaItem>
              ) : null}
            </dl>
          </div>

          {installable ? (
            <div className="min-w-0 rounded-card border border-border bg-surface-1/80 p-4 shadow-panel backdrop-blur-sm sm:p-5">
              <p className="eyebrow mb-3 flex items-center gap-2">
                <ShieldCheckIcon size={14} className="text-signal-ink" />
                Install
              </p>
              <CopyCommand command={`agenthub install ${info.slug}`} />
              <p className="mt-3 text-[0.8125rem] text-muted leading-5">
                The CLI shows the install plan and every finding before it writes anything.{' '}
                <Link href="/guidelines#installing-safely" className="text-text">
                  Installing safely
                </Link>
              </p>
            </div>
          ) : null}
        </div>

        {banner ? <div className="mt-8">{banner}</div> : null}
      </Container>
    </header>
  );
}
