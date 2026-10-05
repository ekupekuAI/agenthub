import type { InstallPlan } from '@agenthub/core';
import { describe, expect, it } from 'vitest';
import { CONFIRMATION_REQUIRED, confirmPlan, planWrites } from '../src/prompt';

function plan(overrides: Partial<InstallPlan> = {}): InstallPlan {
  return {
    id: 'p',
    skill: { name: 'demo', version: '1.0.0', digest: 'sha256:x' },
    source: { kind: 'dir', path: '/x' },
    scope: 'project',
    scopeRoot: '/p',
    agents: [],
    targets: [
      {
        dir: '.claude/skills',
        absDir: '/p/.claude/skills/demo',
        lockPath: '.claude/skills/demo',
        agents: ['claude-code'],
        action: 'create',
      },
    ],
    duplicates: [],
    policy: { outcome: 'allow', findings: [] },
    requirements: [],
    issues: [],
    blockers: [],
    needsConfirmation: false,
    hints: [],
    dev: false,
    force: false,
    ...overrides,
  } as InstallPlan;
}

describe('confirmPlan without a terminal (design §8.3)', () => {
  const stdin = { yes: false, json: false, stdin: { isTTY: false } as typeof process.stdin };

  it('requires --yes for a plan that writes even when it has no warnings', async () => {
    await expect(confirmPlan(plan(), 'Install?', stdin)).rejects.toMatchObject({
      code: 'USAGE',
      message: CONFIRMATION_REQUIRED,
    });
    await expect(
      confirmPlan(plan(), 'Install?', { ...stdin, json: true, stdin: { isTTY: true } as never }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });

  it('proceeds with --yes, and for plans that change nothing', async () => {
    await expect(confirmPlan(plan(), 'Install?', { ...stdin, yes: true })).resolves.toBeUndefined();
    const unchanged = plan();
    const first = unchanged.targets[0];
    if (first) first.action = 'unchanged';
    expect(planWrites(unchanged)).toBe(false);
    await expect(confirmPlan(unchanged, 'Install?', stdin)).resolves.toBeUndefined();
  });

  it('still requires --yes for an unchanged plan that needs confirmation', async () => {
    const unchanged = plan({ needsConfirmation: true });
    const first = unchanged.targets[0];
    if (first) first.action = 'unchanged';
    await expect(confirmPlan(unchanged, 'Install?', stdin)).rejects.toMatchObject({
      code: 'USAGE',
    });
  });
});
