/**
 * Black-box CLI tests: the CURRENT source of src/cli/index.ts is bundled
 * once (tsup, deps inlined) into a temp dir and spawned like a user would —
 * so these never depend on a stale committed dist/.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

let buildDir = '';
let cliPath = '';
let dirs: string[] = [];

beforeAll(async () => {
  buildDir = mkdtempSync(path.join(tmpdir(), 'ff-cli-build-'));
  await build({
    entry: { cli: fileURLToPath(new URL('./index.ts', import.meta.url)) },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    outDir: buildDir,
    noExternal: [/.*/],
    config: false,
    silent: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    clean: false,
  });
  cliPath = path.join(buildDir, 'cli.js');
}, 60_000);

afterAll(() => {
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ff-cli-'));
  dirs.push(d);
  return d;
}

function cli(
  args: string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const JUNIT =
  '<testsuites><testsuite name="s"><testcase name="a"/><testcase name="b"/></testsuite></testsuites>';

function historyRecords(cwd: string): { runId: string; results: unknown[] }[] {
  return readFileSync(path.join(cwd, '.flakefinder', 'history.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { runId?: string; results?: unknown[] })
    .filter((r): r is { runId: string; results: unknown[] } => r.runId !== undefined);
}

describe('ingest dedupes explicitly-passed files (QA A6)', () => {
  it('the same file passed twice (and via another spelling) is ingested once', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    const r = cli(['ingest', 'r.xml', 'r.xml', './r.xml', path.join(d, 'r.xml')], d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ingested 2 test result(s) from 1/1 file(s)');
    const records = historyRecords(d);
    expect(records).toHaveLength(1);
    expect(records[0]!.results).toHaveLength(2);
  });
});

describe('strict integer flags (QA A7/A8)', () => {
  it.each([
    [
      ['run', '-R', '2.5', '--', 'node', '-e', '0'],
      'run -R/--retries must be an integer 0–10 (got 2.5)',
    ],
    [
      ['run', '-R', '2x', '--', 'node', '-e', '0'],
      'run -R/--retries must be an integer 0–10 (got 2x)',
    ],
    [
      ['run', '-R', '50', '--', 'node', '-e', '0'],
      'run -R/--retries must be an integer 0–10 (got 50)',
    ],
    [
      ['run', '--retries=-1', '--', 'node', '-e', '0'],
      'run -R/--retries must be an integer 0–10 (got -1)',
    ],
    [
      ['run', '--timeout', '1.5', '--', 'node', '-e', '0'],
      'run --timeout must be an integer 1–2147483 (seconds) (got 1.5)',
    ],
    [
      ['run', '--timeout', '0', '--', 'node', '-e', '0'],
      'run --timeout must be an integer 1–2147483 (seconds) (got 0)',
    ],
    [['ingest', 'r.xml', '--attempt=-5'], 'ingest --attempt must be an integer 1–1000000 (got -5)'],
    [
      ['ingest', 'r.xml', '--attempt', '2.7'],
      'ingest --attempt must be an integer 1–1000000 (got 2.7)',
    ],
    [
      ['ingest', 'r.xml', '--attempt', 'abc'],
      'ingest --attempt must be an integer 1–1000000 (got abc)',
    ],
    [
      ['ingest', 'r.xml', '--attempt', '0'],
      'ingest --attempt must be an integer 1–1000000 (got 0)',
    ],
    [['report', '--threshold', '50abc'], 'report --threshold must be an integer 0–100 (got 50abc)'],
    [['report', '--threshold', '101'], 'report --threshold must be an integer 0–100 (got 101)'],
  ])('%j exits 2 naming the flag and range', (args, message) => {
    const d = tmp();
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    const r = cli(args, d);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(`flakefinder: ${message}`);
    // nothing ran, nothing was recorded
    expect(existsSync(path.join(d, '.flakefinder'))).toBe(false);
  });

  it('-R 50 is blamed on the flag even when a valid config exists (QA A8)', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "liveRetries": 1 }', 'utf8');
    const r = cli(['run', '-R', '50', '--', 'node', '-e', '0'], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('run -R/--retries must be an integer 0–10 (got 50)');
    expect(r.stderr).not.toContain('config');
  });

  it('valid values still work: --attempt 2, --threshold 0', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    expect(cli(['ingest', 'r.xml', '--attempt', '2'], d).status).toBe(0);
    expect(historyRecords(d)[0]).toMatchObject({ attempt: 2 });
    expect(cli(['report', '--threshold', '0'], d).status).toBe(0);
  });
});

describe('commander usage errors print once (QA A10)', () => {
  it.each([
    [['frobnicate'], "error: unknown command 'frobnicate'"],
    [['report', '--bogus'], "error: unknown option '--bogus'"],
    [['ingest', '--attempt'], "error: option '--attempt <n>' argument missing"],
  ])('%j prints ONE error line and exits 2', (args, message) => {
    const r = cli(args, tmp());
    expect(r.status).toBe(2);
    const lines = r.stderr.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toEqual([message]);
  });

  it('--help and --version still exit 0', () => {
    const d = tmp();
    expect(cli(['--help'], d).status).toBe(0);
    const v = cli(['--version'], d);
    expect(v.status).toBe(0);
    expect(v.stderr).toBe('');
  });
});

describe('unstartable test command (QA A11)', () => {
  it('run -- <missing binary> exits 2 with one clear message and no report', () => {
    const d = tmp();
    const r = cli(['run', '--', 'definitely-not-a-cmd-xyz'], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      'flakefinder: command not found: definitely-not-a-cmd-xyz — is it installed and on PATH?',
    );
    expect(r.stdout).not.toContain('no test history yet');
    expect(r.stdout.match(/attempt \d+\/\d+/g)).toEqual(['attempt 1/3']); // no retries
  });
});

describe('config found in a parent dir anchors storeDir/quarantineFile (R5 #6)', () => {
  it('ingest from a subdirectory writes to the store next to the config file', () => {
    const root = tmp();
    writeFileSync(path.join(root, 'flakefinder.config.json'), '{"storeDir": ".ff-store"}', 'utf8');
    const sub = path.join(root, 'packages', 'a');
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, 'r.xml'), JUNIT, 'utf8');
    const r = cli(['ingest', 'r.xml'], sub);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(root, '.ff-store', 'history.jsonl'))).toBe(true);
    expect(existsSync(path.join(sub, '.ff-store'))).toBe(false);
  });

  it('--config <path> anchors to that file too', () => {
    const root = tmp();
    const cfgDir = path.join(root, 'cfg');
    mkdirSync(cfgDir);
    writeFileSync(path.join(cfgDir, 'ff.json'), '{"storeDir": "store"}', 'utf8');
    writeFileSync(path.join(root, 'r.xml'), JUNIT, 'utf8');
    const r = cli(['--config', path.join('cfg', 'ff.json'), 'ingest', 'r.xml'], root);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(cfgDir, 'store', 'history.jsonl'))).toBe(true);
  });
});
