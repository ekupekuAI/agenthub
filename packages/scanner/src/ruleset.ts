/**
 * Identity of the scanner rules (trust features design §1.5). A capability approval is bound to
 * this digest: when the rules change, an approval recorded under the old rules is rechecked
 * against a fresh scan of the same bytes.
 *
 * Rule: any change to a pattern table, an analyzer or the externals extractor bumps
 * SCANNER_VERSION (or EXTRACTOR_VERSION); test/ruleset.test.ts fails when the fixture results
 * change without a bump.
 */
import { createHash } from 'node:crypto';
import { EXTRACTOR_VERSION } from './externals';
import { RULE_IDS } from './rules';

export const SCANNER_VERSION = '1.1.0';

function digestOf(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** 'sha256:<hex>' over the extractor version, the sorted rule ids and the scanner version. */
export const RULESET_DIGEST: string = digestOf(
  JSON.stringify({
    extractor: EXTRACTOR_VERSION,
    rules: [...RULE_IDS].sort(),
    scanner: SCANNER_VERSION,
  }),
);
