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
 * 5. tap   — first non-empty line is `TAP version N`, or headerless TAP12 that opens with a
 *            plan / numbered assertion and whose first 50 lines are all TAP-shaped
 * 6. trx   — trimmed content starts with '<' and contains a `<TestRun` element
 * 7. otherwise null. Never throws.
 *
 * A leading byte-order mark (U+FEFF — a UTF-8 BOM, or what remains of a UTF-16 one after
 * decoding) is stripped here, centrally, before any parser sniffs or parses the content.
 */
import type { ReportParser } from '../types.js';
import { goTestParser } from './gotest.js';
import { stripBom } from './internal.js';
import { jestParser } from './jest.js';
import { junitParser } from './junit.js';
import { mochaParser } from './mocha.js';
import { tapParser } from './tap.js';
import { trxParser } from './trx.js';

/** The parser with BOM stripping in front of sniff and parse. */
function bomTolerant(parser: ReportParser): ReportParser {
  return {
    name: parser.name,
    sniff: (content) => parser.sniff(stripBom(content)),
    parse: (content, sourcePath) => parser.parse(stripBom(content), sourcePath),
  };
}

export const parsers: ReportParser[] = [
  junitParser,
  jestParser,
  mochaParser,
  goTestParser,
  tapParser,
  trxParser,
].map(bomTolerant);

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
