#!/usr/bin/env node
// Builds the report bundle and records the Node.js version used.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.env.COMPLEX_BENIGN_MODE ?? 'strict';
const version = execFileSync('node', ['--version'], { encoding: 'utf8' }).trim();
const outDir = join(process.cwd(), 'dist');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'report.json'), `${JSON.stringify({ mode, version }, null, 2)}\n`);
console.log(`report written with node ${version}`);
