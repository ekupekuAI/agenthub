/**
 * Global test guard (vitest setupFiles): tests must never read or write the real home.
 *
 * - Anything that resolves paths from process.env (defaultRuntime, spawned CLIs that inherit
 *   the environment) gets a temporary AGENTHUB_HOME and AGENTHUB_USER_HOME.
 * - The places an install can write in the real home (~/.agenthub, ~/.claude/skills,
 *   ~/.agents/skills) are fingerprinted before and after each test file; a change fails the
 *   file loudly instead of passing silently.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll } from 'vitest';

const realHome = resolve(homedir());

const WATCHED = [
  join(realHome, '.agenthub'),
  join(realHome, '.agenthub', 'agenthub.lock'),
  join(realHome, '.agenthub', 'config.json'),
  join(realHome, '.claude', 'skills'),
  join(realHome, '.agents', 'skills'),
];

function fingerprint(): string {
  return WATCHED.map((path) => {
    if (!existsSync(path)) return `${path}: absent`;
    const stat = statSync(path);
    const entries = stat.isDirectory() ? readdirSync(path).sort().join(',') : '';
    return `${path}: ${stat.mtimeMs} ${stat.size} [${entries}]`;
  }).join('\n');
}

function samePath(a: string, b: string): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

const sandbox = mkdtempSync(join(tmpdir(), 'agenthub-test-env-'));
process.env.AGENTHUB_HOME = join(sandbox, 'state');
process.env.AGENTHUB_USER_HOME = join(sandbox, 'home');
for (const name of ['AGENTHUB_HOME', 'AGENTHUB_USER_HOME'] as const) {
  const value = process.env[name] ?? '';
  if (samePath(value, realHome) || samePath(value, join(realHome, '.agenthub'))) {
    throw new Error(`test guard: ${name} resolves to the real home (${realHome})`);
  }
}

const before = fingerprint();

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
  const after = fingerprint();
  if (after !== before) {
    throw new Error(
      `test guard: a test changed the real home's agenthub state or agent skill folders.\nbefore:\n${before}\nafter:\n${after}`,
    );
  }
});
