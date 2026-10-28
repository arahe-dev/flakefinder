import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { detectRunner } from '../config.js';
import { classifyAll } from '../engine/classify.js';
import { detectParser } from '../parsers/index.js';
import { exclusionArgs, QuarantineManager } from '../quarantine/manager.js';
import { HistoryStore } from '../store/history-store.js';
import type {
  QuarantineEntry,
  ResolvedConfig,
  RunRecord,
  TestStatus,
  TestVerdict,
} from '../types.js';
import { matchGlobs } from '../util/glob.js';
import { failedNamesOf, failedOnlyArgs } from './adapters.js';

export interface LiveRunResult {
  attempts: RunRecord[];
  /**
   * 0 clean/flakes-only, 1 deterministic failure (or flakes with
   * failOnFlakes), 2 the test command could not be started at all (usage /
   * environment error — nothing was recorded), 130 interrupted.
   */
  finalExitCode: number;
  verdicts: TestVerdict[];
  usedReportFiles: string[];
  suiteFlake: boolean;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
  sha: string | null;
}

function statOf(file: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null; // gone
  }
}

function shaOf(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Report-change detection, stat-first: size+mtime identify unchanged files
 * without re-reading them; sha256 runs only when the stat differs. Walking
 * the globs on EVERY attempt is deliberate — that is how newly created
 * report files are caught.
 */
function snapshotReports(
  cwd: string,
  cfg: ResolvedConfig,
  previous?: Map<string, FileStamp>,
): Map<string, FileStamp> {
  const snapshot = new Map<string, FileStamp>();
  for (const file of matchGlobs(cwd, cfg.reports)) {
    const stat = statOf(file);
    if (!stat) continue; // vanished between walk and stat
    const prev = previous?.get(file);
    if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs && prev.sha !== null) {
      snapshot.set(file, prev); // unchanged: reuse the hash, skip the read
      continue;
    }
    snapshot.set(file, { ...stat, sha: shaOf(file) });
  }
  return snapshot;
}

/** Tokens that only a shell can interpret (redirects, pipes, command chaining). */
function needsShell(command: string[]): boolean {
  return command.some((t) => /[<>|&]/.test(t) || isShellOperator(t));
}

/**
 * A token that IS a shell operator (must stay unquoted in shell mode): control
 * operators (`|`, `||`, `|&`, `&`, `&&`, `;`) and redirects, where digits are
 * only allowed as an fd prefix or dup target (`>`, `>>`, `2>`, `2>&1`, `>&2`,
 * `&>`, `<`). A bare number like the `2` in `--maxWorkers 2` is an argument.
 */
export function isShellOperator(token: string): boolean {
  return /^(?:\|\|?|\|&|&&?|;|&>>?|\d*(?:<<?|>>?|>\||<>)(?:&(?:\d+|-))?)$/.test(token);
}

/**
 * Insert runner args (flag/value pairs) into the command: package-manager
 * wrappers get a `--` separator first (unless the command already has one),
 * and shell operators split the command
 * into segments — the args must join the RUNNER's segment (the first one),
 * not the last shell word. Injection matches whole operator tokens only, so
 * an argument VALUE like `w1&&w2` is never mistaken for a segment boundary.
 */
export function insertRunnerArgs(command: string[], args: string[]): string[] {
  if (args.length === 0) return [...command];
  const opIdx = command.findIndex((t) => isShellOperator(t));
  const insertAt = opIdx === -1 ? command.length : opIdx;
  // `npm test -- --ci` already forwards everything after its `--`: a second
  // separator would reach the runner as a literal `--` argument
  const hasSeparator = command.slice(1, insertAt).includes('--');
  const separator = isPackageManagerWrapper(command) && !hasSeparator ? ['--'] : [];
  return [...command.slice(0, insertAt), ...separator, ...args, ...command.slice(insertAt)];
}

/**
 * Spawn the test command. Prefer NO shell (argv passes verbatim — no quoting
 * hazards); fall back to shell mode when the command contains shell operators
 * OR the spawn is refused (Windows blocks .cmd shims like npm/yarn without a
 * shell — EINVAL since the CVE-2024-27980 fix). In shell mode every token is
 * shell-quoted EXCEPT operator tokens — so user values with metacharacters
 * (e.g. `w1&&w2`) and injected regex patterns (with `^!()`) survive cmd.exe.
 */
/**
 * POSIX: every attempt runs in its OWN process group (spawn `detached`), so a
 * timeout or Ctrl-C can signal the whole tree — `npm` → `sh` → `jest` →
 * workers — not just the direct child (killing only `npm` orphans the rest,
 * which keep running and, holding the inherited stdio, keep the attempt from
 * ever closing). Windows has no process groups; taskkill /T walks the tree.
 */
const USE_PROCESS_GROUP = process.platform !== 'win32';

/** Send `signal` to the child's process group, falling back to the child alone. */
function signalTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (USE_PROCESS_GROUP) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // group already gone (ESRCH) or not ours — try the direct child
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already exited
  }
}

/**
 * Kill a child and its whole process tree, cross-platform. POSIX sends
 * `signal` (SIGTERM for timeouts; Ctrl-C forwards SIGINT so runners can
 * clean up) to the process group, escalating to SIGKILL after 3s.
 */
function killTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // child.kill() only reaches the direct process — cmd chains survive it
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    if (r.error || r.status !== 0) child.kill();
    return;
  }
  signalTree(child, signal);
  const escalated = setTimeout(() => signalTree(child, 'SIGKILL'), 3000);
  escalated.unref();
}

/**
 * Sentinel resolved by spawnCommand when the command could not be started at
 * all — distinct from every real exit code (a test command may legitimately
 * exit 2). Never stored or compared as an exit code.
 */
export const SPAWN_FAILED = -2;

/** Exit code a shell uses for "command not found" (POSIX sh 127, cmd.exe 9009). */
const SHELL_NOT_FOUND = process.platform === 'win32' ? 9009 : 127;

function spawnCommand(
  command: string[],
  cwd: string,
  timeoutSeconds: number | null,
  currentChild: { ref: ReturnType<typeof spawn> | null },
): Promise<number> {
  const shellArgv = shellArgvFor(command, cwd);
  return new Promise((resolve) => {
    const done = (code: number): void => {
      if (currentChild.ref) currentChild.ref = null;
      resolve(code);
    };
    // set when the direct (no-shell) spawn failed with ENOENT and we retried
    // through the shell: if the shell then also reports "not found", the
    // command genuinely does not exist — that is a could-not-start, not a
    // test failure.
    let directNotFound = false;
    const start = (argv: string[], useShell: boolean): void => {
      let abandoned = false; // once we fall back to shell mode, ignore this attempt's events
      let timedOut = false;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(argv[0]!, argv.slice(1), {
          shell: useShell,
          cwd,
          detached: USE_PROCESS_GROUP,
          // a background process group that reads the terminal is stopped
          // (SIGTTIN) — test runs get EOF on stdin instead of hanging
          stdio: [
            USE_PROCESS_GROUP && process.stdin.isTTY ? 'ignore' : 'inherit',
            'inherit',
            'inherit',
          ],
        });
      } catch (err) {
        // synchronous EINVAL for Windows batch shims without a shell
        if (!useShell) {
          start(shellArgv, true);
          return;
        }
        console.error(`flakefinder: failed to start command: ${(err as Error).message}`);
        done(SPAWN_FAILED);
        return;
      }
      currentChild.ref = child;
      const timer =
        timeoutSeconds != null
          ? setTimeout(() => {
              timedOut = true;
              console.error(
                `flakefinder: attempt timed out after ${timeoutSeconds}s — killing the process tree`,
              );
              killTree(child);
            }, timeoutSeconds * 1000)
          : null;
      const finish = (code: number): void => {
        if (timer) clearTimeout(timer);
        done(timedOut ? 124 : code);
      };
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (!useShell && (err.code === 'ENOENT' || err.code === 'EINVAL')) {
          abandoned = true;
          if (err.code === 'ENOENT') directNotFound = true;
          if (timer) clearTimeout(timer);
          start(shellArgv, true);
          return;
        }
        if (err.code === 'ENOENT') {
          console.error(
            `flakefinder: command not found: ${argv[0]!} — is it installed and on PATH?`,
          );
        } else {
          console.error(`flakefinder: failed to start command: ${err.message}`);
        }
        if (timer) clearTimeout(timer);
        done(SPAWN_FAILED);
      });
      child.on('close', (code) => {
        if (abandoned) return; // superseded by the shell fallback
        if (useShell && directNotFound && code === SHELL_NOT_FOUND && !timedOut) {
          if (timer) clearTimeout(timer);
          console.error(
            `flakefinder: command not found: ${command[0]!} — is it installed and on PATH?`,
          );
          done(SPAWN_FAILED);
          return;
        }
        finish(code ?? 1);
      });
    };
    const useShell = needsShell(command);
    start(useShell ? shellArgv : command, useShell);
  });
}

/**
 * Live flake detection (PLAN §8): run the command, re-run failing attempts up
 * to `retries` extra times, and ingest report files that changed between
 * attempts. Verdicts are restricted to tests observed in THIS invocation while
 * the full history is still persisted.
 */
export async function runLive(
  command: string[],
  cfg: ResolvedConfig,
  opts: { retries: number; cwd: string; applyQuarantine: boolean },
): Promise<LiveRunResult> {
  const cwd = path.resolve(opts.cwd);
  const runId = randomUUID();

  let commitSha: string | undefined;
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (git.status === 0) commitSha = git.stdout.trim();

  const runner = cfg.runner === 'auto' ? detectRunner(cwd) : cfg.runner;
  let quarantineFlags: string[] = [];
  let quarantinedNames: string[] = [];
  let quarantinedIds = new Set<string>();
  if (opts.applyQuarantine) {
    const entries = loadQuarantine(path.resolve(cwd, cfg.quarantineFile));
    quarantinedIds = new Set(entries.map((e) => e.testId));
    if (runner === 'pytest' || runner === 'jest' || runner === 'mocha') {
      if (entries.length > 0) {
        quarantineFlags = exclusionArgs(runner, entries, cwd);
        quarantinedNames = entries.map((e) => e.name);
        console.log(
          `flakefinder: quarantine active — excluding ${entries.length} quarantined test(s) via runner flags`,
        );
      }
    } else if (runner === 'go' || runner === 'generic') {
      if (entries.length > 0) {
        console.log(
          `flakefinder: quarantine has entries but runner "${runner}" has no per-test exclusion — report only`,
        );
      }
    }
  }

  if (cfg.reports.length === 0) {
    console.warn(
      `flakefinder: no report globs configured — per-test detection disabled. Run ${'`flakefinder init`'} to set up report parsing.`,
    );
  }

  const attempts: RunRecord[] = [];
  const usedReportFiles = new Set<string>();
  const exitCodes: number[] = [];
  let snapshot = snapshotReports(cwd, cfg);
  const maxAttempts = Math.max(1, opts.retries + 1);
  const currentChild: { ref: ReturnType<typeof spawn> | null } = { ref: null };
  let interrupted = false;
  let warnedSelectorClash = false;
  let notedSelectorMerge = false;
  // the child runs in its own process group (POSIX), so the terminal's Ctrl-C
  // reaches only us: forward the signal to the whole tree ourselves
  const onInterrupt = (signal: NodeJS.Signals): void => {
    interrupted = true;
    if (currentChild.ref) killTree(currentChild.ref, signal);
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Attempt 1 runs the full suite (with quarantine exclusions). Attempts 2+
      // re-run ONLY the failed tests via runner-native selectors when an adapter
      // exists and retryMode allows it — otherwise the full command again.
      let extraArgs = quarantineFlags;
      let note = '';
      if (attempt > 1 && cfg.retryMode !== 'full') {
        // the PREVIOUS attempt's failures only: a test that failed on 1 and
        // passed on 2 is already rescued — re-running it on 3 wastes time
        const previous = attempts.filter((r) => r.attempt === attempt - 1);
        const failed = failedNamesOf(previous).filter((n) => !quarantinedNames.includes(n));
        const targeted = failedOnlyArgs(runner, failed, quarantinedNames);
        const targetedChars = targeted ? targeted.reduce((n, a) => n + a.length + 1, 0) : 0;
        if (targeted && targetedChars > SELECTOR_BUDGET_CHARS) {
          // thousands of failures make a selector the OS refuses to exec
          // (E2BIG: Linux caps ONE argument at 128 KiB; cmd.exe a whole line
          // at 8191 chars) — a full re-run is slower but always startable
          note = `full re-run (${failed.length} failures: selector would be ${targetedChars} chars, over the ${SELECTOR_BUDGET_CHARS}-char budget)`;
        } else if (targeted) {
          extraArgs = targeted;
          note = `targeted: re-running ${failed.length} failed test(s)`;
        } else if (failed.length === 0) {
          note = 'full re-run (no failures recorded)';
        } else {
          if (cfg.retryMode === 'failed') {
            console.warn(
              `flakefinder: no targeted-rerun adapter for runner "${runner}" — falling back to a full re-run`,
            );
          }
          note = 'full re-run (no targeted adapter)';
        }
      }
      // a user's own -t/--grep would be overridden (or, for jest, combined
      // into a filter that matches nothing): fold it into ours instead
      const merged = mergeUserSelector(command, extraArgs);
      if (merged.userPatterns.length > 0 && !notedSelectorMerge) {
        notedSelectorMerge = true;
        console.log(
          `flakefinder: combined your own ${extraArgs[0]!} filter with flakefinder's selector (both must match)`,
        );
      }
      const runCommand = merged.command;
      extraArgs = merged.extraArgs;
      if (!warnedSelectorClash && userSelectorClash(runCommand, extraArgs)) {
        warnedSelectorClash = true;
        console.warn(
          `flakefinder: your command already passes a name selector; flakefinder's injected ${extraArgs[0]!} (quarantine exclusion / targeted re-run) is appended after it and most runners keep only the LAST one — combine them yourself or use --no-quarantine / --retry-mode full`,
        );
      }
      const built = insertRunnerArgs(runCommand, extraArgs);
      console.log(
        dim(
          `flakefinder: attempt ${attempt}/${maxAttempts}${note ? ` (${note})` : ''} → ${truncateForLog(built.join(' '))}`,
        ),
      );
      let code = await spawnCommand(built, cwd, cfg.timeoutSeconds, currentChild);
      if (code === SPAWN_FAILED) {
        if (attempt === 1) {
          // nothing ran, so there is nothing to record or classify: this is a
          // usage/environment error (exit 2), not a test failure (exit 1)
          return {
            attempts: [],
            finalExitCode: 2,
            verdicts: [],
            usedReportFiles: [],
            suiteFlake: false,
          };
        }
        // a RETRY could not start (binary removed mid-run?): count it as a
        // failed attempt — the sentinel must never reach the exit-code math —
        // and stop retrying; earlier attempts' evidence is still recorded
        code = 1;
        exitCodes.push(code);
        break;
      }
      if (code === 127 || code === 9009) {
        console.error(
          `flakefinder: exit ${code} usually means the command was not found — check spelling and PATH`,
        );
      }
      exitCodes.push(code);

      const after = snapshotReports(cwd, cfg, snapshot);
      for (const [file, stamp] of after) {
        // Attempt 1: skip files that already existed pre-run with identical
        // content (stale reports from a previous job). Attempts 2+: ingest
        // EVERY matched file — the command ran again, so the report state is
        // a new attempt observation even when byte-identical (a fail-fail-
        // pass retry with a deterministic report must still be detected).
        if (attempt === 1 && snapshot.get(file)?.sha === stamp.sha) continue;
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch (err) {
          console.warn(`flakefinder: cannot read report ${file}: ${(err as Error).message}`);
          continue;
        }
        const parser = detectParser(content);
        if (!parser) {
          console.warn(`flakefinder: unrecognized report format — skipped ${file}`);
          continue;
        }
        const { results, warnings } = parser.parse(content, file);
        for (const w of warnings) console.warn(`flakefinder: ${parser.name}: ${w}`);
        attempts.push({
          runId,
          timestamp: new Date().toISOString(),
          source: 'live',
          parsedFrom: parser.name,
          attempt,
          commitSha,
          results,
        });
        usedReportFiles.add(file);
      }
      snapshot = after;
      if (interrupted) break; // Ctrl-C: stop the retry loop, keep the evidence
      if (code === 0) break;
    }
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }

  const store = new HistoryStore(path.resolve(cwd, cfg.storeDir));
  for (const record of attempts) store.append(record);
  store.prune(cfg.maxRuns);

  const all = classifyAll(store.runs(), cfg);
  const invocationIds = new Set(attempts.flatMap((r) => r.results.map((t) => t.testId)));
  const verdicts = all.filter((v) => invocationIds.has(v.testId));

  const suiteFlake =
    usedReportFiles.size === 0 && exitCodes.some((c) => c === 0) && exitCodes.some((c) => c !== 0);
  if (suiteFlake) {
    console.warn(
      'flakefinder: no report files matched — suite-level verdict only (exits varied across attempts).',
    );
  }

  const lastExit = exitCodes[exitCodes.length - 1] ?? 1;
  // The last REAL (non-skip) outcome of each test in this invocation. A retry
  // that did not actually re-run a test (selector missed, runner reports the
  // rest as skipped) is not evidence that its failure went away.
  const lastRealStatus = new Map<string, TestStatus>();
  for (const record of [...attempts].sort((a, b) => a.attempt - b.attempt)) {
    for (const t of record.results) if (t.status !== 'skip') lastRealStatus.set(t.testId, t.status);
  }
  // Deterministic failure = the test's last real execution failed and nothing
  // proved it flaky. The final attempt ingesting nothing (stale or deleted
  // report) or only skips must NOT erase the failure evidence: exit 0 is
  // reserved for "clean run or all failures were flakes".
  // The exit gates only judge tests that actually EXECUTED in this invocation
  // and are not quarantined: a quarantined test the runner reports as skipped
  // (jest-junit lists excluded tests) must not fail --fail-on-flake on its
  // historical flakiness — keeping it out of the gate is what quarantine is for.
  const gated = verdicts.filter(
    (v) => lastRealStatus.has(v.testId) && !quarantinedIds.has(v.testId),
  );
  const deterministicFail = gated.some((v) => {
    const last = lastRealStatus.get(v.testId);
    return (
      (v.classification === 'failing' || v.classification === 'new-failure') &&
      (last === 'fail' || last === 'error')
    );
  });
  let finalExitCode = deterministicFail || lastExit !== 0 ? 1 : 0;
  if (interrupted) finalExitCode = 130; // SIGINT/SIGTERM: convention for user interrupts
  if (
    cfg.failOnFlakes &&
    (gated.some((v) => v.classification.startsWith('flaky-')) || suiteFlake)
  ) {
    finalExitCode = 1;
  }

  return {
    attempts,
    finalExitCode,
    verdicts,
    usedReportFiles: [...usedReportFiles],
    suiteFlake,
  };
}

/** Name-selector flags per injected flag: jest -t, mocha --grep, go -run. */
const SELECTOR_ALIASES: Record<string, string[]> = {
  '-t': ['-t', '--testNamePattern'],
  '--grep': ['--grep', '-g', '--fgrep', '-f'],
  '-run': ['-run', '--run'],
};

/** Literal-string selector flags (mocha --fgrep): their value is not a regex. */
const LITERAL_SELECTORS = new Set(['--fgrep', '-f']);

/**
 * Fold a user-supplied jest `-t` / mocha `--grep` (in the runner's segment)
 * into the selector flakefinder injects, so both apply: each user pattern
 * becomes a lookahead in front of ours (`^(?=[\s\S]*?(?:user))…`), which
 * keeps the runners' unanchored "search" semantics for the user's part.
 * The user's flag tokens are removed from the command. Go `-run` (slash
 * semantics) and mocha `--invert` are left alone — userSelectorClash warns.
 */
export function mergeUserSelector(
  command: string[],
  extraArgs: string[],
): { command: string[]; extraArgs: string[]; userPatterns: string[] } {
  const unchanged = { command, extraArgs, userPatterns: [] as string[] };
  const flag = extraArgs[0];
  const ours = extraArgs[1];
  if ((flag !== '-t' && flag !== '--grep') || ours === undefined || !ours.startsWith('^')) {
    return unchanged;
  }
  const aliases = SELECTOR_ALIASES[flag]!;
  const opIdx = command.findIndex((t) => isShellOperator(t));
  const end = opIdx === -1 ? command.length : opIdx;
  if (flag === '--grep' && command.slice(1, end).some((t) => t === '--invert' || t === '-i')) {
    return unchanged;
  }
  const kept: string[] = [command[0]!];
  const userPatterns: string[] = [];
  for (let i = 1; i < end; i++) {
    const t = command[i]!;
    const alias = aliases.find((a) => t === a || t.startsWith(`${a}=`));
    if (!alias) {
      kept.push(t);
      continue;
    }
    let value: string | undefined;
    if (t === alias) {
      value = command[i + 1];
      if (value === undefined || i + 1 >= end) {
        kept.push(t); // dangling flag: leave it for the runner to complain about
        continue;
      }
      i++;
    } else {
      value = t.slice(alias.length + 1);
    }
    if (LITERAL_SELECTORS.has(alias)) value = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else if (flag === '--grep') value = value.replace(/^\/(.*)\/[a-z]*$/s, '$1'); // mocha "/re/flags"
    userPatterns.push(value);
  }
  if (userPatterns.length === 0) return unchanged;
  const lookaheads = userPatterns.map((p) => `(?=[\\s\\S]*?(?:${p}))`).join('');
  return {
    command: [...kept, ...command.slice(end)],
    extraArgs: [flag, `^${lookaheads}${ours.slice(1)}`, ...extraArgs.slice(2)],
    userPatterns,
  };
}

/**
 * True when flakefinder is about to inject a name selector that the user's
 * command (runner segment) already sets — runners keep only one of them.
 */
export function userSelectorClash(command: string[], extraArgs: string[]): boolean {
  const aliases = SELECTOR_ALIASES[extraArgs[0] ?? ''];
  if (!aliases) return false;
  const opIdx = command.findIndex((t) => isShellOperator(t));
  const segment = command.slice(1, opIdx === -1 ? command.length : opIdx);
  return segment.some((t) => aliases.some((a) => t === a || t.startsWith(`${a}=`)));
}

/**
 * The quarantine entries for a run. An unreadable/corrupt file (e.g. torn by
 * a crash mid-write before saves were atomic, or hand-edited) must not stop
 * the test run: warn and run without exclusions. `doctor` still reports it
 * as a FAIL, and `quarantine add/remove` still refuse to overwrite it.
 */
function loadQuarantine(file: string): QuarantineEntry[] {
  try {
    return new QuarantineManager(file).list();
  } catch (err) {
    console.warn(
      `flakefinder: ${(err as Error).message} — running WITHOUT quarantine exclusions (see \`flakefinder doctor\`)`,
    );
    return [];
  }
}

/**
 * Max total length of an injected targeted selector. Linux rejects any single
 * argv string over 128 KiB (MAX_ARG_STRLEN) and Windows cmd.exe lines over
 * 8191 chars; past this budget a full re-run is used instead.
 */
export const SELECTOR_BUDGET_CHARS = process.platform === 'win32' ? 6000 : 32_768;

/** Keep the per-attempt command echo readable when selectors get long. */
function truncateForLog(line: string, max = 400): string {
  return line.length <= max ? line : `${line.slice(0, max)}… (+${line.length - max} chars)`;
}

function dim(s: string): string {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

/** Package-manager commands consume flags themselves; only `--` forwards args to the underlying test runner. */
export function isPackageManagerWrapper(command: string[]): boolean {
  const first = command[0]?.toLowerCase().replace(/\.(cmd|exe)$/, '');
  return first === 'npm' || first === 'yarn' || first === 'pnpm' || first === 'bun';
}

/** Tokens POSIX sh never interprets — left bare for readable logs. */
const POSIX_SAFE = /^[A-Za-z0-9_\-+=.,/:@%]+$/;
/** Tokens cmd.exe and the MSVCRT argv parser never interpret. */
const CMD_SAFE = /^[A-Za-z0-9_\-+./:@]+$/;
/** cmd.exe metacharacters, caret-escaped (same set as cross-spawn). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Quote a single argument for spawn({shell:true}). Every token that is not
 * provably inert is quoted — values here can be attacker-influenced (test
 * names flow into quarantine and re-run patterns), so `` ` ``, `$`, `;`, `*`,
 * `?`, `[`, `~`, newlines etc. must reach the program literally.
 *
 * - POSIX sh: single quotes (nothing is special inside them); an embedded `'`
 *   becomes `'\''`.
 * - win32 cmd.exe: MSVCRT-quote the argument (backslashes before `"` and at
 *   the end are doubled, `"` → `\"`), wrap it in `"`, then caret-escape every
 *   cmd metacharacter INCLUDING the quotes, so cmd never toggles its quote
 *   state and never expands `%VAR%`. `doubleEscape` adds a second caret layer
 *   for batch shims (`npm.cmd`, `jest.cmd`): cmd re-parses `%*` inside them.
 */
export function shellQuote(
  s: string,
  opts: { platform?: NodeJS.Platform; doubleEscape?: boolean } = {},
): string {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32') {
    if (CMD_SAFE.test(s)) return s;
    let a = s.replace(/(\\*)"/g, '$1$1\\"');
    a = a.replace(/(\\*)$/, '$1$1');
    a = `"${a}"`.replace(CMD_META, '^$1');
    return opts.doubleEscape ? a.replace(CMD_META, '^$1') : a;
  }
  if (POSIX_SAFE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Control operators start a new command; redirects do not. */
function isControlOperator(token: string): boolean {
  return /^(?:\|\|?|\|&|&&?|;)$/.test(token);
}

/** A redirect whose NEXT token is its file target (`>`, `2>>`; not `2>&1`). */
function takesRedirectTarget(token: string): boolean {
  return isShellOperator(token) && !isControlOperator(token) && !/&(?:\d+|-)$/.test(token);
}

/**
 * Does `cmd` resolve to a batch file on win32? Mirrors cmd.exe lookup: an
 * explicit extension wins; otherwise cwd then PATH, trying PATHEXT in order.
 */
export function isBatchCommand(
  cmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (/\.(?:cmd|bat)$/i.test(cmd)) return true;
  if (path.extname(cmd) !== '') return false;
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasDir = /[\\/]/.test(cmd);
  const dirs = hasDir ? [''] : [cwd, ...(env.PATH ?? env.Path ?? '').split(';').filter(Boolean)];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, cmd + ext) : path.resolve(cwd, cmd + ext);
      if (existsSync(candidate)) return /^\.(?:cmd|bat)$/i.test(ext);
    }
  }
  return false;
}

/**
 * The argv for shell mode: operators stay bare, everything else is quoted.
 * On win32 a segment's command token is only caret-escaped (cmd must still
 * resolve it), and its arguments are double-escaped when it is a batch shim;
 * redirect targets are single-escaped (cmd opens them itself).
 */
export function shellArgvFor(
  command: string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') {
    return command.map((t) => (isShellOperator(t) ? t : shellQuote(t, { platform })));
  }
  const out: string[] = [];
  let expectCommand = true;
  let redirectTarget = false;
  let batch = false;
  for (const t of command) {
    if (isShellOperator(t)) {
      out.push(t);
      if (isControlOperator(t)) expectCommand = true;
      redirectTarget = takesRedirectTarget(t);
      continue;
    }
    if (redirectTarget) {
      out.push(shellQuote(t, { platform }));
      redirectTarget = false;
    } else if (expectCommand) {
      batch = isBatchCommand(t, cwd);
      out.push(t.replace(CMD_META, '^$1'));
      expectCommand = false;
    } else {
      out.push(shellQuote(t, { platform, doubleEscape: batch }));
    }
  }
  return out;
}
