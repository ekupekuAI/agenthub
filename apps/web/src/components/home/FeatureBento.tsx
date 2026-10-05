import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import {
  AGENT_META,
  type AgentId,
  Container,
  Eyebrow,
  FolderIcon,
  HashIcon,
  HistoryIcon,
  LayersIcon,
  LockIcon,
  ScanIcon,
  ShieldCheckIcon,
  SpotlightCard,
  Stagger,
  StaggerItem,
} from '../ui';

/* ------------------------------------------------------------------------------------ */
/* Shared pieces                                                                        */
/* ------------------------------------------------------------------------------------ */

const CODE = 'font-mono text-[0.78125rem] leading-5';

/** A framed artifact: a file-tab header and a mono body. */
function Artifact({
  name,
  meta,
  children,
  className,
}: {
  name: string;
  meta?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn('m-0 overflow-hidden rounded-control border border-border', className)}>
      <figcaption className="flex items-center justify-between gap-3 border-border border-b bg-surface-2 px-3 py-1.5 font-mono text-[0.71875rem] text-subtle leading-5">
        <span className="min-w-0 truncate">{name}</span>
        {meta ? <span className="shrink-0">{meta}</span> : null}
      </figcaption>
      <div className={cn('bg-bg/60 px-3 py-3', CODE)}>{children}</div>
    </figure>
  );
}

function Feature({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <SpotlightCard className="h-full">
      <div className="flex h-full flex-col">
        <span
          aria-hidden="true"
          className="inline-flex size-9 items-center justify-center rounded-control border border-border bg-surface-2 text-signal-ink"
        >
          {icon}
        </span>
        <h3 className="mt-4 font-semibold text-h3 text-text">{title}</h3>
        <p className="mt-2 max-w-[38rem] text-muted text-small">{body}</p>
        <div className="mt-5 flex flex-1 flex-col justify-end">{children}</div>
      </div>
    </SpotlightCard>
  );
}

const TAG_COLOR = { INFO: 'text-info', WARN: 'text-warn', BLOCK: 'text-block' } as const;

/* ------------------------------------------------------------------------------------ */
/* Artifacts                                                                            */
/* ------------------------------------------------------------------------------------ */

const FINDINGS: {
  tag: keyof typeof TAG_COLOR;
  rule: string;
  where: string;
  note: string;
}[] = [
  {
    tag: 'INFO',
    rule: 'exec.shell',
    where: 'scripts/run.sh:6',
    note: 'npx playwright test · declared',
  },
  {
    tag: 'WARN',
    rule: 'net.access',
    where: 'scripts/fetch.mjs:12',
    note: 'api.example.dev · undeclared',
  },
  {
    tag: 'BLOCK',
    rule: 'secrets.read',
    where: 'scripts/collect.mjs:6',
    note: '~/.aws/credentials · undeclared',
  },
];

function ScanArtifact() {
  return (
    <Artifact name="scan report" meta="12 rules · 3 findings">
      <ul className="m-0 grid list-none gap-2.5 p-0">
        {FINDINGS.map((f) => (
          <li
            key={`${f.rule}:${f.where}`}
            className="grid grid-cols-[5.5ch_minmax(0,1fr)] gap-x-[1ch] sm:grid-cols-[5.5ch_13ch_minmax(0,1fr)_minmax(0,1.2fr)]"
          >
            <span className={cn('font-medium', TAG_COLOR[f.tag])}>{f.tag}</span>
            <span className="text-text">{f.rule}</span>
            <span className="col-start-2 text-muted [overflow-wrap:anywhere] sm:col-start-auto">
              {f.where}
            </span>
            <span className="col-start-2 text-subtle [overflow-wrap:anywhere] sm:col-start-auto">
              {f.note}
            </span>
          </li>
        ))}
      </ul>
    </Artifact>
  );
}

function Yaml({ k, children, indent = 0 }: { k: string; children?: ReactNode; indent?: number }) {
  return (
    <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      {'  '.repeat(indent)}
      <span className="text-muted">{k}:</span>
      {children ? <span className="text-text"> {children}</span> : null}
    </div>
  );
}

const CHECKS: { ok: boolean; kind: string; subject: string; result: string }[] = [
  { ok: true, kind: 'exec', subject: 'npx', result: 'declared' },
  { ok: true, kind: 'env', subject: 'PLAYWRIGHT_BROWSERS_PATH', result: 'declared' },
  { ok: false, kind: 'read', subject: '~/.aws/credentials', result: 'undeclared · BLOCK' },
];

function PermissionsArtifact() {
  return (
    <div className="grid gap-3">
      <Artifact name="agenthub.yaml" meta="web-testing">
        <Yaml k="version">1.3.0</Yaml>
        <Yaml k="requires" />
        <Yaml k="runtimes" indent={1}>
          {'{ node: ">=22" }'}
        </Yaml>
        <Yaml k="permissions" />
        <Yaml k="network" indent={1}>
          true
        </Yaml>
        <Yaml k="exec" indent={1}>
          [npx, node]
        </Yaml>
        <Yaml k="env" indent={1}>
          [PLAYWRIGHT_BROWSERS_PATH]
        </Yaml>
      </Artifact>
      <Artifact name="checked against the code">
        <ul className="m-0 grid list-none gap-1.5 p-0">
          {CHECKS.map((c) => (
            <li key={c.subject} className="grid grid-cols-[2ch_5ch_minmax(0,1fr)] gap-x-[1ch]">
              <span aria-hidden="true" className={c.ok ? 'text-signal-ink' : 'text-block'}>
                {c.ok ? '✓' : '✕'}
              </span>
              <span className="text-subtle">{c.kind}</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <span className="text-text">{c.subject}</span>{' '}
                <span className={c.ok ? 'text-muted' : 'text-block'}>{c.result}</span>
              </span>
            </li>
          ))}
        </ul>
      </Artifact>
    </div>
  );
}

const TIMELINE: { version: string; action: string; note: string; current?: boolean }[] = [
  { version: '1.0.0', action: 'install', note: '4 agents · verified' },
  { version: '1.1.0', action: 'update', note: 'snapshot saved · 2 folders swapped' },
  { version: '1.0.0', action: 'rollback', note: 'restored from snapshot', current: true },
];

function RollbackArtifact() {
  return (
    <Artifact name="web-testing history">
      <ol className="relative m-0 grid list-none gap-3 p-0 pl-5">
        <span
          aria-hidden="true"
          className="absolute top-1.5 bottom-1.5 left-[0.3125rem] w-px bg-border-strong"
        />
        {TIMELINE.map((t) => (
          <li key={`${t.action}:${t.version}`} className="relative">
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-1.5 -left-5 size-2.5 rounded-full border',
                t.current ? 'border-signal-ink bg-signal' : 'border-border-strong bg-surface-2',
              )}
            />
            <span className="text-text">{t.action}</span>{' '}
            <span className={t.current ? 'text-signal-ink' : 'text-muted'}>{t.version}</span>
            {t.current ? <span className="sr-only"> (current)</span> : null}
            <span className="block text-subtle">{t.note}</span>
          </li>
        ))}
      </ol>
    </Artifact>
  );
}

function Json({ children, indent = 0 }: { children: ReactNode; indent?: number }) {
  return (
    <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      {'  '.repeat(indent)}
      {children}
    </div>
  );
}

function Key({ children }: { children: string }) {
  return <span className="text-muted">&quot;{children}&quot;</span>;
}

function Str({ children }: { children: string }) {
  return <span className="text-text">&quot;{children}&quot;</span>;
}

function LockfileArtifact() {
  return (
    <Artifact name="agenthub.lock" meta="lockfileVersion 1">
      <Json>
        <Key>web-testing</Key>
        {': {'}
      </Json>
      <Json indent={1}>
        <Key>version</Key>: <Str>1.3.0</Str>,
      </Json>
      <Json indent={1}>
        <Key>digest</Key>: <Str>sha256:e22530ce451e…</Str>,
      </Json>
      <Json indent={1}>
        <Key>files</Key>
        {': {'}
      </Json>
      <Json indent={2}>
        <Key>SKILL.md</Key>: <Str>sha256:4f0c9a17…</Str>,
      </Json>
      <Json indent={2}>
        <Key>scripts/run.sh</Key>: <Str>sha256:b81d2e60…</Str>
      </Json>
      <Json indent={1}>{'}'}</Json>
      <Json>{'}'}</Json>
    </Artifact>
  );
}

const FOLDERS: { dir: string; readers: AgentId[] }[] = [
  { dir: '.agents/skills/web-testing', readers: ['codex', 'cursor', 'vscode'] },
  { dir: '.claude/skills/web-testing', readers: ['claude-code', 'cursor', 'vscode'] },
];

function FoldersArtifact() {
  return (
    <Artifact name="project">
      <ul className="m-0 grid list-none gap-3 p-0">
        {FOLDERS.map((f) => (
          <li key={f.dir}>
            <span className="flex items-center gap-2 text-text">
              <FolderIcon size={14} className="shrink-0 text-subtle" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{f.dir}</span>
            </span>
            <span className="mt-1.5 flex flex-wrap gap-1.5 pl-[22px]">
              <span className="sr-only">read by </span>
              {f.readers.map((id) => (
                <span
                  key={id}
                  title={AGENT_META[id].name}
                  className="inline-flex h-6 items-center rounded-sm border border-signal-line bg-signal-tint px-1.5 text-[0.6875rem] text-signal-ink tracking-[0.04em]"
                >
                  <span aria-hidden="true">{AGENT_META[id].monogram}</span>
                  <span className="sr-only">{AGENT_META[id].name}, </span>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Artifact>
  );
}

function ImmutableArtifact() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Artifact name="registry storage" meta="content-addressed">
        <div className="text-subtle">publish web-testing 1.3.0</div>
        <div className="mt-1 [overflow-wrap:anywhere]">
          <span className="text-signal-ink">stored</span>{' '}
          <span className="text-text">sha256/9c41d07be2a8….skillpkg</span>
        </div>
        <div className="mt-3 text-subtle">install web-testing 1.3.0</div>
        <div className="mt-1 [overflow-wrap:anywhere]">
          <span className="text-signal-ink">match</span>{' '}
          <span className="text-text">sha256:e22530ce451e…</span>
        </div>
      </Artifact>
      <Artifact name="publish again" meta="409">
        <div className="text-subtle">publish web-testing 1.3.0</div>
        <div className="mt-1 [overflow-wrap:anywhere]">
          <span className="text-block">CONFLICT</span>{' '}
          <span className="text-text">
            web-testing@1.3.0 already exists. Versions are immutable; publish a new version.
          </span>
        </div>
      </Artifact>
    </div>
  );
}

/* ------------------------------------------------------------------------------------ */
/* Section                                                                              */
/* ------------------------------------------------------------------------------------ */

/** Six spotlight cards in an asymmetric grid, each carrying a real artifact. */
export function FeatureBento() {
  return (
    <section aria-labelledby="features-heading" className="border-border border-t py-14 lg:py-24">
      <Container>
        <div className="max-w-2xl">
          <Eyebrow className="mb-3">Trust layer</Eyebrow>
          <h2 id="features-heading" className="display-2 text-text">
            Every claim comes with a <em className="text-signal-ink italic">receipt</em>.
          </h2>
          <p className="mt-4 text-body text-muted">
            agenthub never asks you to take a skill on faith. Each guarantee below leaves an
            artifact you can open and check.
          </p>
        </div>

        <Stagger
          as="ul"
          className="m-0 mt-12 grid list-none gap-4 p-0 md:grid-cols-2 lg:grid-cols-6"
        >
          <StaggerItem as="li" className="min-w-0 md:col-span-2 lg:col-span-4">
            <Feature
              icon={<ScanIcon size={18} />}
              title="Scanned before it lands"
              body="Twelve rules read every file on upload and again on install: shell calls, network access, secrets, hidden prompts, obfuscated code and binaries."
            >
              <ScanArtifact />
            </Feature>
          </StaggerItem>
          <StaggerItem as="li" className="min-w-0 lg:col-span-2 lg:row-span-2">
            <Feature
              icon={<ShieldCheckIcon size={18} />}
              title="Declared, then enforced"
              body="A skill lists the commands, hosts, variables and secrets it needs. Anything it uses without declaring is raised, and undeclared secrets block the install."
            >
              <PermissionsArtifact />
            </Feature>
          </StaggerItem>
          <StaggerItem as="li" className="min-w-0 lg:col-span-2">
            <Feature
              icon={<HistoryIcon size={18} />}
              title="Every update is reversible"
              body="Updates snapshot the old folders and swap atomically. One command puts the previous version back."
            >
              <RollbackArtifact />
            </Feature>
          </StaggerItem>
          <StaggerItem as="li" className="min-w-0 lg:col-span-2">
            <Feature
              icon={<LockIcon size={18} />}
              title="A lockfile that proves it"
              body="The lock records the version, its digest and a hash for every file. agenthub verify reports anything modified, missing or extra."
            >
              <LockfileArtifact />
            </Feature>
          </StaggerItem>
          <StaggerItem as="li" className="min-w-0 lg:col-span-2">
            <Feature
              icon={<LayersIcon size={18} />}
              title="Four agents, two folders"
              body="Claude Code reads .claude/skills, Codex reads .agents/skills, Cursor and VS Code read both. agenthub writes the fewest folders that reach yours."
            >
              <FoldersArtifact />
            </Feature>
          </StaggerItem>
          <StaggerItem as="li" className="min-w-0 md:col-span-2 lg:col-span-4">
            <Feature
              icon={<HashIcon size={18} />}
              title="Immutable releases"
              body="A published version is stored under its SHA-256 digest and never overwritten. Revoked versions stay on record and can no longer be installed."
            >
              <ImmutableArtifact />
            </Feature>
          </StaggerItem>
        </Stagger>
      </Container>
    </section>
  );
}
