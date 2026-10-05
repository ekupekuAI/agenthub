// Bundles the CLI into a single executable ESM file: dist/agenthub.mjs.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));

/**
 * Ink loads react-devtools-core only when DEV=true; it is an optional peer that is never
 * installed. Resolve it to an inert module so the bundle has no dangling import.
 */
const noDevtools = {
  name: 'no-react-devtools',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'agenthub-stub',
    }));
    b.onLoad({ filter: /.*/, namespace: 'agenthub-stub' }, () => ({
      contents:
        "const unavailable = () => { throw new Error('React DevTools is not bundled with agenthub'); };\nexport default { initialize: unavailable, connectToDevTools: unavailable };",
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: [join(here, 'src', 'bin.ts')],
  outfile: join(here, 'dist', 'agenthub.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  jsx: 'automatic',
  plugins: [noDevtools],
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    ].join('\n'),
  },
  define: {
    __AGENTHUB_VERSION__: JSON.stringify(pkg.version),
    // React's production build: no development checks, smaller and faster.
    'process.env.NODE_ENV': '"production"',
  },
  legalComments: 'none',
  logLevel: 'warning',
});
