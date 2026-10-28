import type { TestVerdict } from '../types.js';
import { redact } from '../util/redact.js';

/** HTML-escape for job-summary table cells (@actions/core inserts them raw into <td>). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Redacted, one-line `suite :: name` label (test names are PR-author controlled). */
function label(v: TestVerdict): string {
  return `${redact(v.suite)} :: ${redact(v.name)}`.replace(/[\r\n]+/g, ' ');
}

/** Rows (without header) for the job-summary table: redacted and HTML-escaped. */
export function summaryRows(verdicts: TestVerdict[], limit = 20): string[][] {
  return verdicts
    .filter((v) => v.classification.startsWith('flaky-'))
    .sort((a, b) => b.flakeScore - a.flakeScore)
    .slice(0, limit)
    .map((v) => [escapeHtml(label(v)), escapeHtml(v.classification), String(v.flakeScore)]);
}

/** setFailed message for the new-flakes gate — names redacted, one line per test. */
export function newFlakesFailure(newFlakes: TestVerdict[]): string {
  const names = newFlakes.map((v) => `  • ${label(v)} (score ${v.flakeScore})`).join('\n');
  return `flakefinder: ${newFlakes.length} NEW flaky test(s):\n${names}`;
}
