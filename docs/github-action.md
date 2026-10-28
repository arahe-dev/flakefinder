# flakefinder — GitHub Action

Detect and track flaky tests on every CI run. The action ingests your test
report files, updates a per-branch history cache, comments on PRs with new vs
known flakes, uploads an HTML dashboard artifact, and can fail the job when
*new* flakes appear.

## Quick start

```yaml
name: tests
on: [push, pull_request]
permissions:
  contents: read
  pull-requests: write   # needed for PR comments

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test                       # your tests must write report files
      - name: flakefinder
        uses: DJJW26/flakefinder@main
        if: always()                        # analyze even when tests fail
```

> [!WARNING]
> **Never run this action under `pull_request_target` on untrusted (fork)
> PRs.** `pull_request_target` runs with a write-scoped `GITHUB_TOKEN`, with
> repository secrets, and with access to the base branch's cache. To feed
> flakefinder you have to check out and execute the fork's code (its tests
> write the reports). That code could then steal the token, post or edit
> comments as your bot, and poison the shared history cache. Use the plain
> `pull_request` trigger (shown above): fork PRs get a read-only token, so
> the comment step just warns and the rest of the analysis still runs. If you
> need comments on fork PRs, upload the reports as an artifact and post them
> from a separate `workflow_run` workflow that never executes PR code.

Before the first run, create a `flakefinder.config.json` in your repo (or run
`npx flakefinder init` locally and commit the result) pointing `reports` at the
files your test runner writes, e.g.:

```json
{ "reports": ["junit.xml"], "runner": "jest" }
```

## How the history cache works

The action stores history in `.flakefinder/` and persists it with
`actions/cache`:

- **Save key**: `flakefinder-history-<sha>-<run id>-<run attempt>-<job>`.
  Cache entries are immutable, so every run *attempt* saves under its own
  key. A re-run never collides with the first attempt's entry, so its
  history is not silently dropped.
- **Restore**: by the `flakefinder-history-` prefix. You get the most recent
  cache on your branch, and on a new branch or PR you inherit the base or
  default branch's history (warm start).
- No external service, no upload of your test data. Everything stays inside
  GitHub's cache for your repository.

### What "new flake" is compared against

`new-flaky-count`, the PR comment's Δ column and `fail-on-new-flakes` diff
this run's verdicts against a **baseline**: the verdict snapshot of the
*previous workflow run* (the last run on this branch, or the base branch).

Re-runs keep the same baseline. When you click "Re-run failed jobs", the
newest cache was saved by this run's own first attempt. Its snapshot already
lists the flakes that failed the job, so diffing against it would report
"0 new" and let the re-run pass the gate. To prevent that, each run records
the baseline it used, with its `GITHUB_RUN_ID`, in
`.flakefinder/action-baseline.json`. Later attempts (and other jobs) of the
same run reuse that recorded baseline. So a re-run fails the gate again until
the flake is fixed or quarantined. Later runs (new pushes) compare against
the latest snapshot as usual, so a flake that was reported once counts as
*known* from then on.

Matrix legs of the same job share a save key, so only the first leg's
history is saved (the others log a warning). Give each leg its own
`working-directory`/`storeDir` and job if you need separate histories.

## Inputs

| input | default | description |
|---|---|---|
| `reports` | _(from config)_ | Comma-separated report globs; overrides `flakefinder.config.json` |
| `github-token` | `${{ github.token }}` | Token used for PR comments |
| `fail-on-new-flakes` | `false` | Fail the job when flakes appear that were not flaky in the previous run |
| `comment` | `true` | Upsert a PR comment (found via a hidden marker, never duplicated) |
| `upload-dashboard` | `true` | Upload `flakefinder-dashboard.html` as artifact `flakefinder-dashboard` |
| `history-max-runs` | `300` | History retention (number of runs) |
| `working-directory` | `.` | Directory with config + reports (monorepos) |

All inputs are validated before the action does anything. Booleans must be
`true`/`false`, `history-max-runs` an integer 1–100000, and
`working-directory` must exist. Every problem is listed in one failure
message.

## Outputs

| output | description |
|---|---|
| `flaky-count` | Total flaky tests (confirmed + retry + suspected) |
| `new-flaky-count` | Flakes not flagged in the previous run |
| `failing-count` | Deterministically failing tests |
| `report-json` | Path to the full JSON verdict report |

## PR comment behavior

- One comment per PR, updated in place (marker `<!-- flakefinder:report -->`).
  Only a comment authored by the token's identity (or by a bot account when
  the default `GITHUB_TOKEN` is used) is ever updated. A marker pasted into
  someone else's comment is ignored. Failed API writes are logged as
  warnings.
- Test names and suites are escaped before they are rendered: @mentions,
  links/images and HTML can't be injected. Failure messages sit in a code
  fence longer than any backtick run they contain.
- Summary line: `N flaky (X new · Y known) · M failing · T tracked`.
- Table with per-test score, confidence and Δ vs the previous run.
- `<details>` blocks for up to 5 NEW flakes with the failure message and the
  exact `flakefinder quarantine add <testId>` command.
- Failure messages are scanned for credential shapes (API tokens, JWTs,
  `SECRET_KEY=…` assignments) and redacted before commenting.

## FAQ

**Do I need the config file if I set the `reports` input?**
No — the input overrides it. The config file is still useful for local runs.

**Private repos?** Yes; the default `GITHUB_TOKEN` works. PR comments need the
`pull-requests: write` permission. Comment on fork PRs may fail (token
restrictions) — the action warns and continues. Don't switch to
`pull_request_target` to get around this (see the warning at the top).

**Monorepo?** Set `working-directory` to the package root, or give absolute-ish
globs like `packages/api/junit.xml` relative to the repo root.

**Which report formats?** JUnit XML (pytest, jest-junit, surefire, go-junit…),
Jest/vitest JSON, Mocha JSON, `go test -json` output, **TAP** (e.g.
`node --test --test-reporter=tap > results.tap`; nested subtests become
`parent > child` suites, `# SKIP`/`# TODO` count as skipped) and **TRX**
(.NET, `dotnet test --logger trx`; the suite is the test class name). The
format is detected from file content, so a glob like
`"reports": ["results.tap", "**/TestResults/*.trx"]` is all it takes.

**What if my tests fail?** Add `if: always()` to the flakefinder step so it
still analyzes the reports (that's usually exactly when you want it).
