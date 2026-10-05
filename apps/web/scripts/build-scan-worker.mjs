// Bundles src/lib/scan-worker.ts with @agenthub/core and @agenthub/scanner into one
// self-contained file, dist/scan-worker.mjs. Runs before `next build` (the "prebuild" script);
// scan-runner.ts starts it as a worker thread in production, and next.config.ts ships it with
// every server function.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const entry = fileURLToPath(new URL('../src/lib/scan-worker.ts', import.meta.url));
const outfile = fileURLToPath(new URL('../dist/scan-worker.mjs', import.meta.url));

export async function buildScanWorker(target = outfile) {
  mkdirSync(path.dirname(target), { recursive: true });
  await build({
    entryPoints: [entry],
    outfile: target,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Everything, including npm dependencies, goes into the one file: a serverless function
    // bundle does not have to contain the monorepo sources or a resolvable node_modules tree.
    packages: 'bundle',
    // Bundled CommonJS dependencies may call require() for Node built-ins.
    banner: {
      js: "import { createRequire as __agenthubCreateRequire } from 'node:module'; const require = __agenthubCreateRequire(import.meta.url);",
    },
    legalComments: 'none',
    logLevel: 'warning',
  });
  return target;
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  const file = await buildScanWorker(process.argv[2] ?? outfile);
  console.log(`scan worker bundled: ${file}`);
}
