import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectParser, parsers } from './index.js';

const load = (name: string): string =>
  readFileSync(new URL(`../../tests/parsers-fixtures/${name}`, import.meta.url), 'utf8');

describe('parsers registry', () => {
  it('exposes the parsers in contract order', () => {
    expect(parsers.map((p) => p.name)).toEqual(['junit', 'jest', 'mocha', 'go', 'tap', 'trx']);
  });
});

describe('detectParser', () => {
  const cases: Array<[string, string]> = [
    ['junit-pytest.xml', 'junit'],
    ['junit-jest-junit.xml', 'junit'],
    ['junit-empty.xml', 'junit'],
    ['malformed-xml.xml', 'junit'],
    ['jest.json', 'jest'],
    ['jest-minimal.json', 'jest'],
    ['jest-suite-failure.json', 'jest'],
    ['jest-no-tests.json', 'jest'],
    ['mocha.json', 'mocha'],
    ['go-test.jsonl', 'go'],
    ['go-test-old.jsonl', 'go'],
    ['go-count2.jsonl', 'go'],
    ['go124-build-fail.jsonl', 'go'],
    ['go-stderr-merged.jsonl', 'go'],
    ['tap-node.jsonl', 'tap'],
    ['tap-ttest.jsonl', 'tap'],
    ['tap-node20-multiline.tap', 'tap'],
    ['tap-node20-parents.tap', 'tap'],
    ['tap-perl-no-header.tap', 'tap'],
    ['trx-dotnet.trx', 'trx'],
    ['trx-mstest3.trx', 'trx'],
    ['trx-mstest2-datarows.trx', 'trx'],
    ['trx-truncated.trx', 'trx'],
    ['junit-surefire-reruns.xml', 'junit'],
    ['mocha-same-title-hook.json', 'mocha'],
    ['mochawesome.json', 'mocha'],
    ['vitest-retry.json', 'jest'],
  ];

  for (const [fixture, expected] of cases) {
    it(`detects ${expected} for ${fixture}`, () => {
      expect(detectParser(load(fixture))?.name).toBe(expected);
    });
  }

  it('returns null for plain text', () => {
    expect(detectParser('hello world')).toBeNull();
  });

  it('returns null for an empty JSON object', () => {
    expect(detectParser('{}')).toBeNull();
  });

  it('returns null for empty or whitespace-only content', () => {
    expect(detectParser('')).toBeNull();
    expect(detectParser('   \n\t ')).toBeNull();
  });

  it('returns null for JSON without any known report shape', () => {
    expect(detectParser('{"stats": {}}')).toBeNull();
    expect(detectParser('{"testResults": [{"name": "x"}]}')).toBeNull();
    expect(detectParser('{"results": [1, 2, 3]}')).toBeNull();
  });

  it('detects junit for XML with leading whitespace and a BOM', () => {
    expect(detectParser('  \n<?xml version="1.0"?><testsuites/>')?.name).toBe('junit');
    expect(detectParser('\uFEFF<testsuite name="s"/>')?.name).toBe('junit');
  });

  it('never throws on garbage input', () => {
    expect(() => detectParser('\u0000\u0001')).not.toThrow();
    expect(() => detectParser('{"broken": [')).not.toThrow();
  });
});

describe('byte-order marks (QA PAR-9)', () => {
  const fixtures: Array<[string, string]> = [
    ['junit-pytest.xml', 'junit'],
    ['jest.json', 'jest'],
    ['mocha.json', 'mocha'],
    ['go-test.jsonl', 'go'],
    ['tap-node20-parents.tap', 'tap'],
    ['tap-perl-no-header.tap', 'tap'],
    ['trx-dotnet.trx', 'trx'],
  ];
  for (const [fixture, expected] of fixtures) {
    it(`detects and parses ${fixture} with a leading U+FEFF exactly as without`, () => {
      const plain = load(fixture);
      const parser = detectParser(`\uFEFF${plain}`);
      expect(parser?.name).toBe(expected);
      const withBom = parser!.parse(`\uFEFF${plain}`, fixture);
      expect(withBom).toEqual(detectParser(plain)!.parse(plain, fixture));
      expect(withBom.results.length).toBeGreaterThan(0);
    });
  }

  it('a UTF-16 file decoded with its BOM (what decodeText returns) is detected', () => {
    const utf16 = Buffer.from(`\uFEFF${load('jest.json')}`, 'utf16le');
    expect(detectParser(utf16.toString('utf16le'))?.name).toBe('jest');
  });
});
