/**
 * File-backed throwaway databases (`11` §3.1.8).
 *
 * `createTestDb` returns an in-memory clone, which is right for almost every test and wrong for a
 * specific set: `11` §3.1.8 names WAL behaviour, `SQLITE_BUSY` and lock contention, backup
 * (`VACUUM INTO`) and crash tests. None of those exist in memory — `journal_mode = WAL` silently
 * stays `memory`, there is no second connection to contend with, and `VACUUM INTO` has no source
 * file. A test of those against `:memory:` passes while testing nothing.
 *
 * The directory name carries the Vitest worker id, because the suites run in parallel processes
 * and two workers sharing a path would delete each other's databases mid-test.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@comvivo/shared';

/** Every directory handed out, so a suite can clean up without tracking them itself. */
const handedOut: string[] = [];

/**
 * The Vitest worker id, or `0` outside Vitest.
 *
 * `VITEST_POOL_ID` is what Vitest sets per worker process. `11` §3.1.8 writes the directory as
 * `…-test-<worker>-<n>`, and the worker part is what keeps two parallel processes apart.
 */
function workerId(): string {
  return process.env['VITEST_POOL_ID'] ?? '0';
}

/**
 * A fresh directory for one test's database files.
 *
 * A directory rather than a bare file because SQLite writes siblings — `-wal` and `-shm` — and a
 * crash test needs to inspect or delete them individually.
 */
export function createTmpDbDir(): string {
  const path = mkdtempSync(join(tmpdir(), `${BRAND.slug}-test-${workerId()}-`));
  handedOut.push(path);
  return path;
}

/** A path for a file-backed database, inside a fresh directory. `02` §3.7's name is `comvivo.db`. */
export function createTmpDbFile(name = `${BRAND.slug}.db`): string {
  return join(createTmpDbDir(), name);
}

/**
 * Remove every directory handed out so far, and return how many.
 *
 * Call from `afterEach`. Removal is best-effort (`force`) because a crash test may have left a
 * file held open by a process that is already gone, and failing the teardown would hide the
 * assertion that actually mattered.
 */
export function cleanupTmpDbs(): number {
  const paths = handedOut.splice(0);
  for (const path of paths) rmSync(path, { recursive: true, force: true });
  return paths.length;
}
