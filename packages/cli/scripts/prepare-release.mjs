// Stages the npm package `@ekupekuai/agenthub` (command: `agenthub`) in packages/cli/release/: the bundled CLI, a package.json
// without dependencies (the bundle is self-contained), the npm README and the license.
//
//   npm run release:cli                 (from the repository root)
//   cd packages/cli/release && npm publish --access public
//
// The unscoped name `agenthub` is refused by npm (too similar to `agent-hub`).
// `node packages/cli/scripts/prepare-release.mjs --name <name>` stages the same package under
// another npm name; the command stays `agenthub`.
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(cliDir, '..', '..');
const releaseDir = join(cliDir, 'release');
const bundle = join(cliDir, 'dist', 'agenthub.mjs');

const SITE = 'https://agenthub-registry.vercel.app';
const REPO = 'https://github.com/ekupekuAI/agenthub';
const DEFAULT_NAME = '@ekupekuai/agenthub';

const source = JSON.parse(await readFile(join(cliDir, 'package.json'), 'utf8'));

function packageName() {
  const at = process.argv.indexOf('--name');
  if (at === -1) return DEFAULT_NAME;
  const name = process.argv[at + 1] ?? '';
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214) {
    throw new Error(`--name needs a valid npm package name, got "${name}"`);
  }
  return name;
}
const name = packageName();

// 1. Build. A release always carries the public default registry.
const env = { ...process.env };
if (env.AGENTHUB_DEFAULT_REGISTRY !== undefined) {
  console.warn('ignoring AGENTHUB_DEFAULT_REGISTRY: a release uses the public registry');
  delete env.AGENTHUB_DEFAULT_REGISTRY;
}
execFileSync(process.execPath, [join(cliDir, 'build.mjs')], { cwd: cliDir, env, stdio: 'inherit' });

// 2. Check the bundle: a shebang, the default registry, and no imports npm would have to
//    install (only Node built-ins).
const code = await readFile(bundle, 'utf8');
if (!code.startsWith('#!/usr/bin/env node\n')) throw new Error('bundle has no shebang');
if (!code.includes(JSON.stringify(SITE))) throw new Error(`bundle lacks the default ${SITE}`);
const specifiers = new Set();
for (const match of code.matchAll(/^\s*import\s[^'"]*?from\s*['"]([^'"]+)['"]/gm)) {
  specifiers.add(match[1]);
}
for (const match of code.matchAll(/\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
  specifiers.add(match[1]);
}
const external = [...specifiers].filter((name) => !isBuiltin(name));
if (external.length > 0) {
  throw new Error(`bundle imports packages that are not bundled: ${external.join(', ')}`);
}

// 3. Stage.
await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

const pkg = {
  name,
  version: source.version,
  description:
    'The package manager and trust layer for agent skills: install SKILL.md skills into Claude Code, Codex, Cursor and VS Code — scanned, capability-gated, reversible.',
  keywords: [
    'agent-skills',
    'skills',
    'skill.md',
    'claude-code',
    'codex',
    'cursor',
    'vscode',
    'copilot',
    'package-manager',
    'supply-chain-security',
    'cli',
  ],
  homepage: SITE,
  bugs: { url: `${REPO}/issues` },
  repository: { type: 'git', url: `git+${REPO}.git` },
  license: 'MIT',
  author: 'Ekansh',
  type: 'module',
  bin: { agenthub: 'agenthub.mjs' },
  files: ['agenthub.mjs', 'README.md', 'LICENSE'],
  engines: { node: '>=22' },
  ...(name.startsWith('@') ? { publishConfig: { access: 'public' } } : {}),
};

await writeFile(join(releaseDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
await copyFile(bundle, join(releaseDir, 'agenthub.mjs'));
await chmod(join(releaseDir, 'agenthub.mjs'), 0o755);
const readme = (await readFile(join(cliDir, 'README.md'), 'utf8'))
  .replaceAll(`npm install -g ${DEFAULT_NAME}`, `npm install -g ${name}`)
  .replaceAll(`npx ${DEFAULT_NAME}`, `npx ${name}`);
await writeFile(join(releaseDir, 'README.md'), readme);
await copyFile(join(repoRoot, 'LICENSE'), join(releaseDir, 'LICENSE'));

const kb = (code.length / 1024).toFixed(0);
console.log(`staged ${name}@${pkg.version} in ${releaseDir} (bundle ${kb} KiB)`);
console.log('publish with: cd packages/cli/release && npm publish --access public');
