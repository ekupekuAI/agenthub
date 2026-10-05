/**
 * The interactive mode against the real engine: a file registry packed from the fixtures, a
 * temporary project, every write going through the same transaction code as the classic CLI.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup } from 'ink-testing-library';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { KEY, plain, press, renderApp, waitFor } from './helpers';
import { createWorld, type World } from './world';

let world: World;

beforeAll(async () => {
  world = await createWorld();
}, 60_000);

afterAll(async () => {
  await world?.dispose();
});

afterEach(() => cleanup());

const LONG = 20_000;

describe('interactive mode on a real engine', () => {
  it('searches, opens the detail and installs from it', async () => {
    const app = renderApp(world.session(), { kind: 'search', query: 'web' });
    let frame = await waitFor(
      app.lastFrame,
      (t) => t.includes('web-testing') && t.includes('result'),
      LONG,
    );
    expect(frame).toContain('Search');
    await press(app.stdin, KEY.enter);
    frame = await waitFor(app.lastFrame, (t) => t.includes('TRUST RECEIPT'), LONG);
    expect(frame).toMatch(/sha256:[0-9a-f]{12}/);
    expect(frame).toContain('not installed');
    await press(app.stdin, KEY.enter);
    frame = await waitFor(app.lastFrame, (t) => t.includes('Install web-testing 2.0.0?'), LONG);
    expect(frame).toContain('.claude/skills/web-testing');
    expect(frame).toContain('.agents/skills/web-testing');
    await press(app.stdin, 'y');
    frame = await waitFor(app.lastFrame, (t) => t.includes('committed in'), LONG);
    expect(frame).toContain('Installed web-testing 2.0.0');
    expect(existsSync(join(world.project, '.claude', 'skills', 'web-testing', 'SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(join(world.project, '.agenthub', 'agenthub.lock'))).toBe(true);
  }, 60_000);

  it('blocks a skill the policy refuses and writes nothing', async () => {
    const app = renderApp(world.session(), { kind: 'install', target: 'download-exec' });
    const frame = await waitFor(app.lastFrame, (t) => t.includes('Nothing was written.'), LONG);
    expect(frame).toContain('BLOCK');
    expect(frame).toMatch(/net\.download-exec|exec\.shell/);
    await press(app.stdin, 'y');
    expect(existsSync(join(world.project, '.claude', 'skills', 'download-exec'))).toBe(false);
  }, 60_000);

  it('lists the installed skill with its approval, and verifies it', async () => {
    const app = renderApp(world.session(), { kind: 'list' });
    let frame = await waitFor(
      app.lastFrame,
      (t) => t.includes('Installed') && t.includes('web-testing'),
      LONG,
    );
    expect(frame).toContain('approved');
    await press(app.stdin, 'v');
    frame = await waitFor(app.lastFrame, (t) => t.includes('everything matches the lock'), LONG);
    expect(plain(frame)).toContain('web-testing 2.0.0');
  }, 60_000);

  it('runs the doctor checks', async () => {
    const app = renderApp(world.session(), { kind: 'doctor' });
    const frame = await waitFor(
      app.lastFrame,
      (t) => t.includes('Requirements') && t.includes('Approvals'),
      LONG,
    );
    expect(frame).toContain('Agents');
    expect(frame).toContain('4 detected');
  }, 60_000);
});
