/**
 * A real machine in a temporary folder for interactive-mode tests: a project, a home folder,
 * agenthub state, and a file registry packed from the test fixtures with the real CLI.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixturePath, versionFixturePath } from '@agenthub/test-fixtures';
import type { Runtime } from '../../src/context';
import { run } from '../../src/program';
import { Session } from '../../src/tui/session';

export interface World {
  base: string;
  project: string;
  registry: string;
  env: Record<string, string>;
  session(): Session;
  dispose(): Promise<void>;
}

function quiet() {
  const chunks: string[] = [];
  return { isTTY: false, write: (c: string) => chunks.push(c) > 0, text: () => chunks.join('') };
}

export async function createWorld(): Promise<World> {
  const base = await mkdtemp(join(tmpdir(), 'agenthub-tui-'));
  const project = join(base, 'project');
  const registry = join(base, 'registry');
  const home = join(base, 'home');
  const state = join(base, 'state');
  await mkdir(join(project, '.git'), { recursive: true });
  await mkdir(registry, { recursive: true });
  await mkdir(home, { recursive: true });
  const env: Record<string, string> = {
    AGENTHUB_HOME: state,
    AGENTHUB_USER_HOME: home,
    AGENTHUB_AGENTS: 'claude-code,codex:medium,cursor,vscode:low',
    AGENTHUB_REGISTRY: `file:${registry}`,
  };
  const runtime = (): Runtime => ({
    cwd: project,
    env,
    stdout: quiet(),
    stderr: quiet(),
    stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
  });
  const packs: [string, string, string][] = [
    [fixturePath('web-testing'), 'web-testing', '1.0.0'],
    [versionFixturePath('expanding', 'web-testing'), 'web-testing', '2.0.0'],
    [fixturePath('hello-skill'), 'hello-skill', '1.0.0'],
    [fixturePath('complex-benign'), 'complex-benign', '1.4.0'],
    [fixturePath('prompt-injection'), 'prompt-injection', '0.3.0'],
    [fixturePath('download-exec'), 'download-exec', '1.0.0'],
  ];
  for (const [dir, name, version] of packs) {
    const out = join(registry, `${name}-${version}.skillpkg`);
    const rt = runtime();
    const code = await run(['pack', dir, '-o', out, '--version', version, '--json'], rt);
    if (code !== 0)
      throw new Error(`pack ${name} failed: ${(rt.stdout as ReturnType<typeof quiet>).text()}`);
  }
  return {
    base,
    project,
    registry,
    env,
    session: () => new Session({ runtime: runtime(), global: false, color: true }),
    dispose: () => rm(base, { recursive: true, force: true }),
  };
}
