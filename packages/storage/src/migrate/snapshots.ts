/**
 * Released database snapshots, for the upgrade tests (`02` §3.12.6, `11` §3.1.8).
 *
 * `02` §3.12.6 writes the path as `fixtures/db/v<v>.db.gz` and `11` §3.1.8 as
 * `fixtures/db-snapshots/v*.sqlite`. Reconciled at `M1-T14` to
 * **`fixtures/db-snapshots/v<version>.sqlite.gz`**: `11`'s directory (it owns test fixtures) with
 * `02`'s compression, because these files are committed and a snapshot of a real schema
 * compresses by roughly ten to one.
 *
 * The list is empty until the first release. `scripts/make-db-snapshot.ts` produces a snapshot and
 * `M14-T4` wires it into the release workflow.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Where released snapshots live. */
export const SNAPSHOT_DIR = join(REPO_ROOT, 'fixtures/db-snapshots');

/** `v0.1.0.sqlite.gz` and friends. */
export const SNAPSHOT_PATTERN = /^v\d+\.\d+\.\d+\.sqlite\.gz$/;

/**
 * Every released snapshot, oldest first.
 *
 * Sorted by semantic version rather than by string, so `v0.10.0` comes after `v0.9.0` — the
 * lexicographic order would upgrade them in the wrong sequence and the failure would look like a
 * migration bug.
 */
export function snapshotFixtures(directory: string = SNAPSHOT_DIR): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => SNAPSHOT_PATTERN.test(name))
    .sort(compareVersions)
    .map((name) => join(directory, name));
}

/** Compare `vMAJOR.MINOR.PATCH.sqlite.gz` names numerically. */
export function compareVersions(left: string, right: string): number {
  const parse = (name: string) =>
    (name.match(/^v(\d+)\.(\d+)\.(\d+)/)?.slice(1) ?? ['0', '0', '0']).map(Number);
  const [lm = 0, ln = 0, lp = 0] = parse(left);
  const [rm = 0, rn = 0, rp = 0] = parse(right);
  return lm - rm || ln - rn || lp - rp;
}
