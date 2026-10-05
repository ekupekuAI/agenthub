import type { TerminalScenario } from '../ui';

/**
 * Hero terminal sessions. The output is copied from real CLI runs against the starter
 * registry; the Terminal draws the `$`, the INFO/BLOCK tags and the check marks itself.
 */
export const HERO_SCENARIOS: TerminalScenario[] = [
  {
    id: 'install',
    label: 'install',
    summary:
      'Installing web-testing 1.3.0: the plan writes two folders, one declared shell command is reported, the node runtime check passes and the skill is installed into four agents.',
    lines: [
      { kind: 'command', text: 'agenthub install web-testing' },
      { kind: 'out', text: 'Plan  web-testing 1.3.0  sha256:e22530ce451e' },
      { kind: 'out', text: '+ .agents/skills/web-testing  → codex, cursor, vscode' },
      { kind: 'out', text: '+ .claude/skills/web-testing  → claude-code, cursor, vscode' },
      { kind: 'info', text: 'exec.shell  scripts/run.sh:6  npx playwright test (declared)' },
      { kind: 'ok', text: 'runtime node >=22 (found 24.19.0)' },
      { kind: 'ok', text: 'Installed web-testing 1.3.0 into 4 agents' },
    ],
  },
  {
    id: 'blocked',
    label: 'blocked',
    summary:
      'Installing secret-reader is blocked: two undeclared reads of credential files are found, the install exits with code 3 and nothing is written.',
    lines: [
      { kind: 'command', text: 'agenthub install secret-reader' },
      {
        kind: 'block',
        text: 'secrets.read  scripts/collect.mjs:6  reads ~/.aws/credentials (undeclared)',
      },
      { kind: 'block', text: 'secrets.read  scripts/collect.mjs:7  reads .env (undeclared)' },
      { kind: 'error', text: '✘ blocked by policy · exit 3' },
      { kind: 'dim', text: 'nothing was written' },
    ],
  },
  {
    id: 'rollback',
    label: 'rollback',
    summary:
      'Updating web-testing from 1.0.0 to 1.1.0 saves a snapshot and swaps two folders; rolling back restores 1.0.0.',
    lines: [
      { kind: 'command', text: 'agenthub update --check' },
      { kind: 'out', text: 'web-testing  1.0.0 → 1.1.0 available' },
      { kind: 'command', text: 'agenthub update web-testing' },
      { kind: 'out', text: 'snapshot saved · 2 folders swapped · verified' },
      { kind: 'command', text: 'agenthub rollback web-testing' },
      { kind: 'ok', text: 'Restored web-testing 1.0.0' },
    ],
  },
];
