/**
 * Mocha `json` reporter parser.
 *
 * Shape: `{ stats, tests|results: [...], passes: [...], failures: [...], pending: [...] }`
 * where every test carries `{ title, fullTitle, file, duration, err }`.
 * (Mocha's own reporter emits the all-tests array under `tests`; some tooling renames it
 * `results` — both are accepted.)
 *
 * Status is determined by membership: a test found in `failures` is 'fail', in `pending`
 * is 'skip', in `passes` is 'pass' (checked in that order). Membership is matched on
 * (file, fullTitle) as a multiset — each bucket entry is consumed by one test — so two
 * same-titled tests in different files (or twice in one file) do not share one verdict.
 * As a last resort the test's own `state` field is consulted; default 'pass'.
 *
 * Hook failures (`"before all" hook for "x"` …) appear in `failures` but not in `tests` —
 * the tests they guard never run. Every `failures` entry no test consumed is emitted as a
 * failure of its own, named after the hook without the variable ` for "<first test>"`
 * suffix (e.g. `"before all" hook`, suite = its describe chain), plus one warning.
 *
 * suite = fullTitle with the title stripped (the describe chain), else `file`, else 'unknown'.
 * err.message trimmed to 2000 chars; err.stack trimmed to 1000 chars.
 *
 * Never throws: malformed input produces warnings.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, isObj, stripBom, trimTo } from './internal.js';

/** Match key: (file, fullTitle); empty when the entry has no fullTitle (unmatchable). */
function keyOf(entry: Record<string, unknown>): string {
  const fullTitle = typeof entry.fullTitle === 'string' ? entry.fullTitle.trim() : '';
  if (fullTitle === '') return '';
  const file = typeof entry.file === 'string' ? entry.file.trim() : '';
  return `${file}\u0000${fullTitle}`;
}

/** A status bucket (passes/failures/pending) as consumable queues per key. */
function bucket(arr: unknown[]): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const entry of arr) {
    if (!isObj(entry)) continue;
    const key = keyOf(entry);
    if (key === '') continue;
    const queue = map.get(key);
    if (queue) queue.push(entry);
    else map.set(key, [entry]);
  }
  return map;
}

/** Remove and report one entry for `key` from a bucket. */
function consume(b: Map<string, Record<string, unknown>[]>, key: string): boolean {
  if (key === '') return false;
  const queue = b.get(key);
  if (queue === undefined || queue.length === 0) return false;
  queue.shift();
  return true;
}

const HOOK_TITLE = /^"(?:before|after) (?:all|each)" hook\b/;

/** `"before all" hook for "queries"` → `"before all" hook` (the suffix names whichever test ran first). */
function hookName(title: string): string {
  return title.replace(/ (?:for|in) ".*"$/, '');
}

/** Suite = describe chain (fullTitle minus title), falling back to the source file. */
function deriveSuite(entry: Record<string, unknown>, title: string, fullTitle: string): string {
  if (fullTitle !== '' && fullTitle !== title && fullTitle.endsWith(title)) {
    const chain = fullTitle.slice(0, fullTitle.length - title.length).trim();
    if (chain !== '') return chain;
  }
  if (typeof entry.file === 'string' && entry.file.trim() !== '') {
    return entry.file.trim().replace(/\\/g, '/');
  }
  return fullTitle !== '' ? fullTitle : 'unknown';
}

function tryParseJson(content: string): { doc: unknown } | { error: string } {
  try {
    return { doc: JSON.parse(stripBom(content)) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export const mochaParser: ReportParser = {
  name: 'mocha',

  sniff(content: string): boolean {
    const parsed = tryParseJson(content);
    if (!('doc' in parsed)) return false;
    const doc = parsed.doc;
    if (!isObj(doc)) return false;
    const hasTestList = Array.isArray(doc.results) || Array.isArray(doc.tests);
    if (hasTestList && doc.stats !== undefined) return true;
    return Array.isArray(doc.passes) && Array.isArray(doc.failures);
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];

    const parsed = tryParseJson(content);
    if (!('doc' in parsed)) {
      return { results, warnings: [`mocha: ${sourcePath}: invalid JSON: ${parsed.error}`] };
    }
    const doc = parsed.doc;
    if (!isObj(doc)) {
      return { results, warnings: [`mocha: ${sourcePath}: not a JSON object`] };
    }

    const passes = Array.isArray(doc.passes) ? doc.passes : [];
    const failures = Array.isArray(doc.failures) ? doc.failures : [];
    const pending = Array.isArray(doc.pending) ? doc.pending : [];
    const testList = Array.isArray(doc.results)
      ? doc.results
      : Array.isArray(doc.tests)
        ? doc.tests
        : null;
    if (testList === null && !Array.isArray(doc.passes) && !Array.isArray(doc.failures)) {
      return { results, warnings: [`mocha: ${sourcePath}: missing "tests"/"results" array`] };
    }

    const entries: Record<string, unknown>[] = [];
    const statuses: Array<TestStatus | null> = [];
    const add = (entry: unknown, status: TestStatus | null): void => {
      if (!isObj(entry)) {
        warnings.push(`mocha: ${sourcePath}: skipping non-object test entry`);
        return;
      }
      entries.push(entry);
      statuses.push(status);
    };
    if (testList === null) {
      // passes/failures-only shape (sniff accepts it): each bucket entry IS a
      // test, and its bucket is its status
      for (const entry of passes) add(entry, 'pass');
      for (const entry of failures) add(entry, 'fail');
      for (const entry of pending) add(entry, 'skip');
    } else {
      const failBucket = bucket(failures);
      const pendingBucket = bucket(pending);
      const passBucket = bucket(passes);
      for (const entry of testList) {
        if (!isObj(entry)) {
          add(entry, null);
          continue;
        }
        const key = keyOf(entry);
        if (consume(failBucket, key)) add(entry, 'fail');
        else if (consume(pendingBucket, key)) add(entry, 'skip');
        else if (consume(passBucket, key)) add(entry, 'pass');
        else if (entry.state === 'failed') add(entry, 'fail');
        else if (entry.state === 'pending') add(entry, 'skip');
        else add(entry, null);
      }
      // failures no test consumed: hook failures (the tests they guard never ran)
      for (const queue of failBucket.values()) for (const leftover of queue) add(leftover, 'fail');
    }

    const hooks: string[] = [];
    for (let n = 0; n < entries.length; n++) {
      const entry = entries[n]!;
      const fullTitle = typeof entry.fullTitle === 'string' ? entry.fullTitle.trim() : '';
      const title =
        typeof entry.title === 'string' && entry.title.trim() !== ''
          ? entry.title.trim()
          : fullTitle !== ''
            ? fullTitle
            : '(unnamed)';

      const finalStatus: TestStatus = statuses[n] ?? 'pass';

      const suite = deriveSuite(entry, title, fullTitle);
      const isHook = HOOK_TITLE.test(title);
      const name = isHook ? hookName(title) : title;
      if (isHook && finalStatus === 'fail') hooks.push(`${suite} ${name}`);
      const durationMs =
        typeof entry.duration === 'number' && Number.isFinite(entry.duration)
          ? entry.duration
          : null;

      const result: TestCaseResult = {
        testId: makeTestId(suite, name),
        suite,
        name,
        status: finalStatus,
        durationMs,
      };

      const err = entry.err;
      if (typeof err === 'string') {
        const message = trimTo(err, 2000);
        if (message !== undefined) result.message = message;
      } else if (isObj(err) && Object.keys(err).length > 0) {
        const message = trimTo(err.message, 2000);
        const stack = trimTo(err.stack, 1000);
        if (message !== undefined) result.message = message;
        if (stack !== undefined) result.stack = stack;
      }
      results.push(result);
    }
    if (hooks.length > 0) {
      warnings.push(
        `mocha: ${sourcePath}: ${hooks.length} hook failure(s) — the tests they guard did not run; recorded as failures: ${hooks.join(', ')}`,
      );
    }
    return { results, warnings };
  },
};
