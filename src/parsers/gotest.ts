/**
 * `go test -json` NDJSON parser.
 *
 * Each line is an event: `{ Action: 'run'|'pause'|'pass'|'fail'|'skip'|'output'|…, Package,
 * Test?, Elapsed?, Time, Output? }`. (Field casing varies across Go versions: `Elapsed`/
 * `elapsed` and `Output`/`output` are both accepted.)
 *
 * Repeated runs (`-count=N`, or several streams concatenated): a 'run' event (or a second
 * terminal action) for a test that already finished starts a new run, and each run keeps its
 * own status, elapsed and output. One result per (Package, Test) is emitted, aggregated over
 * its runs, because the engine collapses same-testId rows within a report (last one wins):
 * - any run failed → 'fail', from the FIRST failing run (its output and duration). When other
 *   runs passed, the message starts with "flaky: failed k of n runs in this report" and one
 *   warning per file lists those tests. A failure is never erased by a later pass.
 * - otherwise the LAST run decides ('pass', or 'skip').
 * durationMs = round(elapsed * 1000) from the reported run's terminal event when present,
 * else null (older Go versions only put elapsed on package-level events).
 *
 * Messages are built from the reported run's 'output' events: ANSI SGR codes are stripped,
 * blank lines dropped, and the LAST 2000 characters of the joined text are kept (failure
 * details come at the end, after t.Log noise).
 *
 * Subtests: `TestA/sub` is emitted with its full name. A parent (`TestA`) that has subtests is
 * NOT emitted — its status only mirrors its children and would double-count their failures —
 * unless the parent itself failed while none of its descendants did (t.Error after t.Run, a
 * panic in the parent body); that failure exists nowhere else, so the parent row is kept.
 *
 * Package-level events (no Test) are ignored. Lines that fail JSON.parse produce warnings —
 * at most 5 individually, then a single '…and N more' summary.
 *
 * Never throws.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, firstNonEmptyLine, isObj, stripAnsi, stripBom } from './internal.js';

const MAX_MALFORMED_DETAILS = 5;
const MESSAGE_MAX_CHARS = 2000;

/** How many flaky test names one -count warning lists before summarising. */
const MAX_FLAKY_NAMES = 10;

/** One execution of a test (a `-count=N` stream holds N of these per test). */
interface RunState {
  status?: TestStatus;
  durationMs: number | null;
  outputs: string[];
}

interface TestAccumulator {
  pkg: string;
  test: string;
  /** Chronological runs; the last one is the run currently receiving events. */
  runs: RunState[];
}

function isFailFamily(status: TestStatus): boolean {
  return status === 'fail' || status === 'error';
}

function newRun(): RunState {
  return { durationMs: null, outputs: [] };
}

/** Elapsed seconds → ms; accepts both `Elapsed` and `elapsed` spellings. */
function elapsedToMs(ev: Record<string, unknown>): number | null {
  const raw = ev.elapsed !== undefined ? ev.elapsed : ev.Elapsed;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw * 1000);
}

/** Last meaningful chunk of a test's output events, trimmed to MESSAGE_MAX_CHARS. */
function messageFromOutputs(outputs: string[]): string | undefined {
  if (outputs.length === 0) return undefined;
  // Blank lines are dropped but per-line indentation is kept — a line like
  // "    file.go:12: detail" carries its t.Log prefix meaningfully.
  const text = stripAnsi(outputs.join(''))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .join('\n');
  if (text === '') return undefined;
  return text.length > MESSAGE_MAX_CHARS ? text.slice(-MESSAGE_MAX_CHARS) : text;
}

export const goTestParser: ReportParser = {
  name: 'go',

  sniff(content: string): boolean {
    const first = firstNonEmptyLine(stripBom(content));
    if (first === null) return false;
    try {
      const ev: unknown = JSON.parse(first);
      return isObj(ev) && 'Action' in ev && 'Package' in ev;
    } catch {
      return false;
    }
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];
    const tests = new Map<string, TestAccumulator>();
    const failedPackages = new Map<string, { failed: boolean; outputs: string[] }>();
    let malformed = 0;

    const lines = stripBom(content).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;

      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch (err) {
        malformed++;
        if (malformed <= MAX_MALFORMED_DETAILS) {
          warnings.push(`go: ${sourcePath}: line ${i + 1}: invalid JSON (${errorMessage(err)})`);
        }
        continue;
      }
      if (!isObj(ev)) continue;

      const pkg = typeof ev.Package === 'string' ? ev.Package : '';
      const test = typeof ev.Test === 'string' && ev.Test.trim() !== '' ? ev.Test : null;
      if (pkg === '') continue;

      const action = ev.Action;
      const out = ev.Output !== undefined ? ev.Output : ev.output;

      // Package-level events (no Test): track build/run failures so a package
      // that crashed before running any test still surfaces. Outputs are kept
      // for every package (they precede the fail event in real streams).
      if (test === null) {
        if (action === 'fail') {
          const entry = failedPackages.get(pkg) ?? { failed: false, outputs: [] };
          entry.failed = true;
          failedPackages.set(pkg, entry);
        } else if (action === 'output' && typeof out === 'string') {
          const entry = failedPackages.get(pkg) ?? { failed: false, outputs: [] };
          entry.outputs.push(out);
          failedPackages.set(pkg, entry);
        }
        continue;
      }

      const key = `${pkg}\u0000${test}`;
      let acc = tests.get(key);
      if (acc === undefined) {
        // Only start a test on 'run' or a terminal action: output/pause events
        // for an unknown test (stream missing its head) must not invent a
        // phantom "crashed" test.
        if (action !== 'run' && action !== 'pass' && action !== 'fail' && action !== 'skip') {
          continue;
        }
        acc = { pkg, test, runs: [newRun()] };
        tests.set(key, acc);
      } else if (
        (action === 'run' || action === 'pass' || action === 'fail' || action === 'skip') &&
        acc.runs[acc.runs.length - 1]!.status !== undefined
      ) {
        // the current run already finished: this is a repeated run (-count=N)
        acc.runs.push(newRun());
      }
      const run = acc.runs[acc.runs.length - 1]!;

      if (action === 'pass' || action === 'fail' || action === 'skip') {
        run.status = action;
        run.durationMs = elapsedToMs(ev);
      } else if (action === 'output') {
        if (typeof out === 'string') run.outputs.push(out);
      }
      // 'pause' | 'cont' | 'bench' | … — no state change.
    }

    if (malformed > MAX_MALFORMED_DETAILS) {
      warnings.push(`…and ${malformed - MAX_MALFORMED_DETAILS} more malformed lines`);
    }

    // One aggregated row per test, in first-seen order.
    const rows: Array<{
      acc: TestAccumulator;
      result: TestCaseResult;
      dangling: boolean;
      flaky: boolean;
    }> = [];
    for (const acc of tests.values()) {
      const last = acc.runs[acc.runs.length - 1]!;
      if (last.status === undefined) {
        // Test started (run event) but never reported pass/fail/skip — the test
        // binary crashed mid-run (panic, OOM, killed). Synthesize an error so
        // the crash is visible in verdicts instead of silently vanishing.
        const result: TestCaseResult = {
          testId: makeTestId(acc.pkg, acc.test),
          suite: acc.pkg,
          name: acc.test,
          status: 'error',
          durationMs: null,
          message: 'test started but never reported a result (test binary crashed mid-run?)',
        };
        // Real crash output (panic trace etc.) is the evidence — keep it below
        // the synthetic explanation.
        const output = messageFromOutputs(last.outputs);
        if (output !== undefined) result.message = `${result.message}\n${output}`;
        rows.push({ acc, result, dangling: true, flaky: false });
        continue;
      }
      const failed = acc.runs.filter((r) => r.status === 'fail');
      const reported = failed[0] ?? last;
      const result: TestCaseResult = {
        testId: makeTestId(acc.pkg, acc.test),
        suite: acc.pkg,
        name: acc.test,
        status: reported.status!,
        durationMs: reported.durationMs,
      };
      let message = messageFromOutputs(reported.outputs);
      const isFlaky = failed.length > 0 && failed.length < acc.runs.length;
      if (isFlaky) {
        const note = `flaky: failed ${failed.length} of ${acc.runs.length} runs in this report`;
        message = message !== undefined ? `${note}\n${message}` : note;
      }
      if (message !== undefined) result.message = message;
      rows.push({ acc, result, dangling: false, flaky: isFlaky });
    }

    // Subtest parents (TestA for TestA/sub): their status just mirrors their
    // children, so emitting both double-counts a failure. Drop a parent unless
    // it failed with NO failing descendant (its own t.Error after t.Run, a
    // panic in the parent body…) — that failure exists nowhere else.
    const hasChildren = new Set<string>();
    const hasFailingChild = new Set<string>();
    for (const { acc, result } of rows) {
      const parts = acc.test.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const ancestor = `${acc.pkg}\u0000${parts.slice(0, depth).join('/')}`;
        hasChildren.add(ancestor);
        if (isFailFamily(result.status)) hasFailingChild.add(ancestor);
      }
    }
    let dangling = 0;
    const flaky: string[] = [];
    for (const row of rows) {
      const key = `${row.acc.pkg}\u0000${row.acc.test}`;
      if (hasChildren.has(key) && (hasFailingChild.has(key) || !isFailFamily(row.result.status))) {
        continue;
      }
      if (row.dangling) dangling++;
      if (row.flaky) flaky.push(`${row.acc.pkg} ${row.acc.test}`);
      results.push(row.result);
    }
    if (flaky.length > 0) {
      const shown = flaky.slice(0, MAX_FLAKY_NAMES).join(', ');
      const more =
        flaky.length > MAX_FLAKY_NAMES ? ` …and ${flaky.length - MAX_FLAKY_NAMES} more` : '';
      warnings.push(
        `go: ${sourcePath}: ${flaky.length} test(s) failed in some but not all repeated runs (-count) — reported as fail: ${shown}${more}`,
      );
    }
    if (dangling > 0) {
      warnings.push(
        `go: ${sourcePath}: ${dangling} test(s) started but never reported a result — synthesized as error (package crash?)`,
      );
    }

    const pkgsWithTests = new Set([...tests.values()].map((a) => a.pkg));
    for (const [pkg, entry] of failedPackages) {
      if (!entry.failed || pkgsWithTests.has(pkg)) continue; // per-test results already reflect it
      const output = messageFromOutputs(entry.outputs);
      results.push({
        testId: makeTestId(pkg, '(package)'),
        suite: pkg,
        name: '(package)',
        status: 'error',
        durationMs: null,
        message: `package failed before any test completed (build or init crash?)${
          output
            ? `
${output}`
            : ''
        }`,
      });
      warnings.push(
        `go: ${sourcePath}: package ${pkg} failed with no test results — synthesized as error`,
      );
    }
    return { results, warnings };
  },
};
