/**
 * TAP parser — covers `node --test --test-reporter=tap` (verified against
 * node 22 output) and plain TAP14.
 *
 * Grammar notes from real output:
 * - `TAP version 13` header; `# Subtest: NAME` declares a test at its
 *   nesting level; the assertion (`ok N - NAME` / `not ok N - NAME`) closes
 *   it — for suites the aggregate assertion repeats the suite name AFTER its
 *   children and carries `type: 'suite'` in the YAML block.
 * - Suite aggregates are NOT emitted (their children already carry the
 *   results — emitting both would double-count failures in the engine).
 * - Directives: `# SKIP reason` → skip, `# TODO` → skip.
 * - YAML blocks between --- and ... carry diagnostics: `error:` → message,
 *   `stack:` → stack. Both may be plain/quoted scalars or block scalars
 *   (`|`, `|-`, `>`, `>-` …) — node writes multi-line assertion diffs as
 *   `error: |-` followed by indented lines.
 * - Identity: suite = ancestor chain joined by ' > '; root-level tests get
 *   suite 'node:test' (TAP carries no file names).
 *
 * Never throws.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, stripBom, trimTo } from './internal.js';

const ROOT_SUITE = 'node:test';
const MESSAGE_MAX_CHARS = 2000;

interface YamlBlock {
  error?: string;
  stack?: string;
  isSuite: boolean;
}

export const tapParser: ReportParser = {
  name: 'tap',

  sniff(content: string): boolean {
    const first = stripBom(content)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '');
    return first !== undefined && /^TAP version \d+\s*$/i.test(first);
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];
    const body = stripBom(content);
    if (body.trim() === '') {
      warnings.push(`tap: ${sourcePath}: file is empty`);
      return { results, warnings };
    }

    const lines = body.split(/\r?\n/);
    // ancestry of the currently open `# Subtest:` declarations
    const ancestors: Array<{ name: string; children: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      const sub = line.match(/^\s*# Subtest: (.+?)\s*$/);
      if (sub) {
        ancestors.push({ name: sub[1]!.replace(/\\#/g, '#'), children: 0 });
        continue;
      }

      const assertion = line.match(
        /^\s*(not ok|ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s*([A-Za-z]+)\b(.*))?$/,
      );
      if (assertion) {
        const [, verdict, rawName, directive, directiveText] = assertion;
        // unescape node's \# AFTER directive parsing (an escaped # is not a
        // directive marker — the raw stream stores it as \#)
        const name = rawName!.trim().replace(/\\#/g, '#');
        // In node:test TAP, EVERY test's assertion repeats its own `# Subtest:`
        // name (children first, then the parent suite's aggregate). A true
        // suite aggregate carries `type: 'suite'` in its YAML block — pop it
        // without emitting (its children already carry the results); anything
        // else is a leaf: emit, then pop its own declaration.
        let yaml: YamlBlock = { isSuite: false };
        if (lines[i + 1]?.trim() === '---') {
          let j = i + 2;
          const block: string[] = [];
          while (j < lines.length && lines[j]!.trim() !== '...') {
            block.push(lines[j]!);
            j++;
          }
          yaml = parseYamlBlock(block, sourcePath, warnings);
        }
        const ownDeclaration =
          ancestors.length > 0 && ancestors[ancestors.length - 1]!.name === name;
        const isAggregate =
          ownDeclaration && (yaml.isSuite || ancestors[ancestors.length - 1]!.children > 0);
        if (isAggregate) {
          ancestors.pop();
          // the popped suite is itself a child of the next level up
          if (ancestors.length > 0) ancestors[ancestors.length - 1]!.children++;
          continue;
        }
        // suite = ancestors WITHOUT the leaf's own declaration
        const chain = ownDeclaration ? ancestors.slice(0, -1) : ancestors;
        const suite = chain.length > 0 ? chain.map((a) => a.name).join(' > ') : ROOT_SUITE;
        let status: TestStatus = verdict === 'not ok' ? 'fail' : 'pass';
        let message = yaml.error;
        // TAP spec: directives are case-insensitive (# SKIP, # skip, # Skip …)
        const directiveKind = directive?.toUpperCase();
        if (directiveKind === 'SKIP' || directiveKind === 'TODO') {
          status = 'skip';
          const reason = directiveText?.replace(/^\s*-\s*/, '').trim();
          if (reason) message = reason;
        }
        const result: TestCaseResult = {
          testId: makeTestId(suite, name),
          suite,
          name,
          status,
          durationMs: null,
        };
        if (message !== undefined && message !== '')
          result.message = trimTo(message, MESSAGE_MAX_CHARS);
        if (status === 'fail' && yaml.stack !== undefined) {
          result.stack = trimTo(yaml.stack, 1000);
        }
        results.push(result);
        if (ownDeclaration) {
          ancestors.pop();
          // the emitted leaf counts as a child of its PARENT (the new top),
          // not of its own (now-popped) declaration
          if (ancestors.length > 0) ancestors[ancestors.length - 1]!.children++;
        }
      }
      // 'TAP version', plans (1..N), summary comments, diagnostics comments — ignored
    }

    // unterminated Subtest declarations (truncated stream): the deepest
    // pending ancestors never closed — nothing to emit for them, but warn.
    if (ancestors.length > 0) {
      warnings.push(
        `tap: ${sourcePath}: ${ancestors.length} subtest(s) never reported a result (truncated stream?)`,
      );
    }
    return { results, warnings };
  },
};

/**
 * Minimal YAML diagnostics extraction for node:test's blocks: top-level
 * `key: value` scalars plus block scalars (`key: |`, `|-`, `|+`, `>`, `>-`, `>+`).
 * Nested mappings (node's `expected:`/`actual:` objects) are skipped whole.
 */
function parseYamlBlock(block: string[], sourcePath: string, warnings: string[]): YamlBlock {
  const out: YamlBlock = { isSuite: false };
  try {
    const keyIndent = Math.min(
      ...block.filter((l) => l.trim() !== '').map((l) => indentOf(l)),
      Number.POSITIVE_INFINITY,
    );
    for (let k = 0; k < block.length; k++) {
      const line = block[k]!;
      if (indentOf(line) !== keyIndent) continue;
      const keyMatch = line.match(/^\s*([A-Za-z_][\w-]*):(?:\s+(.*?))?\s*$/);
      if (!keyMatch) continue;
      const [, key, rawValue = ''] = keyMatch;
      // the key's value continues on more-indented (or blank) lines
      let m = k + 1;
      while (m < block.length && (block[m]!.trim() === '' || indentOf(block[m]!) > keyIndent)) m++;
      const continuation = block.slice(k + 1, m);
      k = m - 1;

      let value: string | undefined;
      const scalar = rawValue.match(/^([|>])([-+]?)\d*$/);
      if (scalar) value = readBlockScalar(continuation, scalar[1] === '>');
      else if (rawValue !== '') value = unquote(rawValue);
      if (value === undefined) continue; // nested mapping / empty value

      if (key === 'error' && out.error === undefined) out.error = value;
      else if (key === 'stack' && out.stack === undefined) out.stack = value;
      else if (key === 'type' && value === 'suite') out.isSuite = true;
    }
  } catch (err) {
    warnings.push(`tap: ${sourcePath}: diagnostic block parse skipped (${errorMessage(err)})`);
  }
  return out;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Body of a YAML block scalar. Literal (`|`) keeps line breaks; folded (`>`)
 * joins adjacent non-blank lines with a space and keeps blank lines as breaks.
 * Chomping indicators only affect trailing newlines, which callers trim anyway.
 */
function readBlockScalar(lines: string[], folded: boolean): string {
  const firstContent = lines.find((l) => l.trim() !== '');
  if (firstContent === undefined) return '';
  const base = indentOf(firstContent);
  const body = lines.map((l) => (l.trim() === '' ? '' : l.slice(Math.min(base, indentOf(l)))));
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  if (!folded) return body.join('\n');
  let text = '';
  for (let n = 0; n < body.length; n++) {
    const cur = body[n]!;
    if (n > 0) text += cur === '' || body[n - 1] === '' ? '\n' : ' ';
    text += cur;
  }
  return text.replace(/\n\n/g, '\n');
}

function unquote(s: string): string {
  const m = s.match(/^'(.*)'$/);
  return m !== null ? m[1]!.replace(/\\'/g, "'") : s;
}
