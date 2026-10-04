// Summarises a saved `npm audit --json` report. Reads one local file; no network, no writes.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node audit-summary.mjs <audit-report.json>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(file, 'utf8'));
const counts = report.metadata?.vulnerabilities ?? {};
console.log('Vulnerabilities by severity:');
for (const level of ['critical', 'high', 'moderate', 'low', 'info']) {
  console.log(`  ${level.padEnd(9)} ${counts[level] ?? 0}`);
}

const direct = Object.values(report.vulnerabilities ?? {}).filter((v) => v.isDirect);
if (direct.length > 0) {
  console.log('\nDirect dependencies affected:');
  for (const v of direct) {
    const fix = v.fixAvailable ? 'fix available' : 'no fix yet';
    console.log(`  ${v.name} (${v.severity}, ${fix})`);
  }
}
