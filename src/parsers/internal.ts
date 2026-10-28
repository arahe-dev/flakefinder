/**
 * Shared helpers internal to src/parsers — not part of the frozen public contract.
 */

/**
 * fast-xml-parser options shared by the XML parsers (junit, trx):
 * - parseTagValue/parseAttributeValue false: text stays text — otherwise
 *   `<failure>42</failure>` becomes the number 42 (and `007` becomes 7), which
 *   text extraction then drops.
 * - htmlEntities true: numeric character references (`&#65;`, `&#x41;`) in
 *   names and messages are decoded (the default only handles the five XML
 *   named entities). CDATA content is left verbatim.
 */
export const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
} as const;

/** True for a non-null, non-array object. */
export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Normalize an optional XML/JSON child to an array (fast-xml-parser collapses single children). */
export function toArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Trim a string value; undefined for non-strings, empty/whitespace-only values,
 * or after hard truncation to `max` characters.
 */
export function trimTo(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (t === '') return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** Strip ANSI SGR escape sequences (`ESC[…m`) from text. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC control character is the very thing being matched.
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Remove a leading UTF-8 BOM if present. */
export function stripBom(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

/** Readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First line that is not empty/whitespace-only, or null when there is none. */
export function firstNonEmptyLine(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() !== '') return line;
  }
  return null;
}

/** How many flaky test names one retry warning lists before summarising. */
const MAX_FLAKY_NAMES = 10;

/**
 * Message for a test that FAILED and then PASSED on a runner retry/rerun within
 * one report. The result stays 'pass' (the runner's verdict), and this note
 * keeps the failure visible. One ParseResult has no attempt dimension and the
 * engine collapses same-testId rows per run (last wins), so extra 'fail' rows
 * could not carry the signal. Shared by junit (Surefire), jest/vitest and mocha.
 */
export function flakyRetryMessage(
  failedAttempts: number,
  how: string,
  firstFailure: string | undefined,
  max: number,
): string | undefined {
  const header = `flaky: failed ${failedAttempts} of ${failedAttempts + 1} attempts before passing on ${how}`;
  const first = trimTo(firstFailure, max);
  return trimTo(first !== undefined ? `${header} — first failure: ${first}` : header, max);
}

/** One per-file warning naming the tests that only passed on a retry. */
export function flakyRetryWarning(
  format: string,
  sourcePath: string,
  how: string,
  names: string[],
): string {
  const shown = names.slice(0, MAX_FLAKY_NAMES).join(', ');
  const more = names.length > MAX_FLAKY_NAMES ? ` …and ${names.length - MAX_FLAKY_NAMES} more` : '';
  return `${format}: ${sourcePath}: ${names.length} test(s) FLAKY — failed, then passed on ${how} (recorded as pass with the failure in the message): ${shown}${more}`;
}
