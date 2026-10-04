import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { securityContact } from '../../src/config';

export const metadata: Metadata = {
  title: 'Guidelines',
  description:
    'How to install agent skills safely, write and publish a safe skill, how the registry security model works, and how to report a malicious skill.',
};

const TOC = [
  { id: 'quick-start', label: 'Quick start' },
  { id: 'installing-safely', label: 'Installing safely' },
  { id: 'writing-a-safe-skill', label: 'Writing a safe skill' },
  { id: 'publishing-rules', label: 'Publishing rules' },
  { id: 'security-model', label: 'Security model' },
  { id: 'reporting', label: 'Reporting a malicious skill or vulnerability' },
  { id: 'troubleshooting', label: 'Troubleshooting' },
];

function Code({ children }: { children: string }) {
  return (
    <pre>
      <code>{children}</code>
    </pre>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'info';
  title: string;
  children: ReactNode;
}) {
  const cls =
    tone === 'warn'
      ? 'border-warn-line bg-warn-bg text-warn-fg'
      : 'border-info-line bg-info-bg text-info-fg';
  return (
    <aside className={`my-4 rounded-lg border p-4 text-sm ${cls}`}>
      <p className="font-semibold">{title}</p>
      <div className="mt-1">{children}</div>
    </aside>
  );
}

const SCANNER_RULES: [string, string, string][] = [
  [
    'exec.shell',
    'Shell and process execution: child_process, subprocess, os.system, Invoke-Expression, sh -c, backticks',
    'Medium: WARN if undeclared, INFO if the command is declared in permissions.exec',
  ],
  [
    'net.access',
    'Network clients: fetch, http(s).request, axios, requests, urllib, sockets, curl, wget, Invoke-WebRequest',
    'Medium: WARN if undeclared, INFO if permissions.network allows it',
  ],
  [
    'net.download-exec',
    'Downloaded content chained into execution: curl … | sh, iwr … | iex, fetch → eval, write-then-run',
    'High, never declarable: BLOCK',
  ],
  [
    'secrets.read',
    'Credential locations: .env files, ~/.aws, ~/.ssh, ~/.config/gcloud, .npmrc, .netrc, keychains, browser profiles, bulk environment dumps',
    'High: BLOCK if undeclared, WARN if listed in permissions.secrets',
  ],
  [
    'env.read',
    'Specific environment variables that are not declared',
    'Medium: WARN if undeclared, INFO if listed in permissions.env',
  ],
  [
    'code.dynamic',
    'eval, new Function, vm.run*, exec() of strings',
    'Medium; high (BLOCK) when fed by network or encoded data',
  ],
  [
    'code.obfuscated',
    'Long base64 or hex blobs decoded at runtime, char-code arrays, packed JavaScript',
    'High, never declarable: BLOCK',
  ],
  [
    'fs.persistence',
    'Writes to shell rc files, startup folders, cron, launchd, systemd, registry Run keys, git hooks, other agents’ configuration',
    'High, never declarable: BLOCK',
  ],
  [
    'deps.remote',
    'Runtime package installs (npm i, pip install), git or URL dependencies, install hooks',
    'Medium: WARN if undeclared, INFO if declared',
  ],
  [
    'prompt.injection',
    '“Ignore previous instructions”, “do not tell the user”, requests to reveal secrets or disable approvals and safety checks',
    'Medium: WARN',
  ],
  [
    'prompt.hidden',
    'Zero-width, bidi-override and Unicode tag characters; instructions hidden in HTML comments',
    'High, never declarable: BLOCK',
  ],
  [
    'file.binary',
    'ELF, PE or Mach-O executables, nested archives, unexpected file types',
    'Medium: WARN if undeclared',
  ],
];

export default function GuidelinesPage() {
  const contact = securityContact();

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header className="max-w-3xl">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Guidelines</h1>
        <p className="mt-3 text-lg text-muted">
          How to install skills safely, how to write and publish one that others can trust, and what
          the registry does — and does not — promise.
        </p>
      </header>

      <div className="mt-10 grid gap-10 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-labelledby="toc-heading" className="lg:sticky lg:top-24 lg:self-start">
          <h2 id="toc-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">
            On this page
          </h2>
          <ol className="mt-3 grid gap-1.5 border-l border-line pl-4 text-sm">
            {TOC.map((item, index) => (
              <li key={item.id}>
                <a href={`#${item.id}`} className="no-underline hover:underline">
                  {index + 1}. {item.label}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="prose-doc min-w-0 max-w-3xl">
          {/* 1 ------------------------------------------------------------------ */}
          <section aria-labelledby="quick-start">
            <h2 id="quick-start">1. Quick start</h2>
            <p>
              agenthub installs skills written in the open Agent Skills format (a folder with a{' '}
              <code>SKILL.md</code>) into the folders that Claude Code, Codex, Cursor and VS Code /
              Copilot read. Every install is planned, shown to you, applied as one transaction and
              recorded in a lockfile.
            </p>

            <h3>Check your setup</h3>
            <Code>{`agenthub doctor`}</Code>
            <p>
              <code>doctor</code> is read-only. It lists the agents it detected (with version and
              confidence), the folders each one reads, your scope roots, lockfile health, leftover
              transactions and unmet requirements. Exit code 1 means it found a problem.
            </p>

            <h3>Find and inspect a skill</h3>
            <Code>{`agenthub search "web testing" --agent cursor
agenthub info web-testing`}</Code>
            <p>
              <code>info</code> shows versions, the publisher, compatible agents, requirements,
              declared permissions and the latest scan findings — the same evidence as the skill
              page on this site.
            </p>

            <h3>Install, list and verify</h3>
            <Code>{`agenthub install web-testing          # project scope (inside a repo)
agenthub install web-testing -g       # user scope, for every project
agenthub list
agenthub verify web-testing`}</Code>
            <p>
              <code>verify</code> re-hashes every installed file against the lock and reports{' '}
              <em>ok</em>, <em>modified</em>, <em>missing</em> or <em>extra</em> per file. It exits
              with code 4 on any drift.
            </p>

            <h3>Update and roll back</h3>
            <Code>{`agenthub update --check               # what would change; never writes
agenthub update web-testing           # one skill: preview, snapshot, apply, validate
agenthub update --safe                # all eligible skills; skips anything risky
agenthub rollback web-testing         # restore the previous snapshot`}</Code>

            <h3>Project scope vs user scope</h3>
            <ul>
              <li>
                <strong>Project scope</strong> is the default inside a repository. Skills are copied
                into the repo (for example <code>.agents/skills</code> and{' '}
                <code>.claude/skills</code>) and recorded in <code>.agenthub/agenthub.lock</code>.
              </li>
              <li>
                <strong>User scope</strong> (<code>-g</code>) installs into your home folder so
                every project sees the skill. Its lock lives in <code>~/.agenthub/</code>.
              </li>
              <li>Outside any repository, installs go to user scope and the plan says so.</li>
            </ul>
            <Callout tone="info" title="Commit the lockfile">
              <p>
                Commit <code>.agenthub/agenthub.lock</code> and the installed skill folders. The
                lock records the exact version, content digest and per-file hashes, so a teammate
                who clones the repo can run <code>agenthub verify</code> and get the same result,
                and <code>agenthub install</code> with no arguments restores everything in it.
              </p>
            </Callout>

            <h3>Exit codes</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>0</td>
                    <td>Success</td>
                  </tr>
                  <tr>
                    <td>1</td>
                    <td>Error, or problems found</td>
                  </tr>
                  <tr>
                    <td>2</td>
                    <td>Usage error</td>
                  </tr>
                  <tr>
                    <td>3</td>
                    <td>Blocked by security policy</td>
                  </tr>
                  <tr>
                    <td>4</td>
                    <td>Integrity failure or drift</td>
                  </tr>
                  <tr>
                    <td>5</td>
                    <td>Incompatible (agent, runtime or command requirement)</td>
                  </tr>
                  <tr>
                    <td>130</td>
                    <td>Cancelled</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* 2 ------------------------------------------------------------------ */}
          <section aria-labelledby="installing-safely">
            <h2 id="installing-safely">2. Installing safely</h2>
            <p>
              A skill is instructions plus, sometimes, scripts that your agent may run with your
              permissions. Treat installing one like adding a dependency to your project.
            </p>

            <h3>Read the install plan</h3>
            <p>Before anything is written, the CLI prints a plan. Check that:</p>
            <ul>
              <li>the skill name, version and publisher are the ones you expected;</li>
              <li>the target agents and destination folders make sense for this project;</li>
              <li>every WARN finding is something the skill obviously needs;</li>
              <li>declared permissions match what the skill says it does.</li>
            </ul>
            <p>
              With warnings present the prompt defaults to <strong>No</strong> (<code>[y/N]</code>).
              In scripts, <code>--yes</code> is required and a blocked plan always exits with code
              3.
            </p>

            <h3>What INFO, WARN and BLOCK mean</h3>
            <p>
              The scanner reports findings; the policy decides what each one means based on whether
              the skill <em>declared</em> that behavior in <code>agenthub.yaml</code>.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Finding</th>
                    <th scope="col">Undeclared</th>
                    <th scope="col">Declared</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      Medium risk: network, shell/exec, environment reads, runtime package installs,
                      suspicious prompt phrases, unexpected binaries
                    </td>
                    <td>
                      <strong>WARN</strong> (confirm)
                    </td>
                    <td>INFO</td>
                  </tr>
                  <tr>
                    <td>High risk, declarable: secret or credential reads</td>
                    <td>
                      <strong>BLOCK</strong>
                    </td>
                    <td>
                      <strong>WARN</strong> (confirm)
                    </td>
                  </tr>
                  <tr>
                    <td>
                      High risk, never declarable: download-and-run, obfuscated payloads, dynamic
                      code fed by network or encoded data, hidden-Unicode instructions, persistence
                      (shell rc, startup items, cron, registry Run keys, git hooks, other agents’
                      configuration)
                    </td>
                    <td>
                      <strong>BLOCK</strong>
                    </td>
                    <td>
                      <strong>BLOCK</strong>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <ul>
              <li>
                <strong>INFO</strong> — expected, declared behavior. Shown for transparency.
              </li>
              <li>
                <strong>WARN</strong> — needs your explicit confirmation. Read the evidence line.
              </li>
              <li>
                <strong>BLOCK</strong> — the install will not proceed.
              </li>
            </ul>

            <Callout tone="warn" title="Never use --dev on a skill you do not trust">
              <p>
                <code>--dev</code> overrides a BLOCK. It exists for authors testing their own
                skills, prints a banner and writes an <code>override</code> event to the audit log.
                Using it on someone else’s skill disables the one check designed to stop credential
                theft and download-and-run payloads.
              </p>
            </Callout>

            <h3>Check digests</h3>
            <p>
              Each version has a <strong>content digest</strong> (SHA-256 over every file) and an{' '}
              <strong>archive digest</strong> (SHA-256 of the downloaded <code>.skillpkg</code>).
              The CLI checks both automatically. When you pin a skill in a team, compare the content
              digest in <code>agenthub info</code> or on the skill page with the one in your lock.
            </p>

            <h3>Review updates before applying them</h3>
            <ul>
              <li>
                Run <code>agenthub update --check</code> first. It never writes and lists current,
                latest and latest-compatible versions.
              </li>
              <li>
                A new version can add permissions or findings. Read the plan and the release notes
                the same way you did for the first install.
              </li>
              <li>
                <code>update --safe</code> skips anything incompatible, revoked, blocked or with
                local edits, so it is the right choice for unattended runs.
              </li>
            </ul>

            <h3>How rollback works</h3>
            <p>
              Before replacing an installed skill, the engine saves the previous tree and its lock
              entry as a snapshot. If post-install validation fails (hash mismatch, unreadable{' '}
              <code>SKILL.md</code>, wrong folder) the transaction is undone automatically and the
              previous state is left exactly as it was. Later,{' '}
              <code>agenthub rollback &lt;skill&gt;</code> restores the last snapshot through the
              same transactional engine. If the process is interrupted, the next command finds the
              journal and finishes or undoes the work.
            </p>
          </section>

          {/* 3 ------------------------------------------------------------------ */}
          <section aria-labelledby="writing-a-safe-skill">
            <h2 id="writing-a-safe-skill">3. Writing a safe skill</h2>

            <h3>SKILL.md rules</h3>
            <ul>
              <li>
                <code>SKILL.md</code> starts with a <code>---</code> frontmatter block.
              </li>
              <li>
                <code>name</code> is required: 1–64 characters, lowercase letters, digits and single
                hyphens, no leading or trailing hyphen, and it{' '}
                <strong>must equal the folder name</strong> (VS Code skips skills where they
                differ).
              </li>
              <li>
                <code>description</code> is required (up to 1024 characters). Say what the skill
                does <em>and when to use it</em>; agents use it to decide when to load the skill.
              </li>
              <li>
                Optional: <code>license</code>, <code>compatibility</code> (up to 500 characters),
                and <code>metadata</code> as string-to-string pairs. This registry reads{' '}
                <code>metadata.category</code> and <code>metadata.tags</code> for search.
              </li>
              <li>
                Keep the body <strong>under 500 lines</strong>. Move long reference material into
                separate files the skill points to.
              </li>
            </ul>
            <Code>{`---
name: changelog-writer
description: Draft a changelog entry from merged changes. Use when preparing a release.
license: MIT
metadata:
  category: docs
  tags: changelog release notes
---

# Changelog writer

1. Collect the changes since the last tag ...`}</Code>

            <h3>Declare permissions honestly in agenthub.yaml</h3>
            <p>
              <code>agenthub.yaml</code> sits next to <code>SKILL.md</code> and keeps the standard
              file untouched. Unknown keys are errors, so typos are caught at pack time. Declare
              exactly what your scripts do — no more, no less. Declared behavior becomes INFO;
              undeclared behavior is flagged.
            </p>
            <Code>{`schema: 1
version: 1.2.0
targets: [claude-code, codex, cursor, vscode]   # optional; default is all four
requires:
  runtimes: { node: ">=22" }
  commands: [git, npx]
permissions:
  network: [registry.npmjs.org]   # true, false, or a list of hosts
  exec: [npx, git]                # commands your scripts run
  env: [CI]                       # environment variables you read
  secrets: []                     # credential files or variables you read (avoid)
  fs: { write: [project, temp] }  # project | home | temp
channel: stable                   # stable | beta`}</Code>

            <h3>Practices that keep a skill reviewable</h3>
            <ul>
              <li>
                <strong>Keep scripts minimal and readable.</strong> Prefer instructions the agent
                follows over code. When code is needed, keep it short, commented and in plain source
                — reviewers and the scanner need to read it.
              </li>
              <li>
                <strong>No secrets in packages.</strong> Never ship tokens, keys, or real credential
                files, not even as examples. Read configuration from the user’s environment and
                declare it.
              </li>
              <li>
                <strong>No download-and-run.</strong> Do not fetch code at runtime and execute it.
                This is blocked and cannot be declared away. Ship the code in the package so its
                digest covers it.
              </li>
              <li>
                <strong>No obfuscation.</strong> Encoded blobs, packed JavaScript and char-code
                arrays are blocked.
              </li>
              <li>
                <strong>No hidden Unicode.</strong> Zero-width, bidi-override and tag characters,
                and instructions inside HTML comments, are blocked. Write everything in plain sight.
              </li>
              <li>
                <strong>Pin dependencies.</strong> If a script needs a tool, pin its version (for
                example <code>npx some-tool@4.2.1</code>) and declare the command. Avoid installing
                packages at runtime.
              </li>
              <li>
                <strong>Stay in your lane.</strong> Do not write outside the project or temp
                folders, and never touch shell profiles, startup items, git hooks or another agent’s
                configuration.
              </li>
            </ul>
            <p>
              Before publishing, run <code>agenthub pack ./my-skill</code> and then install the
              resulting <code>.skillpkg</code> locally — you will see exactly the findings and plan
              your users will see.
            </p>
          </section>

          {/* 4 ------------------------------------------------------------------ */}
          <section aria-labelledby="publishing-rules">
            <h2 id="publishing-rules">4. Publishing rules</h2>
            <ul>
              <li>
                <strong>Identity is required.</strong> Publishing needs a publisher token issued by
                the registry. A “verified” badge means the registry confirmed who the publisher is;
                it says nothing about the safety of a specific version.
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
                <strong>Blocked uploads are quarantined.</strong> A version with any BLOCK finding
                is stored but cannot be downloaded or installed until a moderator reviews it. You
                will see the findings in the publish result and on your dashboard.
              </li>
              <li>
                <strong>Revocation.</strong> Moderators can revoke a version that is malicious,
                compromised or seriously broken. Revoked versions return HTTP 410, are never
                resolved for new installs, <code>update --check</code> flags installs that use them,
                and <code>update --safe</code> moves you off them. Revocation is final.
              </li>
              <li>
                <strong>Names.</strong> A skill name belongs to the first publisher who uses it.
                Lookalike names (swapped or doubled letters, misleading suffixes such as{' '}
                <code>-official</code>) and impersonation of other projects, companies or people are
                not allowed and will be revoked.
              </li>
              <li>
                <strong>Licenses.</strong> Publish only content you have the right to distribute,
                and state its license in the <code>license</code> field. Do not republish someone
                else’s skill under your name.
              </li>
            </ul>
          </section>

          {/* 5 ------------------------------------------------------------------ */}
          <section aria-labelledby="security-model">
            <h2 id="security-model">5. Security model</h2>

            <h3>Integrity</h3>
            <ul>
              <li>
                The <strong>content digest</strong> is <code>sha256:</code> over a manifest of one
                line per file (<code>&lt;sha256 of normalized bytes&gt; &lt;path&gt;</code>), in
                sorted order. It is the identity of a version, recorded in the lock and checked
                after every extract and by <code>verify</code>. Text files are hashed with LF line
                endings, so a git CRLF checkout does not cause false drift.
              </li>
              <li>
                The <strong>archive digest</strong> is <code>sha256:</code> of the exact{' '}
                <code>.skillpkg</code> bytes. Downloads carry it in the{' '}
                <code>X-Archive-Digest</code> header and the CLI rejects any mismatch.
              </li>
              <li>
                Archives are deterministic (sorted entries, fixed timestamps and modes), so the same
                folder always packs to the same bytes.
              </li>
              <li>
                Extraction rejects symlinks, absolute paths, <code>..</code> segments, drive
                letters, reserved Windows names, case clashes and oversized content.
              </li>
            </ul>

            <h3>Scanner rules</h3>
            <p>
              The scanner is a pure static analysis of every file: nothing in a package is ever
              executed by the registry or by the CLI.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Rule</th>
                    <th scope="col">Detects</th>
                    <th scope="col">Default decision</th>
                  </tr>
                </thead>
                <tbody>
                  {SCANNER_RULES.map(([rule, detects, decision]) => (
                    <tr key={rule}>
                      <td>
                        <code>{rule}</code>
                      </td>
                      <td>{detects}</td>
                      <td>{decision}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>What the scanner cannot promise</h3>
            <ul>
              <li>
                It looks for known risky patterns. A determined author can write harmful
                instructions or code that matches none of them.
              </li>
              <li>
                “No warnings” is evidence, not a guarantee of safety. The registry never labels a
                skill as safe.
              </li>
              <li>
                It cannot judge intent: a declared network call can still send data somewhere you
                would not want. Read what the skill does with its permissions.
              </li>
              <li>
                Instructions in <code>SKILL.md</code> steer your agent. Review them as you would a
                script, especially anything about credentials, approvals or running commands.
              </li>
            </ul>
          </section>

          {/* 6 ------------------------------------------------------------------ */}
          <section aria-labelledby="reporting">
            <h2 id="reporting">6. Reporting a malicious skill or vulnerability</h2>
            <p>
              If you find a skill that steals data, runs hidden payloads, impersonates another
              project, or a security issue in agenthub itself, report it privately:
            </p>
            {contact ? (
              <p>
                Contact: <strong className="font-mono">{contact}</strong>
              </p>
            ) : (
              <p>Contact the operator of this registry through its published security contact.</p>
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
              <code>agenthub remove &lt;skill&gt;</code> (or roll back), then rotate any credentials
              the skill could have read.
            </p>
          </section>

          {/* 7 ------------------------------------------------------------------ */}
          <section aria-labelledby="troubleshooting">
            <h2 id="troubleshooting">7. Troubleshooting</h2>

            <h3>The agent does not show the skill</h3>
            <ul>
              <li>
                Agents load skills at startup or on request. Reload after installing: Claude Code{' '}
                <code>/reload-skills</code>, Copilot CLI <code>/skills reload</code>, restart the
                Cursor CLI, or reload the VS Code window.
              </li>
              <li>
                Check that the skill went to a folder the agent reads with{' '}
                <code>agenthub list</code> and <code>agenthub doctor</code>. Claude Code reads{' '}
                <code>.claude/skills</code>; Codex reads <code>.agents/skills</code>; Cursor and VS
                Code read both.
              </li>
              <li>
                Make sure you are in the right scope: a project install is only visible inside that
                repository.
              </li>
              <li>
                Cursor and VS Code can list a skill twice when it is installed for all four agents
                (one copy per folder). <code>doctor</code> reports this.
              </li>
            </ul>

            <h3>verify reports drift</h3>
            <ul>
              <li>
                <em>modified</em> or <em>missing</em> files mean the installed copy no longer
                matches the lock — usually a hand edit or a partial checkout.
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

            <h3>Windows file locks</h3>
            <ul>
              <li>
                Errors such as <code>EPERM</code>, <code>EBUSY</code> or <code>EACCES</code> during
                install mean another program has a file open (an editor, an agent, antivirus or a
                search indexer).
              </li>
              <li>
                The engine retries for a few seconds, then stops and names the path. Nothing is left
                half-written: close the program holding the file and run the command again.
              </li>
              <li>
                If the process was killed mid-install, the next agenthub command finishes or undoes
                the interrupted transaction and tells you what it did.
              </li>
            </ul>
            <p className="mt-6">
              Still stuck? <Link href="/">Search the registry</Link> or run{' '}
              <code>agenthub doctor --json</code> and include the output when you ask for help.
            </p>
          </section>
        </article>
      </div>
    </div>
  );
}
