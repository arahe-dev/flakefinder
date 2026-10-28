import type { TestVerdict } from '../types.js';
import { redact } from '../util/redact.js';

export const PR_COMMENT_MARKER = '<!-- flakefinder:report -->';

const FLAKY_CLASSES = ['flaky-confirmed', 'flaky-retry', 'flaky-suspected'] as const;

function isFlaky(v: TestVerdict): boolean {
  return (FLAKY_CLASSES as readonly string[]).includes(v.classification);
}

/**
 * Neutralise untrusted text (test names, suites — anyone who can open a PR
 * controls them) for inline GitHub/GitLab markdown:
 * - HTML: `&`, `<`, `>` become entities, so `</details>`, `<img …>` or an
 *   autolink can't break out of our markup (they still render as text);
 * - link/image syntax: `[` and `]` are backslash-escaped;
 * - @mentions: a zero-width joiner after `@` stops user/team pings;
 * - table pipes are escaped.
 * Expects one line of already-redacted text.
 */
export function escapeMarkdownInline(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[[\]]/g, '\\$&')
    .replace(/@(?=[A-Za-z0-9_-])/g, '@\u200D')
    .replace(/\|/g, '\\|');
}

/** Table-cell safe: one line, capped length, secrets redacted, markdown/HTML neutralised. */
function cell(s: string | undefined, max = 80): string {
  if (!s) return '';
  // redact BEFORE truncating (a split token can't survive), escape AFTER (an
  // entity can't be cut in half)
  const oneLine = redact(s).replace(/\r?\n/g, ' ');
  const out = oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  return escapeMarkdownInline(out);
}

/**
 * A backtick fence longer than any backtick run in `content` (min 3), so
 * content can never close the code block early. Inside a fence, mentions,
 * links and HTML are inert.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function classLabel(v: TestVerdict): string {
  switch (v.classification) {
    case 'flaky-confirmed':
      return 'flaky ✅❌';
    case 'flaky-retry':
      return 'flaky 🔁';
    case 'flaky-suspected':
      return 'flaky ❓';
    case 'failing':
      return 'failing';
    case 'new-failure':
      return 'new failure';
    case 'passing':
      return 'passing';
    case 'skipped':
      return 'skipped';
    case 'gone':
      return 'gone';
  }
}

function table(rows: Array<{ v: TestVerdict; delta: string }>): string {
  const lines = [
    '| Test | Suite | Class | Score | Conf | Δ |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const { v, delta } of rows) {
    lines.push(
      `| ${cell(v.name, 60)} | ${cell(v.suite, 40)} | ${classLabel(v)} | ${v.flakeScore} | ${v.confidence}% | ${delta} |`,
    );
  }
  return lines.join('\n');
}

function flakeRows(verdicts: TestVerdict[]): Array<{ v: TestVerdict; delta: string }> {
  return verdicts
    .filter(isFlaky)
    .sort((a, b) => b.flakeScore - a.flakeScore)
    .map((v) => ({ v, delta: '' }));
}

/** Standalone markdown report (`flakefinder report --format md`). */
export function renderMarkdown(verdicts: TestVerdict[], opts: { flakesOnly: boolean }): string {
  const flaky = flakeRows(verdicts);
  const failing = verdicts.filter(
    (v) => v.classification === 'failing' || v.classification === 'new-failure',
  );
  const sections: string[] = ['## flakefinder report', ''];
  if (flaky.length > 0) {
    sections.push(`**Flaky tests: ${flaky.length}**`, '', table(flaky), '');
  } else {
    sections.push('✅ no flakes detected', '');
  }
  if (failing.length > 0) {
    sections.push(
      `**Deterministic failures: ${failing.length}**`,
      '',
      table(failing.map((v) => ({ v, delta: '' }))),
      '',
    );
  }
  if (!opts.flakesOnly) {
    const passing = verdicts.filter((v) => v.classification === 'passing').length;
    sections.push(`_tracked: ${verdicts.length} tests · ${passing} passing_`, '');
  }
  return sections.join('\n');
}

/**
 * PR comment body (PLAN §10): marker first line so the action can upsert.
 * `previous` is the verdict snapshot from the previous CI run (null on first run).
 */
export function buildPrComment(verdicts: TestVerdict[], previous: TestVerdict[] | null): string {
  const prevFlaky = new Set((previous ?? []).filter(isFlaky).map((v) => v.testId));
  const prevScore = new Map((previous ?? []).map((v) => [v.testId, v.flakeScore]));
  const flaky = verdicts.filter(isFlaky).sort((a, b) => b.flakeScore - a.flakeScore);
  const newFlakes = flaky.filter((v) => !prevFlaky.has(v.testId));
  const failing = verdicts.filter(
    (v) => v.classification === 'failing' || v.classification === 'new-failure',
  );

  const rows = flaky.map((v) => {
    if (!previous) return { v, delta: '—' };
    if (!prevFlaky.has(v.testId)) return { v, delta: '**new**' };
    const d = v.flakeScore - (prevScore.get(v.testId) ?? 0);
    return { v, delta: d === 0 ? '=' : d > 0 ? `↑${d}` : `↓${-d}` };
  });

  const out: string[] = [PR_COMMENT_MARKER, '## 🐍 flakefinder', ''];
  const summary =
    flaky.length === 0
      ? `✅ no flakes detected among ${verdicts.length} tracked tests`
      : `**${flaky.length} flaky** (${newFlakes.length} new · ${flaky.length - newFlakes.length} known) · ${failing.length} failing · ${verdicts.length} tracked`;
  out.push(summary);
  if (previous === null && flaky.length > 0) out.push('_first run — building history_');
  out.push('');

  if (flaky.length > 0) out.push(table(rows), '');

  const detailCount = Math.min(newFlakes.length, 5);
  for (let i = 0; i < detailCount; i++) {
    const v = newFlakes[i]!;
    out.push(
      `<details><summary><code>${cell(v.name, 60)}</code> — score ${v.flakeScore}</summary>`,
      '',
    );
    // redact BEFORE truncating so a token split by the slice can't survive partially
    const message = redact(v.lastMessage ?? '(no failure message recorded)').slice(0, 400);
    const fence = fenceFor(message);
    out.push(`${fence}text`, message, fence, '');
    out.push('Quarantine it:', '');
    out.push('```bash');
    out.push(`flakefinder quarantine add ${v.testId}`);
    out.push('```', '');
    out.push('</details>', '');
  }
  if (newFlakes.length > detailCount) {
    out.push(
      `_…and ${newFlakes.length - detailCount} more new flake(s) — see the dashboard artifact._`,
      '',
    );
  }
  out.push(
    '---',
    '_📊 HTML dashboard uploaded as artifact `flakefinder-dashboard` · docs: `docs/github-action.md`_',
  );
  return out.join('\n');
}
