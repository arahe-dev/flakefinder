/**
 * JUnit XML parser.
 *
 * Supports the common flavors:
 * - `<testsuites>` root wrapping one or more `<testsuite>` elements (pytest, jest-junit, …)
 * - a bare `<testsuite>` root (Maven surefire per-class files)
 * - nested `<testsuite>` hierarchies (aggregated reports)
 *
 * Per `<testcase>`:
 * - name   = @_name (testcases without a name are skipped with a warning)
 * - suite  = @_classname when present, else the nearest enclosing testsuite's @_name
 * - status = fail (child <failure>) | error (child <error>) | skip (child <skipped>) | pass
 * - durationMs = round(@_time * 1000) when @_time parses as a finite number, else null
 *   (decimal comma `1,5` → 1.5 s; grouping commas `1,033.42` → 1033.42 s)
 * - text and attribute values are never coerced to numbers; numeric character
 *   references (`&#65;`) are decoded
 * - message = failure/error @_message or its text content, trimmed to 2000 chars
 * - stack   = failure/error text content, trimmed to 1000 chars
 *
 * Maven Surefire/Failsafe reruns (`-Dsurefire.rerunFailingTestsCount=N`):
 * - `<flakyFailure>`/`<flakyError>` on a testcase without `<failure>`/`<error>`
 *   means it failed, was re-run, and finally passed. The result stays 'pass'
 *   (that is the build's verdict, and `flakefinder run` must not turn a green
 *   build red), but the message records "flaky: failed k of n attempts" with
 *   the first failure's message/stackTrace, and one warning per file lists
 *   the affected tests. The parser output has no attempt dimension and the
 *   engine collapses same-testId results within a run (last wins), so extra
 *   'fail' rows could not carry the signal — see the parser report notes.
 * - `<rerunFailure>`/`<rerunError>` next to `<failure>`/`<error>`: it failed on
 *   every attempt — still 'fail'/'error', message notes the attempt count.
 *
 * Never throws: malformed input produces warnings.
 */
import { XMLParser } from 'fast-xml-parser';
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import {
  errorMessage,
  flakyRetryMessage,
  flakyRetryWarning,
  isObj,
  stripBom,
  trimTo,
  XML_OPTIONS,
} from './internal.js';

const xml = new XMLParser(XML_OPTIONS);

const MESSAGE_MAX_CHARS = 2000;
const STACK_MAX_CHARS = 1000;

interface Ctx {
  sourcePath: string;
  results: TestCaseResult[];
  warnings: string[];
  /** `suite.name` of tests that passed only after a Surefire rerun. */
  flaky: string[];
}

/** Attribute value as a non-empty string (whitespace-only counts as absent). */
function attr(node: Record<string, unknown>, name: string): string | undefined {
  const v = node[name];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Text content of an XML node (`#text` when the node also carries attributes). */
function textOf(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (isObj(node)) {
    const t = node['#text'];
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.filter((part) => typeof part === 'string').join('');
  }
  return undefined;
}

/**
 * `time` in seconds → ms. Localized writers emit a decimal comma (`1,5`);
 * old Surefire emits grouping commas (`1,033.42`). A lone comma is a
 * decimal separator; commas alongside a '.' are grouping.
 */
function durationOf(timeAttr: string | undefined): number | null {
  if (timeAttr === undefined) return null;
  const raw = timeAttr.trim();
  const normalized = raw.includes('.')
    ? raw.replace(/,/g, '')
    : raw.replace(/^(\d*),(\d+)$/, '$1.$2');
  const seconds = Number.parseFloat(normalized);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/** message attribute, else text content, else the Surefire `<stackTrace>` child's text. */
function detailMessage(detail: unknown): string | undefined {
  const fromAttr = isObj(detail) ? attr(detail, '@_message') : undefined;
  return trimTo(fromAttr, MESSAGE_MAX_CHARS) ?? trimTo(detailStack(detail), MESSAGE_MAX_CHARS);
}

/** Text content, else the Surefire `<stackTrace>` child (rerun/flaky elements nest it). */
function detailStack(detail: unknown): string | undefined {
  const text = textOf(detail);
  if (text !== undefined && text.trim() !== '') return text;
  if (isObj(detail)) {
    const nested = children(detail, 'stackTrace')[0];
    return textOf(nested);
  }
  return undefined;
}

function mapTestCase(tc: unknown, suiteName: string, ctx: Ctx): void {
  if (!isObj(tc)) return;
  const name = attr(tc, '@_name');
  if (name === undefined) {
    ctx.warnings.push(`junit: ${ctx.sourcePath}: skipping <testcase> without a name attribute`);
    return;
  }
  const suite = attr(tc, '@_classname') ?? suiteName;

  let status: TestStatus = 'pass';
  let detail: unknown;
  if (tc.failure !== undefined) {
    status = 'fail';
    detail = tc.failure;
  } else if (tc.error !== undefined) {
    status = 'error';
    detail = tc.error;
  } else if (tc.skipped !== undefined) {
    status = 'skip';
  }

  const result: TestCaseResult = {
    testId: makeTestId(suite, name),
    suite,
    name,
    status,
    durationMs: durationOf(attr(tc, '@_time')),
  };
  if (detail !== undefined) {
    const message = detailMessage(detail);
    const stack = trimTo(textOf(detail), STACK_MAX_CHARS);
    if (message !== undefined) result.message = message;
    if (stack !== undefined) result.stack = stack;
  }

  // Surefire rerun evidence (see the header comment for the representation).
  const reruns = [...children(tc, 'rerunFailure'), ...children(tc, 'rerunError')];
  const flakes = [...children(tc, 'flakyFailure'), ...children(tc, 'flakyError')];
  if ((status === 'fail' || status === 'error') && reruns.length > 0) {
    const note = `(Surefire: failed all ${reruns.length + 1} attempts)`;
    result.message = trimTo(
      result.message !== undefined ? `${result.message}\n${note}` : note,
      MESSAGE_MAX_CHARS,
    );
  } else if (status === 'pass' && flakes.length > 0) {
    const first = flakes[0];
    result.message = flakyRetryMessage(
      flakes.length,
      'Surefire rerun',
      detailMessage(first),
      MESSAGE_MAX_CHARS,
    );
    const stack = trimTo(detailStack(first), STACK_MAX_CHARS);
    if (stack !== undefined) result.stack = stack;
    ctx.flaky.push(`${suite}.${name}`);
  }
  ctx.results.push(result);
}

/**
 * Namespace-tolerant child lookup: matches `testcase`, `x:testcase`, etc.
 * fast-xml-parser keeps the namespace prefix in tag names.
 */
function children(el: Record<string, unknown>, localName: string): unknown[] {
  const out: unknown[] = [];
  for (const [key, value] of Object.entries(el)) {
    if (key === localName || key.endsWith(`:${localName}`)) {
      if (Array.isArray(value)) out.push(...value);
      else out.push(value);
    }
  }
  return out;
}

/**
 * Walk a testsuites/testsuite element: map its direct testcases, then recurse
 * into nested testsuites. A nested suite without @_name inherits the parent name.
 */
function walk(el: unknown, inheritedSuite: string, ctx: Ctx): void {
  if (!isObj(el)) return;
  const ownSuite = attr(el, '@_name') ?? inheritedSuite;
  for (const tc of children(el, 'testcase')) mapTestCase(tc, ownSuite, ctx);
  for (const ts of children(el, 'testsuite')) walk(ts, ownSuite, ctx);
}

export const junitParser: ReportParser = {
  name: 'junit',

  sniff(content: string): boolean {
    const trimmed = stripBom(content).trimStart();
    // namespace prefixes allowed: <testsuit…>, <x:testsuit…>
    return trimmed.startsWith('<') && /<(?:[\w.-]+:)?testsuit/.test(trimmed);
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const ctx: Ctx = { sourcePath, results: [], warnings: [], flaky: [] };
    const body = stripBom(content);

    if (body.trim() === '') {
      ctx.warnings.push(`junit: ${sourcePath}: file is empty`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    if (!body.trimEnd().endsWith('>')) {
      ctx.warnings.push(`junit: ${sourcePath}: content appears truncated (does not end with '>')`);
    }

    let doc: unknown;
    try {
      doc = xml.parse(body);
    } catch (err) {
      ctx.warnings.push(`junit: ${sourcePath}: failed to parse XML: ${errorMessage(err)}`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    if (!isObj(doc)) {
      ctx.warnings.push(`junit: ${sourcePath}: XML did not parse to a document object`);
      return { results: ctx.results, warnings: ctx.warnings };
    }

    // namespace-tolerant root lookup: <testsuites>, <testsuite>, <x:testsuites>…
    const rootKey = Object.keys(doc).find((k) => /(?:^|:)testsuites?$/.test(k));
    let root = rootKey !== undefined ? doc[rootKey] : undefined;
    if (Array.isArray(root)) {
      // two <testsuites> blocks in one file: fast-xml-parser yields an array —
      // use the first and say so rather than silently dropping everything
      ctx.warnings.push(
        `junit: ${sourcePath}: multiple <testsuites> roots found — using the first`,
      );
      root = root[0];
    }
    if (root === undefined) {
      ctx.warnings.push(`junit: ${sourcePath}: no <testsuites> or <testsuite> root element found`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    walk(root, 'unknown', ctx);
    if (ctx.flaky.length > 0) {
      ctx.warnings.push(flakyRetryWarning('junit', sourcePath, 'Surefire rerun', ctx.flaky));
    }
    return { results: ctx.results, warnings: ctx.warnings };
  },
};
