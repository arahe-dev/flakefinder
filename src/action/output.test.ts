import { describe, expect, it } from 'vitest';
import type { TestVerdict } from '../types.js';
import { newFlakesFailure, summaryRows } from './output.js';

function verdict(over: Partial<TestVerdict>): TestVerdict {
  return {
    testId: 't1',
    suite: 's.ts',
    name: 'n',
    classification: 'flaky-confirmed',
    tags: [],
    flakeScore: 70,
    confidence: 100,
    passRate: 0.5,
    runsObserved: 5,
    lastStatus: 'fail',
    lastSeen: new Date().toISOString(),
    medianDurationMs: null,
    p95DurationMs: null,
    sameShaFlips: 1,
    retryRescues: 0,
    directionChanges: 1,
    ...over,
  };
}

const TOKEN = 'ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

describe('action outputs are redacted and escaped (R5 #12)', () => {
  it('setFailed message redacts test names and suites', () => {
    const msg = newFlakesFailure([verdict({ name: `uses ${TOKEN}`, suite: 'password=hunter2' })]);
    expect(msg).not.toContain(TOKEN);
    expect(msg).not.toContain('hunter2');
    expect(msg).toContain('ghs_[REDACTED]');
    expect(msg).toContain('1 NEW flaky test(s)');
  });

  it('job-summary cells are redacted and HTML-escaped', () => {
    const rows = summaryRows([
      verdict({ name: `</td><img src=x onerror=alert(1)> ${TOKEN}`, suite: 'a&b' }),
      verdict({ testId: 'p', classification: 'passing' }),
    ]);
    expect(rows).toHaveLength(1); // only flaky rows
    const [label, cls, score] = rows[0]!;
    expect(label).not.toContain('<');
    expect(label).toContain('&lt;/td&gt;&lt;img');
    expect(label).toContain('a&amp;b');
    expect(label).not.toContain(TOKEN);
    expect(cls).toBe('flaky-confirmed');
    expect(score).toBe('70');
  });
});
