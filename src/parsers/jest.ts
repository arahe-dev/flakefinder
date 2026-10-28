/**
 * Jest `--json` parser.
 *
 * Shape: `{ testResults: [ { name: <file>, status, message, assertionResults: [ {
 * status: 'passed'|'failed'|'pending'|'skipped'|'todo'|'disabled'|'focused', fullName, title,
 * ancestorTitles: string[], duration (ms), failureMessages: string[] } ] } ] }`
 * `{ "testResults": [] }` (e.g. `--passWithNoTests` on an empty tree) is jest with 0 results.
 *
 * Mapping:
 * - passed → 'pass', failed → 'fail'
 * - pending/skipped (vitest)/todo/disabled → 'skip'
 * - focused (a `.only`/`fit` test that ran) → 'fail' when it has failureMessages, else 'pass'
 * - suite = ancestorTitles.join(' > ') when non-empty, else the file path with forward slashes
 *   (NOTE: two files with the same describe+title collide on one testId — a known identity
 *   limitation, deliberately unchanged because ids are persisted in histories/quarantine files)
 * - name = title (fullName as fallback)
 * - durationMs = duration ?? null
 * - message = failureMessages[0] trimmed to 2000 chars
 *
 * Suite-level failures: a file whose status is 'failed' (or that carries testExecError) while
 * NONE of its assertions failed — a syntax error, no tests, or an afterAll/beforeAll that threw
 * after every test passed — emits one synthetic failure named '(suite)' (suite = file path)
 * with the file's message, so the failure jest exits non-zero for is not lost.
 *
 * Never throws: malformed input produces warnings.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, isObj, stripBom, toArray, trimTo } from './internal.js';

const SUITE_PLACEHOLDER = '(suite)';

function statusOf(status: unknown, failureMessages: unknown[]): TestStatus | null {
  switch (status) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'focused': // ran because it was focused; the outcome is in its failure messages
      return failureMessages.length > 0 ? 'fail' : 'pass';
    case 'pending':
    case 'skipped': // vitest's json reporter emits "skipped" (jest: "pending")
    case 'todo':
    case 'disabled': // excluded (xit / not selected by .only)
      return 'skip';
    default:
      return null;
  }
}

function tryParseJson(content: string): { doc: unknown } | { error: string } {
  try {
    return { doc: JSON.parse(stripBom(content)) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export const jestParser: ReportParser = {
  name: 'jest',

  sniff(content: string): boolean {
    const parsed = tryParseJson(content);
    if (!('doc' in parsed)) return false;
    const doc = parsed.doc;
    if (!isObj(doc) || !Array.isArray(doc.testResults)) return false;
    // an empty run (`--passWithNoTests`) is still a jest report — 0 results, no warnings
    if (doc.testResults.length === 0) return true;
    return doc.testResults.some((file) => isObj(file) && Array.isArray(file.assertionResults));
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];

    const parsed = tryParseJson(content);
    if (!('doc' in parsed)) {
      return { results, warnings: [`jest: ${sourcePath}: invalid JSON: ${parsed.error}`] };
    }
    const doc = parsed.doc;
    if (!isObj(doc) || !Array.isArray(doc.testResults)) {
      return { results, warnings: [`jest: ${sourcePath}: missing testResults[] array`] };
    }

    for (const file of doc.testResults) {
      if (!isObj(file)) {
        warnings.push(`jest: ${sourcePath}: skipping non-object entry in testResults[]`);
        continue;
      }
      const filePath =
        typeof file.name === 'string' && file.name.trim() !== ''
          ? file.name.replace(/\\/g, '/')
          : '(unknown file)';
      const assertions = toArray(file.assertionResults);
      let anyAssertionFailed = false;

      for (const assertion of assertions) {
        if (!isObj(assertion)) {
          warnings.push(`jest: ${sourcePath}: skipping non-object entry in assertionResults[]`);
          continue;
        }
        const failureMessages = toArray(assertion.failureMessages);
        const status = statusOf(assertion.status, failureMessages);
        if (status === null) {
          warnings.push(
            `jest: ${sourcePath}: unknown assertion status ${JSON.stringify(assertion.status)}`,
          );
          continue;
        }
        const ancestors = Array.isArray(assertion.ancestorTitles)
          ? assertion.ancestorTitles.filter(
              (title): title is string => typeof title === 'string' && title.trim() !== '',
            )
          : [];
        const suite = ancestors.length > 0 ? ancestors.join(' > ') : filePath;
        const name =
          typeof assertion.title === 'string' && assertion.title.trim() !== ''
            ? assertion.title
            : typeof assertion.fullName === 'string' && assertion.fullName.trim() !== ''
              ? assertion.fullName
              : '(unnamed)';
        const durationMs =
          typeof assertion.duration === 'number' && Number.isFinite(assertion.duration)
            ? assertion.duration
            : null;
        const message = trimTo(failureMessages[0], 2000);
        if (status === 'fail') anyAssertionFailed = true;

        const result: TestCaseResult = {
          testId: makeTestId(suite, name),
          suite,
          name,
          status,
          durationMs,
        };
        if (message !== undefined) result.message = message;
        results.push(result);
      }

      // Suite-level failure no assertion carries (file failed to run, or a
      // before/afterAll threw after every test passed): one synthetic test.
      const execError = isObj(file.testExecError) ? file.testExecError : undefined;
      if ((file.status === 'failed' || execError !== undefined) && !anyAssertionFailed) {
        const message =
          trimTo(file.message, 2000) ??
          trimTo(file.failureMessage, 2000) ??
          trimTo(execError?.message, 2000);
        const result: TestCaseResult = {
          testId: makeTestId(filePath, SUITE_PLACEHOLDER),
          suite: filePath,
          name: SUITE_PLACEHOLDER,
          status: 'fail',
          durationMs: null,
        };
        if (message !== undefined) result.message = message;
        results.push(result);
      }
    }
    return { results, warnings };
  },
};
