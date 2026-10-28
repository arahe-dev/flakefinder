import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as artifact from '@actions/artifact';
import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { loadConfig, resolveConfig } from '../config.js';
import { renderDashboard } from '../report/html.js';
import { renderJson } from '../report/json.js';
import { buildPrComment } from '../report/markdown.js';
import { snapshotPath } from '../store/history-store.js';
import { FLAKEFINDER_VERSION } from '../types.js';
import { cacheKeys, recordBaseline, resolveBaseline } from './baseline.js';
import { computeNewFlakes } from './diff.js';
import { githubEnv, upsertPrComment } from './github.js';
import { cacheUsable, restoreHistory, saveHistory } from './history-cache.js';
import { ingestReports } from './ingest.js';
import { jobSummaryHtml, newFlakesFailure } from './output.js';

async function expandGlobs(patterns: string[], cwd: string): Promise<string[]> {
  const globModule = await import('@actions/glob');
  const globber = await globModule.create(patterns.join('\n'), { matchDirectories: false });
  const paths: string[] = await globber.glob();
  return paths.map((p: string) => path.resolve(cwd, p));
}

async function actionMain(): Promise<void> {
  const workingDirectory = core.getInput('working-directory') || '.';
  const cwd = path.resolve(process.cwd(), workingDirectory);
  process.chdir(cwd);
  const gh = githubEnv();

  const { config } = loadConfig(cwd);
  const reportsInput = core.getInput('reports');
  const historyMaxRuns = Number.parseInt(core.getInput('history-max-runs') || '300', 10);
  const cfg = resolveConfig(
    config,
    reportsInput
      ? { reports: reportsInput.split(',').map((s) => s.trim()), maxRuns: historyMaxRuns }
      : { maxRuns: historyMaxRuns },
  );
  const storeDir = path.resolve(cwd, cfg.storeDir);

  // 1. restore history cache (best-effort — miss on first run is normal).
  // Saved per run attempt + job, restored by prefix: see baseline.ts.
  const { saveKey, restoreKeys } = cacheKeys(gh);
  const useCache = cacheUsable(cache, core);
  if (useCache) await restoreHistory(cache, core, storeDir, saveKey, restoreKeys);

  // 2. pick the "previous verdicts" baseline BEFORE ingesting today's runs —
  // never this run's own earlier attempt (re-runs must not bypass the gate)
  const baseline = resolveBaseline(storeDir, gh.runId);
  for (const w of baseline.warnings) core.warning(w);
  if (baseline.source === 'earlier-attempt') {
    core.info('re-run detected: comparing against the baseline of this run’s first attempt');
  }
  const previous = baseline.previous;

  // 3. ingest report files
  const patterns = cfg.reports;
  if (patterns.length === 0) {
    core.setFailed(
      'flakefinder: no report globs configured. Add "reports" to flakefinder.config.json or set the `reports` input. See flakefinder init.',
    );
    return;
  }
  const files = await expandGlobs(patterns, cwd);
  if (files.length === 0 && storeDirFiles(storeDir) === 0) {
    core.setFailed(
      `flakefinder: no files matched ${patterns.join(', ')} and there is no history yet. Ensure your test step runs BEFORE this step and writes reports.`,
    );
    return;
  }
  const outcome = ingestReports(files, cfg, storeDir, {
    commitSha: gh.sha,
    branch: gh.ref.replace('refs/heads/', ''),
    ciRunId: gh.runId,
  });
  for (const w of outcome.warnings) core.warning(w);
  const verdicts = outcome.verdicts;

  // 4. new-flake diff, fresh snapshot
  const newFlakes = computeNewFlakes(verdicts, previous);
  // the store dir only exists once something was appended — a first run whose
  // matched reports all failed to parse must not die with ENOENT here
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(snapshotPath(storeDir), JSON.stringify(verdicts), 'utf8');
  recordBaseline(storeDir, gh.runId, previous);

  // 5. save history cache under this attempt's own key
  if (useCache) await saveHistory(cache, core, storeDir, saveKey);

  // 6. outputs + summary
  const flakyCount = verdicts.filter((v) => v.classification.startsWith('flaky-')).length;
  const failingCount = verdicts.filter(
    (v) => v.classification === 'failing' || v.classification === 'new-failure',
  ).length;
  core.setOutput('flaky-count', flakyCount);
  core.setOutput('new-flaky-count', newFlakes.length);
  core.setOutput('failing-count', failingCount);
  const reportJsonPath = path.resolve(cwd, 'flakefinder-report.json');
  writeFileSync(reportJsonPath, renderJson(verdicts, cfg), 'utf8');
  core.setOutput('report-json', reportJsonPath);

  await core.summary.addRaw(jobSummaryHtml(verdicts, newFlakes.length, failingCount)).write();

  // 7. dashboard artifact — BEFORE the comment, which only mentions it if
  // the upload actually happened
  let dashboardArtifact: string | undefined;
  if (core.getBooleanInput('upload-dashboard')) {
    try {
      const runs = outcome.store
        .runs()
        .slice(-50)
        .map((r) => ({
          runId: r.runId,
          timestamp: r.timestamp,
          commitSha: r.commitSha,
          passCount: r.results.filter((t) => t.status === 'pass').length,
          failCount: r.results.filter((t) => t.status === 'fail' || t.status === 'error').length,
        }));
      const html = renderDashboard({
        generatedAt: new Date().toISOString(),
        flakefinderVersion: FLAKEFINDER_VERSION,
        verdicts,
        runs,
      });
      const htmlPath = path.resolve(cwd, 'flakefinder-dashboard.html');
      writeFileSync(htmlPath, html, 'utf8');
      const client = new artifact.DefaultArtifactClient();
      await client.uploadArtifact('flakefinder-dashboard', [htmlPath], cwd, {
        retentionDays: 30,
      });
      dashboardArtifact = 'flakefinder-dashboard';
    } catch (err) {
      core.warning(`dashboard upload failed: ${(err as Error).message}`);
    }
  }

  // 8. PR comment
  if (core.getBooleanInput('comment') && gh.isPr) {
    const token = core.getInput('github-token');
    try {
      const result = await upsertPrComment(
        token,
        buildPrComment(verdicts, previous, { dashboardArtifact }),
        gh,
      );
      core.info(`PR comment: ${result}`);
    } catch (err) {
      core.warning(`PR comment failed (check token permissions): ${(err as Error).message}`);
    }
  }

  // 9. fail gate
  if (core.getBooleanInput('fail-on-new-flakes') && newFlakes.length > 0) {
    core.setFailed(newFlakesFailure(newFlakes));
  }
}

function storeDirFiles(storeDir: string): number {
  try {
    return readFileSync(path.join(storeDir, 'history.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

actionMain().catch((err: Error) => {
  core.setFailed(`flakefinder action: ${err.message}`);
});
