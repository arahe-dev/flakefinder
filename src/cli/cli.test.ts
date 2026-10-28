/**
 * Black-box CLI tests: the CURRENT source of src/cli/index.ts is bundled
 * once (tsup, deps inlined) into a temp dir and spawned like a user would —
 * so these never depend on a stale committed dist/.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
