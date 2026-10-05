// Bundles the CLI into a single executable ESM file: dist/agenthub.mjs.
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));

/** The public registry release builds use when nothing else is configured. */
const PUBLIC_REGISTRY = 'https://agenthub-registry.vercel.app';

/**
 * AGENTHUB_DEFAULT_REGISTRY overrides the built-in default registry: a URL or file:<folder>,
 * or "none" (tests and dev builds) for no default at all.
 */
function defaultRegistry() {
  const raw = process.env.AGENTHUB_DEFAULT_REGISTRY;
  if (raw === undefined) return PUBLIC_REGISTRY;
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'none') return '';
  if (!/^(https?:\/\/|file:)/i.test(value)) {
    throw new Error(`AGENTHUB_DEFAULT_REGISTRY must be https://…, file:<folder> or none: ${value}`);
  }
  return value;
}

/** `--outfile <path>` builds somewhere other than dist/agenthub.mjs (tests). */
function outfile() {
  const at = process.argv.indexOf('--outfile');
  if (at === -1) return join(here, 'dist', 'agenthub.mjs');
  const value = process.argv[at + 1];
  if (value === undefined || value === '') throw new Error('--outfile needs a path');
  return resolve(value);
}

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
  outfile: outfile(),
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
    __AGENTHUB_DEFAULT_REGISTRY__: JSON.stringify(defaultRegistry()),
    // React's production build: no development checks, smaller and faster.
    'process.env.NODE_ENV': '"production"',
  },
  legalComments: 'none',
  logLevel: 'warning',
});
