import { AgentHubError } from '@agenthub/core';
import { cleanup } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expandingPlan,
  fakeSession,
  finding,
  KEY,
  makePlan,
  plain,
  press,
  renderApp,
  waitFor,
} from './helpers';

afterEach(() => cleanup());

const planned = (plan: ReturnType<typeof makePlan>) => ({
  planInstall: async () => ({ value: plan, ms: 120 }),
  planUpdate: async () => ({ value: { plan, sourceChange: null }, ms: 120 }),
});

describe('install flow', () => {
  it('shows the plan and installs after y', async () => {
    const session = fakeSession(planned(makePlan()));
    const app = renderApp(session, { kind: 'install', target: 'web-testing' });
    const frame = await waitFor(app.lastFrame, (t) => t.includes('[Y/n]'));
    expect(frame).toContain('INSTALL PLAN');
    expect(frame).toContain('web-testing');
    expect(frame).toContain('.claude/skills/web-testing');
    expect(frame).toContain('Install web-testing 1.2.0?');
    await press(app.stdin, 'y');
    const done = await waitFor(app.lastFrame, (t) => t.includes('committed in'));
    expect(session.calls.apply).toHaveLength(1);
    expect(session.calls.apply[0]?.[1]).toBe('plan');
    expect(done).toContain('Installed web-testing 1.2.0');
    expect(done).toContain('start a new session');
  });

  it('defaults to No when the plan has WARN findings', async () => {
    const plan = makePlan({
      policy: { findings: [finding('WARN')], outcome: 'confirm' },
      needsConfirmation: true,
    });
    const session = fakeSession(planned(plan));
    const app = renderApp(session, { kind: 'install', target: 'web-testing' });
    const frame = await waitFor(app.lastFrame, (t) => t.includes('[y/N]'));
    expect(frame).toContain('WARN');
    expect(frame).toContain('scripts/setup.sh:12');
    await press(app.stdin, KEY.enter);
    await waitFor(app.lastFrame, (t) => t.includes('Cancelled — nothing was changed.'));
    expect(session.calls.apply).toHaveLength(0);
  });

  it('shows a blocked card with the rule and file:line, and never applies', async () => {
    const plan = makePlan({
      policy: { findings: [finding('BLOCK')], outcome: 'block' },
      blockers: [
        {
          code: 'POLICY_BLOCKED',
          message: 'web-testing is blocked by policy (exec.download-pipe)',
        },
      ],
    });
    const session = fakeSession(planned(plan));
    const app = renderApp(session, { kind: 'install', target: 'web-testing' });
    const frame = await waitFor(app.lastFrame, (t) => t.includes('Nothing was written.'));
    expect(frame).toContain('BLOCKED');
    expect(frame).toContain('exec.download-pipe');
    expect(frame).toContain('scripts/setup.sh:12');
    expect(frame).toContain('[POLICY_BLOCKED]');
    expect(frame).not.toContain('[Y/n]');
    await press(app.stdin, 'y', KEY.enter);
    expect(session.calls.apply).toHaveLength(0);
  });

  it('never treats y as a capability approval; a then y approves explicitly', async () => {
    const plan = expandingPlan();
    const session = fakeSession(planned(plan));
    const app = renderApp(session, { kind: 'update-flow', name: 'web-testing' });
    const frame = await waitFor(app.lastFrame, (t) => t.includes('need your explicit approval'));
    expect(frame).toContain('NEW CAPABILITIES');
    expect(frame).toContain('network  collect.example.invalid');
    expect(frame).toContain('exec     curl');
    expect(frame).toContain('This update can do more than the version you approved');

    await press(app.stdin, 'y');
    await waitFor(app.lastFrame, (t) => t.includes('does not approve new capabilities'));
    await press(app.stdin, KEY.enter);
    expect(session.calls.apply).toHaveLength(0);

    await press(app.stdin, 'a');
    const ask = await waitFor(app.lastFrame, (t) => t.includes('[y/N]'));
    expect(ask).toContain('Approve 2 new capabilities and update web-testing 1.2.0 → 2.0.0?');
    await press(app.stdin, 'y');
    await waitFor(app.lastFrame, (t) => t.includes('committed in'));
    expect(session.calls.apply).toHaveLength(1);
    expect(session.calls.apply[0]?.[1]).toBe('capabilities');
    // One key to roll back from the result.
    expect(plain(app.lastFrame())).toContain('r roll back');
  });

  it('declining the capability question changes nothing', async () => {
    const session = fakeSession(planned(expandingPlan()));
    const app = renderApp(session, { kind: 'update-flow', name: 'web-testing' });
    await waitFor(app.lastFrame, (t) => t.includes('need your explicit approval'));
    await press(app.stdin, 'a');
    await waitFor(app.lastFrame, (t) => t.includes('[y/N]'));
    await press(app.stdin, KEY.enter);
    await waitFor(app.lastFrame, (t) => t.includes('Cancelled — nothing was changed.'));
    expect(session.calls.apply).toHaveLength(0);
  });

  it('names the exact problem when planning fails', async () => {
    const session = fakeSession({
      planInstall: async () => {
        throw new AgentHubError('NOT_FOUND', 'skill "nope" not found in file:/tmp/registry');
      },
    });
    const app = renderApp(session, { kind: 'install', target: 'nope' });
    const frame = await waitFor(app.lastFrame, (t) => t.includes('NOT_FOUND'));
    expect(frame).toContain('INSTALL PLAN FAILED');
    expect(frame).toContain('skill "nope" not found in file:/tmp/registry');
  });
});

describe('session gate', () => {
  it('refuses an expansion confirmed with a plain yes, and blocked plans, before touching the engine', async () => {
    const { Session } = await import('../../src/tui/session');
    const session = new Session({
      runtime: {
        // Temp folders from the test guard (test/setup.ts); the gate refuses before any engine use.
        cwd: process.env.AGENTHUB_USER_HOME ?? '',
        env: {
          AGENTHUB_HOME: process.env.AGENTHUB_HOME,
          AGENTHUB_USER_HOME: process.env.AGENTHUB_USER_HOME,
        },
        stdout: { write: () => true },
        stderr: { write: () => true },
        stdin: process.stdin,
      },
      global: false,
      color: false,
    });
    await expect(session.apply(expandingPlan(), 'plan')).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    const blocked = makePlan({ blockers: [{ code: 'POLICY_BLOCKED', message: 'blocked' }] });
    await expect(session.apply(blocked, 'capabilities')).rejects.toMatchObject({
      code: 'POLICY_BLOCKED',
    });
  });
});

describe('untrusted text on screen', () => {
  it('strips terminal escapes from registry data before rendering', async () => {
    const esc = '\u001b';
    const session = fakeSession({
      search: async () => ({
        value: {
          registry: 'file:/tmp/registry',
          results: [
            {
              slug: 'evil',
              name: 'evil',
              summary: `innocent${esc}]8;;https://x.invalid${String.fromCharCode(7)}link${esc}[2J\u202Egnp.exe`,
              latestVersion: `1.0.0${esc}[31m`,
              agents: ['claude-code'],
              scanOutcome: 'allow',
            },
          ],
        },
        ms: 5,
      }),
    });
    const app = renderApp(session, { kind: 'search', query: 'evil' });
    await waitFor(app.lastFrame, (t) => t.includes('innocent'));
    // Only our own color sequences may remain (none without colors): no OSC hyperlink, no
    // screen clear, no bell, no bidi override.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
    const raw = (app.lastFrame() ?? '').replace(/\u001b\[[0-9;]*m/g, '');
    expect(raw).not.toContain(esc);
    expect(raw).not.toContain('\u202E');
    expect(raw).not.toContain(String.fromCharCode(7));
  });
});

describe('palette', () => {
  it('opens on /, filters, moves with arrows and completes with tab', async () => {
    const session = fakeSession();
    const app = renderApp(session, { kind: 'home' });
    await waitFor(app.lastFrame, (t) => t.includes('Type / for commands'));
    await press(app.stdin, '/');
    let frame = await waitFor(app.lastFrame, (t) => t.includes('COMMANDS'));
    expect(frame).toContain('/search');
    expect(frame).toContain('1/17');
    await press(app.stdin, 'u', 'p');
    frame = await waitFor(app.lastFrame, (t) => t.includes('/update') && t.includes('1/1 '));
    await press(app.stdin, KEY.tab);
    frame = await waitFor(app.lastFrame, (t) => t.includes('› /update'));
    expect(frame).toContain('installed skills');
    expect(frame).toContain('web-testing');
  });

  it('runs a command from the palette and goes back with esc', async () => {
    const session = fakeSession({ list: async () => [] });
    const app = renderApp(session, { kind: 'home' });
    await waitFor(app.lastFrame, (t) => t.includes('Type / for commands'));
    await press(app.stdin, '/', 'l', 'i', 's', KEY.enter);
    await waitFor(app.lastFrame, (t) => t.includes('No skills installed.'));
    await press(app.stdin, KEY.esc);
    await waitFor(app.lastFrame, (t) => t.includes('START'));
  });

  it('shows help on ? and quits with q q on home', async () => {
    const session = fakeSession();
    let exited = false;
    const app = renderApp(session, { kind: 'home' }, { onExit: () => (exited = true) });
    await waitFor(app.lastFrame, (t) => t.includes('Type / for commands'));
    await press(app.stdin, '?');
    await waitFor(app.lastFrame, (t) => t.includes('AGENTHUB_REDUCED_MOTION=1'));
    await press(app.stdin, KEY.esc);
    await waitFor(app.lastFrame, (t) => t.includes('START'));
    await press(app.stdin, 'q');
    await waitFor(app.lastFrame, (t) => t.includes('press q again to quit'));
    expect(exited).toBe(false);
    await press(app.stdin, 'q');
    expect(exited).toBe(true);
  });
});
