// Bundles scripts/seed.ts into .data/seed.mjs with esbuild, then runs it with node.
// `--env-file <path>` (or `--env-file=<path>`) loads settings such as DATABASE_URL and
// BLOB_READ_WRITE_TOKEN from a file instead of the shell.
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
  external: ['@electric-sql/pglite', '@neondatabase/serverless', '@vercel/blob'],
  // Bundled CommonJS dependencies may call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __agenthubCreateRequire } from 'node:module'; const require = __agenthubCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

const nodeArgs = [];
const seedArgs = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--env-file' && args[i + 1]) {
    nodeArgs.push(`--env-file=${args[++i]}`);
  } else if (arg.startsWith('--env-file=')) {
    nodeArgs.push(arg);
  } else {
    seedArgs.push(arg);
  }
}

const result = spawnSync(process.execPath, [...nodeArgs, outfile, ...seedArgs], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
