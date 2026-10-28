import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { QuarantineEntry, RunnerKind, TestVerdict } from '../types.js';

interface QuarantineFile {
  version: 1;
  entries: QuarantineEntry[];
}

const EMPTY: QuarantineFile = { version: 1, entries: [] };

/**
 * Manages flakefinder.quarantine.json — the list of tests excluded from runs.
 * Quarantine never edits test source files; exclusion happens via runner
 * flags (see exclusionArgs).
 */
export class QuarantineManager {
  private filePath: string;
  private file: QuarantineFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.file = this.load();
  }

  private load(): QuarantineFile {
    if (!existsSync(this.filePath)) return { ...EMPTY, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as QuarantineFile;
      if (!Array.isArray(parsed.entries)) throw new Error('missing "entries" array');
      return { version: 1, entries: parsed.entries };
    } catch (err) {
      throw new Error(`invalid quarantine file ${this.filePath}: ${(err as Error).message}`);
    }
  }

  list(): QuarantineEntry[] {
    return [...this.file.entries];
  }

  /** Add or replace an entry (same testId). */
  add(entry: QuarantineEntry): void {
    this.file.entries = this.file.entries.filter((e) => e.testId !== entry.testId);
    this.file.entries.push(entry);
  }

  remove(testId: string): boolean {
    const before = this.file.entries.length;
    this.file.entries = this.file.entries.filter((e) => e.testId !== testId);
    return this.file.entries.length < before;
  }

  /**
   * Drop entries that no longer deserve quarantine. Deliberately
   * conservative: quarantined tests are excluded from runs, so "not seen
   * lately" is NOT evidence of health (that would silently un-quarantine
   * everything). An entry leaves quarantine only on positive evidence —
   * the test ran (quarantine disabled or full-suite run) and passed stably —
   * or when the entry is older than 90 days and the test is gone from
   * history. Returns the removed entries.
   */
  prune(verdicts: TestVerdict[], maxAgeDays = 90): QuarantineEntry[] {
    if (verdicts.length === 0) return [];
    const byId = new Map(verdicts.map((v) => [v.testId, v]));
    const removed: QuarantineEntry[] = [];
    const kept: QuarantineEntry[] = [];
    for (const entry of this.file.entries) {
      const v = byId.get(entry.testId);
      const healthy = v !== undefined && v.classification === 'passing' && v.runsObserved >= 10;
      const quarantinedMs = Date.parse(entry.quarantinedAt);
      const agedOut =
        v?.classification === 'gone' &&
        !Number.isNaN(quarantinedMs) &&
        Date.now() - quarantinedMs > maxAgeDays * 86_400_000;
      if (healthy || agedOut) removed.push(entry);
      else kept.push(entry);
    }
    this.file.entries = kept;
    return removed;
  }

  /**
   * Atomic write: a temp file in the same directory, then rename over the
   * target — a crash or a concurrent reader never sees a torn/half-written
   * quarantine file (rename replaces the directory entry in one step).
   */
  save(): void {
    const tmp = `${this.filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(this.file, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Files that mark a pytest rootdir candidate / project root: stop looking upward there. */
const ROOT_MARKERS = ['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg', 'setup.py', '.git'];

/**
 * Does `rel` exist under `cwd` or an ancestor up to the project root?
 * (pytest's rootdir — what node ids are relative to — may sit above cwd.)
 */
function existsUpward(cwd: string, rel: string): boolean {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, rel))) return true;
    const parent = path.dirname(dir);
    if (parent === dir || ROOT_MARKERS.some((m) => existsSync(path.join(dir, m)))) return false;
    dir = parent;
  }
}

/**
 * pytest node id for a quarantined test. `suite` is normally the JUnit
 * classname pytest writes — the rootdir-relative node id with `/` and `::`
 * flattened to dots and `.py` dropped (`tests/test_x.py::TestCls::test_y` →
 * classname `tests.test_x.TestCls`) — so it is un-flattened here: the module
 * is the longest dotted prefix that exists as a `.py` file (from `cwd` up),
 * else everything up to the last non-Capitalized component; the remaining
 * Capitalized components are (nested) classes. A suite that already looks
 * like a node id or path is used verbatim.
 */
export function pytestNodeId(suite: string, name: string, cwd?: string): string {
  if (/[\\/]|::|\.py$/.test(suite)) return `${suite.replace(/\\/g, '/')}::${name}`;
  const parts = suite.split('.').filter((p) => p !== '');
  if (parts.length === 0) return name;
  let moduleEnd = 0;
  if (cwd !== undefined) {
    for (let i = parts.length; i >= 1; i--) {
      if (existsUpward(cwd, `${parts.slice(0, i).join('/')}.py`)) {
        moduleEnd = i;
        break;
      }
    }
  }
  if (moduleEnd === 0) {
    moduleEnd = 1;
    for (let i = parts.length - 1; i >= 1; i--) {
      if (!/^[A-Z]/.test(parts[i]!)) {
        moduleEnd = i + 1;
        break;
      }
    }
  }
  const file = `${parts.slice(0, moduleEnd).join('/')}.py`;
  return [file, ...parts.slice(moduleEnd), name].join('::');
}

/**
 * Runner flags that exclude the quarantined tests from the next run.
 * `cwd` (optional) lets pytest node ids be resolved against the files on
 * disk. go/generic have no per-test exclusion — callers must warn.
 */
export function exclusionArgs(
  runner: Exclude<RunnerKind, 'auto'>,
  entries: QuarantineEntry[],
  cwd?: string,
): string[] {
  if (entries.length === 0) return [];
  switch (runner) {
    case 'pytest': {
      // --deselect takes a rootdir-relative node id (prefix):
      // <path/to/file.py>::[<Class>::]<test>
      const args: string[] = [];
      for (const e of entries) args.push('--deselect', pytestNodeId(e.suite, e.name, cwd));
      return args;
    }
    case 'jest':
    case 'mocha': {
      // jest -t / mocha --grep match against the FULL test name (describe
      // chain + title, space-joined). Anchor each quarantined title as a
      // space-delimited FINAL segment — the same anchoring adapters.ts uses
      // for targeted re-runs — so quarantining "login" excludes "login" and
      // "ui login", but not "login ok works" or "relogin".
      const names = [...new Set(entries.map((e) => escapeRegExp(e.name)))];
      const flag = runner === 'jest' ? '-t' : '--grep';
      return [flag, `^(?!(?:.* )?(?:${names.join('|')})$)`];
    }
    // go / generic: no per-test exclusion — callers must warn
    default:
      return [];
  }
}

export function quarantinePathFor(cwd: string, quarantineFile: string): string {
  return path.resolve(cwd, quarantineFile);
}
