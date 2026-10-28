/**
 * Parser registry + format auto-detection.
 *
 * Detection order (first match wins):
 * 1. junit — trimmed content starts with '<' and contains '<testsuit'
 * 2. jest  — whole document parses as a JSON object with testResults[] that is empty or has
 *            an entry with assertionResults
 * 3. mocha — whole document parses as JSON with (results/tests + stats) or (passes + failures)
 * 4. go    — one of the first 50 non-empty lines is a JSON event with Action plus Package or
 *            ImportPath (leading stderr text / go 1.24 build events are tolerated)
 * 5. tap   — first non-empty line is `TAP version N`
 * 6. trx   — trimmed content starts with '<' and contains a `<TestRun` element
 * 7. otherwise null. Never throws.
 */
import type { ReportParser } from '../types.js';
import { goTestParser } from './gotest.js';
import { jestParser } from './jest.js';
import { junitParser } from './junit.js';
import { mochaParser } from './mocha.js';
import { tapParser } from './tap.js';
import { trxParser } from './trx.js';

export const parsers: ReportParser[] = [
  junitParser,
  jestParser,
  mochaParser,
  goTestParser,
  tapParser,
  trxParser,
];

export function detectParser(content: string): ReportParser | null {
  for (const parser of parsers) {
    try {
      if (parser.sniff(content)) return parser;
    } catch {
      // sniff is contractually non-throwing; be defensive anyway and keep probing.
    }
  }
  return null;
}
