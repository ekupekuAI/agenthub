// Bundles scripts/seed.ts into .data/seed.mjs with esbuild, then runs it with node.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const entry = fileURLToPath(new URL('./seed.ts', import.meta.url));
const outfile = fileURLToPath(new URL('../.data/seed.mjs', import.meta.url));
mkdirSync(fileURLToPath(new URL('../.data/', import.meta.url)), { recursive: true });

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@electric-sql/pglite'],
  // Bundled CommonJS dependencies may call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __agenthubCreateRequire } from 'node:module'; const require = __agenthubCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

const result = spawnSync(process.execPath, [outfile], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
