import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AgentFolders } from '../../src/components/guidelines/AgentFolders';
import { CodeFile, CommandList, ExitCodes, Prose } from '../../src/components/guidelines/DocBlocks';
import { DocSectionHeading, DocSubheading } from '../../src/components/guidelines/DocHeading';
import {
  DecisionLegend,
  PolicyTable,
  RulesTable,
  SCANNER_RULE_COUNT,
} from '../../src/components/guidelines/PolicyTables';
import { ReportCard, SecurityContact } from '../../src/components/guidelines/ReportCard';
import { TocMobile } from '../../src/components/guidelines/TocMobile';
import { TocNav } from '../../src/components/guidelines/TocNav';
import { type SectionId, TOC } from '../../src/components/guidelines/toc';
import {
  ArrowUpIcon,
  Callout,
  Container,
  PageHeader,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '../../src/components/ui';
import { securityContact } from '../../src/config';

export const metadata: Metadata = {
  title: 'Guidelines',
  description:
    'How to install agent skills safely, write and publish a safe skill, how the registry security model works, and how to report a malicious skill.',
};

/** One numbered section of the page, separated from the previous one by a hairline. */
function DocSection({ id, children }: { id: SectionId; children: ReactNode }) {
  return (
    <section
      aria-labelledby={id}
      className="mt-16 border-border border-t pt-12 first:mt-0 first:border-t-0 first:pt-0 sm:mt-20 sm:pt-14"
    >
      <DocSectionHeading id={id} />
      {children}
    </section>
  );
}

const SKILL_MD = `---
name: changelog-writer
description: Draft a changelog entry from merged changes. Use when preparing a release.
license: MIT
metadata:
  category: docs
  tags: changelog release notes
---

# Changelog writer

1. Collect the changes since the last tag ...`;

const AGENTHUB_YAML = `schema: 1
version: 1.2.0
targets: [claude-code, codex, cursor, vscode]   # optional; default is all four
requires:
  runtimes: { node: ">=22" }
  commands: [git, npx]
permissions:
  network: [registry.npmjs.org]   # true, false, or a list of hosts
  exec: [npx, git]                # programs your scripts run
  env: [CI]                       # environment variables you read
  secrets: []                     # credential files or variables you read (avoid)
  fs: { write: [project, temp] }  # project | home | temp
channel: stable                   # stable | beta`;

const COMMANDS: readonly [string, string][] = [
  ['doctor', 'Health report for agents, folders and installs. Changes nothing.'],
  ['search <query>', 'Search the registry; filter with --agent and --category.'],
  ['info <skill>', 'Versions, trust evidence, requirements and permissions.'],
  ['install [target]', 'Install a skill. With no target, restore everything in the lockfile.'],
  ['list', 'Installed skills and their status.'],
  ['verify [skill]', 'Re-hash installed files and compare them with the lockfile.'],
  ['update --check', 'What is available. Never writes.'],
  ['update <skill>', 'Show the plan, confirm, update one skill.'],
  ['update --safe', 'Update everything that passes every check.'],
  ['rollback <skill>', 'Restore the previous snapshot.'],
  ['remove <skill>', 'Remove an installed skill. Your own files are kept.'],
  ['pack <dir>', 'Build a .skillpkg from a skill folder and print its digests.'],
  ['config [get|set|unset]', 'Show or change settings, such as the registry.'],
];

export default function GuidelinesPage() {
  const contact = securityContact();

  return (
    <>
      <PageHeader
        eyebrow="Field guide"
        title="Guidelines"
        lede="How to install skills safely, write one others can trust, and what the registry does and does not promise."
      >
        <p className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[0.75rem] text-subtle">
          <span>{TOC.length} sections</span>
          <span aria-hidden="true">·</span>
          <span>{SCANNER_RULE_COUNT} scanner rules</span>
          <span aria-hidden="true">·</span>
          <span>4 agents, 2 folders</span>
        </p>
      </PageHeader>

      <Container className="pb-20 sm:pb-28">
        <div className="lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-14 xl:gap-20">
          <aside className="hidden lg:block">
            <div className="sticky top-(--header-h) max-h-[calc(100dvh-var(--header-h))] overflow-y-auto pt-12 pb-8">
              <TocNav />
              <a
                href="#main"
                className="mt-8 inline-flex items-center gap-1.5 pl-4 text-[0.8125rem] text-muted no-underline hover:text-text"
              >
                <ArrowUpIcon size={13} />
                Back to top
              </a>
            </div>
          </aside>

          <TocMobile className="lg:hidden" />

          <article className="min-w-0 max-w-reading pt-10 lg:pt-12">
            {/* 1 ------------------------------------------------------------------ */}
            <DocSection id="quick-start">
              <Prose>
                <p>
                  agenthub installs skills written in the open Agent Skills format (a folder with a{' '}
                  <code>SKILL.md</code>) into the folders that Claude Code, Codex, Cursor and VS
                  Code + Copilot read. Every install is planned, shown to you, applied as one
                  transaction and recorded in a lockfile. It needs Node.js 22 or newer.
                </p>
              </Prose>

              <DocSubheading id="check-your-setup" />
              <CommandList items={[{ command: 'agenthub doctor' }]} />
              <Prose>
                <p>
                  <code>doctor</code> is read-only. It lists the agents it detected and how sure it
                  is about each, the folders each one reads, your scope roots, lockfile health,
                  leftover transactions and unmet requirements. Exit code 1 means it found a
                  problem.
                </p>
              </Prose>

              <DocSubheading id="choose-a-registry" />
              <CommandList
                items={[
                  {
                    command: 'agenthub config set registry http://localhost:3000',
                    note: 'A hosted registry, such as one running from the agenthub repository.',
                  },
                  {
                    command: 'agenthub config set registry file:../my-skills',
                    note: 'A local folder of .skillpkg files.',
                  },
                ]}
              />
              <Prose>
                <p>You can also skip the registry and install straight from a folder or a file.</p>
              </Prose>

              <DocSubheading id="find-and-inspect" />
              <CommandList
                items={[
                  {
                    command: 'agenthub search "web testing" --agent cursor',
                    note: 'Filter by agent, or by category with --category.',
                  },
                  {
                    command: 'agenthub info web-testing',
                    note: 'Versions, publisher, compatible agents, requirements, declared permissions and the latest findings.',
                  },
                ]}
              />
              <Prose>
                <p>
                  <code>info</code> shows the same evidence as the skill page on this site.
                </p>
              </Prose>

              <DocSubheading id="install-list-verify" />
              <CommandList
                items={[
                  {
                    command: 'agenthub install web-testing',
                    note: 'Project scope, the default inside a repository.',
                  },
                  {
                    command: 'agenthub install web-testing -g',
                    note: 'User scope: every project on this machine sees the skill.',
                  },
                  {
                    command: 'agenthub install web-testing --dry-run',
                    note: 'Validation, scan and plan only. Nothing is written.',
                  },
                  { command: 'agenthub list', note: 'Installed skills and their status.' },
                  {
                    command: 'agenthub verify web-testing',
                    note: 'Re-hash every installed file against the lock.',
                  },
                ]}
              />
              <Prose>
                <p>
                  <code>verify</code> reports <em>ok</em>, <em>modified</em>, <em>missing</em> or{' '}
                  <em>extra</em> per file and exits with code 4 on any drift. Other useful flags:{' '}
                  <code>--yes</code> to skip the confirmation,{' '}
                  <code>--agent claude-code,cursor</code> to choose agents, and <code>--json</code>{' '}
                  for machine-readable output.
                </p>
              </Prose>

              <DocSubheading id="update-rollback-remove" />
              <CommandList
                items={[
                  {
                    command: 'agenthub update --check',
                    note: 'Current, latest and latest compatible versions. Never writes.',
                  },
                  {
                    command: 'agenthub update web-testing',
                    note: 'One skill: preview, snapshot, apply, validate.',
                  },
                  {
                    command: 'agenthub update --safe',
                    note: 'Every eligible skill. Skips anything risky.',
                  },
                  {
                    command: 'agenthub rollback web-testing',
                    note: 'Restore the previous snapshot.',
                  },
                  {
                    command: 'agenthub remove web-testing',
                    note: 'Only files agenthub installed are removed. Files you added or changed are kept and listed.',
                  },
                ]}
              />

              <DocSubheading id="scopes" />
              <Prose>
                <ul>
                  <li>
                    <strong>Project scope</strong> is the default inside a repository. Skills are
                    copied into the repository (for example <code>.agents/skills</code> and{' '}
                    <code>.claude/skills</code>) and recorded in{' '}
                    <code>.agenthub/agenthub.lock</code>.
                  </li>
                  <li>
                    <strong>User scope</strong> (<code>-g</code>) installs under your home folder,
                    so every project sees the skill. Its lock lives in <code>~/.agenthub/</code>.
                  </li>
                  <li>Outside any repository, installs go to user scope and the plan says so.</li>
                </ul>
              </Prose>
              <Callout
                tone="note"
                title="Commit the lockfile and the skill folders"
                className="my-6"
              >
                <p>
                  Commit <code>.agenthub/agenthub.lock</code> and the installed skill folders. The
                  lock records the exact version, content digest and per-file hashes, so a teammate
                  who clones the repository gets the same skills, <code>agenthub verify</code> gives
                  the same result, and <code>agenthub install</code> with no arguments restores
                  everything in it.
                </p>
              </Callout>

              <DocSubheading id="two-folders" />
              <Prose>
                <p>
                  Claude Code reads <code>.claude/skills</code>. Codex reads{' '}
                  <code>.agents/skills</code>. Cursor and VS Code read both.
                </p>
              </Prose>
              <AgentFolders />
              <Prose>
                <p>
                  So when a skill is installed for all four agents, Cursor and VS Code list it
                  twice. The plan tells you when this happens and <code>doctor</code> reports it. If
                  you only use some agents, choose them with <code>--agent</code>.
                </p>
              </Prose>

              <DocSubheading id="command-reference" />
              <div className="my-6">
                <Table sticky={false} caption="agenthub commands">
                  <THead>
                    <TR>
                      <TH>Command</TH>
                      <TH>What it does</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {COMMANDS.map(([command, does]) => (
                      <TR key={command}>
                        <TD label="Command" mono className="sm:whitespace-nowrap">
                          {command}
                        </TD>
                        <TD label="Does" className="text-text">
                          {does}
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>

              <DocSubheading id="exit-codes" />
              <Prose>
                <p>Every command ends with one of these codes, so scripts and CI can react.</p>
              </Prose>
              <ExitCodes />
            </DocSection>

            {/* 2 ------------------------------------------------------------------ */}
            <DocSection id="installing-safely">
              <Prose>
                <p>
                  A skill is instructions plus, sometimes, scripts that your agent may run with your
                  permissions. Treat installing one like adding a dependency to your project.
                </p>
              </Prose>

              <DocSubheading id="read-the-plan" />
              <Prose>
                <p>Before anything is written, the CLI prints a plan. Check that:</p>
                <ul>
                  <li>the skill name, version and publisher are the ones you expected;</li>
                  <li>the target agents and destination folders make sense for this project;</li>
                  <li>every WARN finding is something the skill obviously needs;</li>
                  <li>the declared permissions match what the skill says it does.</li>
                </ul>
                <p>
                  With warnings present the prompt defaults to <strong>No</strong> (
                  <code>[y/N]</code>). In scripts, <code>--yes</code> is required, and a blocked
                  plan always exits with code 3.
                </p>
              </Prose>

              <DocSubheading id="decisions" />
              <Prose>
                <p>
                  The scanner reports findings. The policy decides what each one means, based on
                  whether the skill <em>declared</em> that behavior in <code>agenthub.yaml</code>.
                </p>
              </Prose>
              <DecisionLegend />
              <PolicyTable />
              <Prose>
                <p>
                  Suspicious instructions, unexpected binaries and dynamic code cannot be declared
                  away: they stay WARN, so you review them every time.
                </p>
              </Prose>
              <Callout
                tone="warning"
                title="Never use --dev on skills you did not write"
                className="my-6"
              >
                <p>
                  <code>--dev</code> turns a BLOCK into a warning. It exists for authors testing
                  their own skills: it prints a notice and records an <code>override</code> event in{' '}
                  <code>~/.agenthub/audit.log</code>. On someone else’s skill it switches off the
                  one check designed to stop credential theft and download-and-run payloads.
                </p>
              </Callout>

              <DocSubheading id="check-digests" />
              <Prose>
                <p>
                  Each version has a <strong>content digest</strong> (SHA-256 over every file) and
                  an <strong>archive digest</strong> (SHA-256 of the downloaded{' '}
                  <code>.skillpkg</code>). The CLI checks both automatically. When you pin a skill
                  in a team, compare the content digest in <code>agenthub info</code> or on the
                  skill page with the one in your lock.
                </p>
              </Prose>

              <DocSubheading id="review-updates" />
              <Prose>
                <ul>
                  <li>
                    Run <code>agenthub update --check</code> first. It never writes, and lists the
                    current, latest and latest compatible versions.
                  </li>
                  <li>
                    A new version can add permissions or findings. Read its plan and release notes
                    the same way you did for the first install.
                  </li>
                  <li>
                    <code>update --safe</code> skips anything incompatible, revoked, blocked, in
                    need of a decision, or with local edits, so it is the right choice for
                    unattended runs.
                  </li>
                </ul>
              </Prose>

              <DocSubheading id="how-rollback-works" />
              <Prose>
                <p>
                  Before replacing an installed skill, the engine saves the previous tree and its
                  lock entry as a snapshot. If post-install validation fails (a hash mismatch, an
                  unreadable <code>SKILL.md</code>, the wrong folder) the transaction is undone and
                  the previous state is left exactly as it was. Later,{' '}
                  <code>agenthub rollback &lt;skill&gt;</code> restores the last snapshot through
                  the same transactional engine. If the process is interrupted, the next command
                  finds the journal and finishes or undoes the work.
                </p>
              </Prose>
            </DocSection>

            {/* 3 ------------------------------------------------------------------ */}
            <DocSection id="writing-a-safe-skill">
              <Prose>
                <p>
                  A skill others can trust is small, declares what it does, and hides nothing. The
                  scanner rewards exactly that.
                </p>
              </Prose>

              <DocSubheading id="skill-md-rules" />
              <Prose>
                <ul>
                  <li>
                    <code>SKILL.md</code> starts with a <code>---</code> frontmatter block.
                  </li>
                  <li>
                    <code>name</code> is required: 1 to 64 characters, lowercase letters, digits and
                    single hyphens, no leading or trailing hyphen, and it{' '}
                    <strong>must equal the folder name</strong> (VS Code skips skills where they
                    differ).
                  </li>
                  <li>
                    <code>description</code> is required, up to 1024 characters. Say what the skill
                    does <em>and when to use it</em>: agents use it to decide when to load the
                    skill.
                  </li>
                  <li>
                    Optional: <code>license</code>, <code>compatibility</code> (up to 500
                    characters) and <code>metadata</code> as text pairs. This registry reads{' '}
                    <code>metadata.category</code> and <code>metadata.tags</code> for search.
                  </li>
                  <li>
                    Keep the body <strong>under 500 lines</strong>. Move long reference material
                    into separate files the skill points to.
                  </li>
                </ul>
              </Prose>
              <CodeFile name="changelog-writer/SKILL.md" language="markdown" code={SKILL_MD} />

              <DocSubheading id="declare-permissions" />
              <Prose>
                <p>
                  <code>agenthub.yaml</code> sits next to <code>SKILL.md</code> and leaves the
                  standard file untouched. Unknown keys are errors, so typos are caught at pack
                  time. Declare exactly what your scripts do, no more and no less: declared behavior
                  becomes INFO, undeclared behavior is flagged.
                </p>
              </Prose>
              <CodeFile
                name="changelog-writer/agenthub.yaml"
                language="yaml"
                code={AGENTHUB_YAML}
                caption="Without agenthub.yaml nothing is declared, so every risky behavior the scanner finds counts as undeclared."
              />

              <DocSubheading id="reviewable-practices" />
              <Prose>
                <ul>
                  <li>
                    <strong>Keep scripts minimal and readable.</strong> Prefer instructions the
                    agent follows over code. When code is needed, keep it short, commented and in
                    plain source: reviewers and the scanner need to read it.
                  </li>
                  <li>
                    <strong>No secrets in packages.</strong> Never ship tokens, keys or real
                    credential files, not even as examples. Read configuration from the user’s
                    environment and declare it.
                  </li>
                  <li>
                    <strong>No download-and-run.</strong> Do not fetch code at run time and execute
                    it. This is blocked and cannot be declared away. Ship the code in the package so
                    its digest covers it.
                  </li>
                  <li>
                    <strong>No obfuscation.</strong> Encoded blobs, packed JavaScript and char-code
                    arrays are blocked.
                  </li>
                  <li>
                    <strong>No hidden Unicode.</strong> Zero-width, bidirectional and tag
                    characters, and instructions inside HTML comments, are blocked. Write everything
                    in plain sight.
                  </li>
                  <li>
                    <strong>Pin dependencies.</strong> If a script needs a tool, pin its version
                    (for example <code>npx some-tool@4.2.1</code>) and declare the command. Avoid
                    installing packages at run time.
                  </li>
                  <li>
                    <strong>Stay in your lane.</strong> Write only inside the project or a temporary
                    folder, and never touch shell profiles, startup items, git hooks or another
                    agent’s configuration.
                  </li>
                </ul>
              </Prose>

              <DocSubheading id="test-before-publishing" />
              <CommandList
                items={[
                  {
                    command: 'agenthub install ./my-skill --dry-run',
                    note: 'Validation, scan and plan, exactly as your users will see them. Nothing is written.',
                  },
                  {
                    command: 'agenthub pack ./my-skill',
                    note: 'Builds my-skill-1.0.0.skillpkg and prints both digests.',
                  },
                ]}
              />
              <Prose>
                <p>
                  Packing the same folder always produces the same bytes and the same digests, on
                  every operating system.
                </p>
              </Prose>
            </DocSection>

            {/* 4 ------------------------------------------------------------------ */}
            <DocSection id="publishing-rules">
              <Prose>
                <ul>
                  <li>
                    <strong>Identity is required.</strong> Publishing needs a publisher token issued
                    by the registry. A “verified” seal means the registry confirmed who the
                    publisher is; it says nothing about the safety of a specific version.
                  </li>
                  <li>
                    <strong>Versions are immutable.</strong> Once <code>1.2.0</code> is published it
                    never changes. Fix mistakes by publishing <code>1.2.1</code>.
                  </li>
                  <li>
                    <strong>Every upload is scanned.</strong> The registry recomputes both digests,
                    stores the archive under its SHA-256 and runs the scanner before the version is
                    listed.
                  </li>
                  <li>
                    <strong>Blocked uploads are quarantined.</strong> A version with any BLOCK
                    finding is stored but cannot be downloaded or installed until a moderator
                    reviews it. You see the findings in the publish result and on your dashboard.
                  </li>
                  <li>
                    <strong>Revocation.</strong> Moderators can revoke a version that is malicious,
                    compromised or seriously broken. Revoked versions return HTTP 410 and are never
                    resolved for new installs; <code>update --check</code> flags installs that use
                    them, and <code>update --safe</code> moves you off them. Revocation is final.
                  </li>
                  <li>
                    <strong>Names.</strong> A skill name belongs to the first publisher who uses it.
                    Lookalike names (swapped or doubled letters, misleading suffixes such as{' '}
                    <code>-official</code>) and impersonation of other projects, companies or people
                    are not allowed and will be revoked.
                  </li>
                  <li>
                    <strong>Licenses.</strong> Publish only content you have the right to
                    distribute, and state its license in the <code>license</code> field. Do not
                    republish someone else’s skill under your name.
                  </li>
                </ul>
                <p>
                  Ready? Upload the <code>.skillpkg</code> on the{' '}
                  <Link href="/publish">Publish</Link> page, or send it to{' '}
                  <code>POST /api/v1/publish</code> with your token.
                </p>
              </Prose>
            </DocSection>

            {/* 5 ------------------------------------------------------------------ */}
            <DocSection id="security-model">
              <Prose>
                <p>
                  A skill is not safe because it is Markdown. agenthub treats every skill as a
                  supply-chain artifact: pinned by digest, scanned before install, and never run.
                </p>
              </Prose>

              <DocSubheading id="integrity" />
              <Prose>
                <ul>
                  <li>
                    The <strong>content digest</strong> is <code>sha256:</code> over a manifest of
                    one line per file (<code>&lt;sha256 of normalized bytes&gt; &lt;path&gt;</code>
                    ), in sorted order. It is the identity of a version, recorded in the lock and
                    checked after every extract and by <code>verify</code>. Text files are hashed
                    with LF line endings, so a git CRLF checkout does not cause false drift.
                  </li>
                  <li>
                    The <strong>archive digest</strong> is <code>sha256:</code> of the exact{' '}
                    <code>.skillpkg</code> bytes. Downloads carry it in the{' '}
                    <code>X-Archive-Digest</code> header and the CLI rejects any mismatch.
                  </li>
                  <li>
                    Archives are deterministic (sorted entries, fixed timestamps and modes), so the
                    same folder always packs to the same bytes.
                  </li>
                  <li>
                    Extraction rejects symlinks, absolute paths, <code>..</code> segments, drive
                    letters, reserved Windows names, case clashes and oversized content.
                  </li>
                </ul>
              </Prose>

              <DocSubheading id="scanner-rules" />
              <Prose>
                <p>
                  The scanner is static analysis of every file: nothing in a package is ever
                  executed by the registry or by the CLI. Every finding names the rule, the file and
                  line, and shows the evidence.
                </p>
              </Prose>
              <RulesTable />

              <DocSubheading id="scanner-limits" />
              <Callout tone="note" title="A clean scan is not a guarantee" className="my-6">
                <p>
                  “No warnings” means no known risky pattern was found. It is evidence, not proof:
                  the registry never labels a skill as safe.
                </p>
              </Callout>
              <Prose>
                <ul>
                  <li>
                    The scanner looks for known risky patterns. A determined author can write
                    harmful instructions or code that matches none of them.
                  </li>
                  <li>
                    It cannot judge intent: a declared network call can still send data somewhere
                    you would not want. Read what the skill does with its permissions.
                  </li>
                  <li>
                    Instructions in <code>SKILL.md</code> steer your agent. Review them as you would
                    a script, especially anything about credentials, approvals or running commands.
                  </li>
                  <li>
                    agenthub does not sandbox your agent. Once installed, a skill is followed with
                    the agent’s own permissions, so keep your agent’s approval prompts on.
                  </li>
                  <li>
                    Releases are not cryptographically signed yet. Integrity relies on the digests
                    pinned in your lock and on the registry’s immutable storage.
                  </li>
                </ul>
              </Prose>
            </DocSection>

            {/* 6 ------------------------------------------------------------------ */}
            <DocSection id="reporting">
              <Prose>
                <p>
                  If you find a skill that steals data, runs hidden payloads or impersonates another
                  project, or a security issue in agenthub itself, report it privately.
                </p>
                {contact ? (
                  <p>
                    Contact: <SecurityContact contact={contact} />
                  </p>
                ) : (
                  <p>
                    Contact the operator of this registry through its published security contact.
                  </p>
                )}
                <p>Include:</p>
                <ul>
                  <li>the skill name and version (or the skill page URL);</li>
                  <li>the content digest shown on the skill page;</li>
                  <li>the file and line, and what it does;</li>
                  <li>for vulnerabilities in agenthub, steps to reproduce and the impact.</li>
                </ul>
                <p>
                  Please do not post working exploits publicly before the version is revoked or the
                  issue is fixed. Moderators can quarantine a version immediately while they
                  investigate. If you already installed an affected skill, run{' '}
                  <code>agenthub remove &lt;skill&gt;</code> (or roll back), then rotate any
                  credentials the skill could have read.
                </p>
              </Prose>
            </DocSection>

            {/* 7 ------------------------------------------------------------------ */}
            <DocSection id="troubleshooting">
              <DocSubheading id="agent-does-not-show-skill" />
              <Prose>
                <ul>
                  <li>
                    Agents load skills at startup or on request. Reload after installing: Claude
                    Code <code>/reload-skills</code>, Copilot CLI <code>/skills reload</code>,
                    restart the Cursor CLI, or reload the VS Code window.
                  </li>
                  <li>
                    Check that the skill went to a folder the agent reads with{' '}
                    <code>agenthub list</code> and <code>agenthub doctor</code>. Claude Code reads{' '}
                    <code>.claude/skills</code>; Codex reads <code>.agents/skills</code>; Cursor and
                    VS Code read both.
                  </li>
                  <li>
                    Make sure you are in the right scope: a project install is only visible inside
                    that repository.
                  </li>
                  <li>
                    Cursor and VS Code can list a skill twice when it is installed for all four
                    agents (one copy per folder). <code>doctor</code> reports this.
                  </li>
                </ul>
              </Prose>

              <DocSubheading id="verify-reports-drift" />
              <Prose>
                <ul>
                  <li>
                    <em>modified</em> or <em>missing</em> files mean the installed copy no longer
                    matches the lock, usually after a hand edit or a partial checkout.
                  </li>
                  <li>
                    To restore the published files, run{' '}
                    <code>agenthub install &lt;skill&gt; --force</code> or{' '}
                    <code>agenthub rollback &lt;skill&gt;</code>. Keep a copy of your edits first.
                  </li>
                  <li>
                    <em>extra</em> files are not part of the package; they are kept on remove and
                    reported.
                  </li>
                </ul>
              </Prose>

              <DocSubheading id="windows-file-locks" />
              <Prose>
                <ul>
                  <li>
                    Errors such as <code>EPERM</code>, <code>EBUSY</code> or <code>EACCES</code>{' '}
                    during install mean another program has a file open: an editor, an agent,
                    antivirus or a search indexer.
                  </li>
                  <li>
                    The engine retries for a few seconds, then stops and names the path. Nothing is
                    left half-written: close the program holding the file and run the command again.
                  </li>
                  <li>
                    If the process was killed mid-install, the next agenthub command finishes or
                    undoes the interrupted transaction and tells you what it did.
                  </li>
                </ul>
              </Prose>
              <Prose className="mt-8">
                <p>
                  Still stuck? <Link href="/">Search the registry</Link>, or run the command below
                  and include its output when you ask for help.
                </p>
              </Prose>
              <CommandList items={[{ command: 'agenthub doctor --json' }]} />
            </DocSection>

            <ReportCard contact={contact} />
          </article>
        </div>
      </Container>
    </>
  );
}
