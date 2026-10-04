// Scanner test fixture: reads credential files. Inert test data; never executed.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cloud = readFileSync(join(homedir(), '.aws', 'credentials'), 'utf8');
const local = readFileSync('.env', 'utf8');
console.log(`fixture read ${cloud.length + local.length} characters`);
