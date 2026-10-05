import type { ReactNode } from 'react';
import { type Decision, DecisionBadge, Table, TBody, TD, TH, THead, TR } from '../ui';

/** The three finding decisions, what they mean and what happens at install time. */
const LEGEND: readonly { decision: Decision; meaning: string; effect: string }[] = [
  {
    decision: 'INFO',
    meaning: 'Expected, declared behavior.',
    effect: 'Shown for transparency. Nothing to confirm.',
  },
  {
    decision: 'WARN',
    meaning: 'Risky behavior the skill did not declare, or a declared secret read.',
    effect: 'You must confirm. The prompt defaults to No.',
  },
  {
    decision: 'BLOCK',
    meaning: 'Dangerous behavior.',
    effect: 'The install stops, with exit code 3.',
  },
];

export function DecisionLegend() {
  return (
    <ul className="m-0 my-6 grid list-none gap-3 p-0 sm:grid-cols-3">
      {LEGEND.map((item) => (
        <li
          key={item.decision}
          className="flex flex-col gap-2.5 rounded-card border border-border bg-surface-1 p-4"
        >
          <DecisionBadge decision={item.decision} className="self-start" />
          <p className="text-small text-text">{item.meaning}</p>
          <p className="mt-auto text-[0.8125rem] text-muted leading-5">{item.effect}</p>
        </li>
      ))}
    </ul>
  );
}

/** A decision chip with a few words after it, e.g. "you confirm". */
function Verdict({ decision, children }: { decision: Decision; children?: ReactNode }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <DecisionBadge decision={decision} />
      {children ? <span className="text-[0.8125rem] text-muted">{children}</span> : null}
    </span>
  );
}

const POLICY: readonly {
  tier: string;
  examples: string;
  undeclared: { decision: Decision; note?: string };
  declared: { decision: Decision; note?: string };
}[] = [
  {
    tier: 'Medium risk',
    examples:
      'Network access, running programs, reading environment variables, installing packages at run time, suspicious instructions, unexpected binaries',
    undeclared: { decision: 'WARN', note: 'you confirm' },
    declared: { decision: 'INFO' },
  },
  {
    tier: 'High risk, declarable',
    examples: 'Reading credentials or secret files',
    undeclared: { decision: 'BLOCK' },
    declared: { decision: 'WARN', note: 'you confirm' },
  },
  {
    tier: 'Never allowed',
    examples:
      'Download-and-run, obfuscated payloads, dynamic code fed by network or encoded data, hidden instructions, persistence',
    undeclared: { decision: 'BLOCK' },
    declared: { decision: 'BLOCK', note: 'cannot be declared' },
  },
];

/** The install policy: what a finding becomes, depending on whether it was declared. */
export function PolicyTable() {
  return (
    <div className="my-6">
      <Table
        sticky={false}
        caption="Install policy: the decision for each kind of finding, undeclared and declared"
      >
        <THead>
          <TR>
            <TH>Finding</TH>
            <TH>Not declared</TH>
            <TH>Declared</TH>
          </TR>
        </THead>
        <TBody>
          {POLICY.map((row) => (
            <TR key={row.tier}>
              <TH scope="row" label="Finding">
                <span className="block text-text">{row.tier}</span>
                <span className="mt-1 block font-normal text-[0.8125rem] text-muted leading-5">
                  {row.examples}
                </span>
              </TH>
              <TD label="Not declared" className="sm:w-40">
                <Verdict decision={row.undeclared.decision}>{row.undeclared.note}</Verdict>
              </TD>
              <TD label="Declared" className="sm:w-48">
                <Verdict decision={row.declared.decision}>{row.declared.note}</Verdict>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

interface Rule {
  id: string;
  detects: string;
  undeclared: Decision;
  /** Decision when declared, or null when the rule can never be declared away. */
  declared: Decision | null;
  /** Where the declaration goes, or why the rule cannot be declared. */
  note: string;
}

const RULES: readonly Rule[] = [
  {
    id: 'exec.shell',
    detects: 'Running programs or shells: child_process, subprocess, os.system, sh -c',
    undeclared: 'WARN',
    declared: 'INFO',
    note: 'Declare the program in permissions.exec',
  },
  {
    id: 'net.access',
    detects: 'HTTP clients, sockets, curl, wget',
    undeclared: 'WARN',
    declared: 'INFO',
    note: 'Declare the host in permissions.network',
  },
  {
    id: 'net.download-exec',
    detects: 'Downloaded content piped into an interpreter or executed',
    undeclared: 'BLOCK',
    declared: null,
    note: 'Never declarable',
  },
  {
    id: 'secrets.read',
    detects: '.env files, cloud and SSH credentials, keychains, browser profiles',
    undeclared: 'BLOCK',
    declared: 'WARN',
    note: 'Declare the path in permissions.secrets',
  },
  {
    id: 'env.read',
    detects: 'Reading specific environment variables',
    undeclared: 'WARN',
    declared: 'INFO',
    note: 'Declare the variable in permissions.env',
  },
  {
    id: 'code.dynamic',
    detects: 'eval, new Function, executing strings',
    undeclared: 'WARN',
    declared: null,
    note: 'BLOCK when fed by network or encoded data',
  },
  {
    id: 'code.obfuscated',
    detects: 'Large encoded payloads decoded at run time, packed code',
    undeclared: 'BLOCK',
    declared: null,
    note: 'Never declarable',
  },
  {
    id: 'fs.persistence',
    detects: 'Shell startup files, scheduled tasks, startup folders, git hooks',
    undeclared: 'BLOCK',
    declared: null,
    note: 'Never declarable',
  },
  {
    id: 'deps.remote',
    detects: 'Installing packages or pulling code at run time',
    undeclared: 'WARN',
    declared: 'INFO',
    note: 'Declare the installer in permissions.exec',
  },
  {
    id: 'prompt.injection',
    detects: 'Instructions to ignore rules, hide actions, reveal secrets or disable approvals',
    undeclared: 'WARN',
    declared: null,
    note: 'Always reviewed by you',
  },
  {
    id: 'prompt.hidden',
    detects: 'Zero-width, bidirectional and tag characters; instructions in HTML comments',
    undeclared: 'BLOCK',
    declared: null,
    note: 'Never declarable',
  },
  {
    id: 'file.binary',
    detects: 'Executables and nested archives',
    undeclared: 'WARN',
    declared: null,
    note: 'Always reviewed by you',
  },
];

export const SCANNER_RULE_COUNT = RULES.length;

/** The twelve scanner rules with their default decision. */
export function RulesTable() {
  return (
    <div className="my-6">
      <Table sticky={false} caption="Scanner rules and their default decisions">
        <THead>
          <TR>
            <TH>Rule</TH>
            <TH>Detects</TH>
            <TH>Decision</TH>
          </TR>
        </THead>
        <TBody>
          {RULES.map((rule) => (
            <TR key={rule.id}>
              <TD label="Rule" mono className="whitespace-nowrap">
                {rule.id}
              </TD>
              <TD label="Detects" className="text-text">
                {rule.detects}
              </TD>
              <TD label="Decision" className="sm:w-56">
                <span className="flex flex-wrap items-center gap-1.5">
                  <DecisionBadge decision={rule.undeclared} />
                  {rule.declared ? (
                    <>
                      <span aria-hidden="true" className="text-subtle">
                        →
                      </span>
                      <span className="sr-only">, or when declared:</span>
                      <DecisionBadge decision={rule.declared} />
                    </>
                  ) : null}
                </span>
                <span className="mt-1.5 block text-[0.8125rem] text-muted leading-5">
                  {rule.note}
                </span>
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
