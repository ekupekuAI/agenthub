// Lists Playwright spec files under a folder (default: tests). Read-only.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2] ?? 'tests';
const pattern = /\.(spec|test)\.(ts|js|mjs)$/;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (pattern.test(name)) console.log(full);
  }
}

walk(root);
