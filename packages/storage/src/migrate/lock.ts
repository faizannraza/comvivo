/**
 * `migrations.lock.json` — the released-migration checksum lock (`02` §3.12.1).
 *
 * The rule it enforces: **generated SQL is committed and never edited after release.** The reason
 * is not tidiness. A host who has already applied `0004` and then upgrades to a build where
 * `0004` says something different ends up with a schema that matches neither a fresh install nor
 * what their `_schema_migrations` row claims — and the runner's own checksum check (which compares
 * against what that host applied) cannot help the *next* host, who applies the edited version and
 * silently gets a different database from everyone who upgraded.
 *
 * The lock catches it in CI, before release, which is the only place it can be caught once.
 *
 * ## Why it is empty today
 *
 * Nothing is released. Before the first release a migration may still be regenerated — `M1-T11`
 * and `M1-T12` did exactly that, repeatedly — and locking entries now would make later schema work
 * fight a guard protecting nobody. The *mechanism* is complete and tested against synthetic locks,
 * so the first release adds data rather than also debugging the wiring. `M14-T4` owns that step.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StorageError } from '@comvivo/shared';
import type { MigrationSource } from './source.js';

/** One locked migration. */
export interface LockEntry {
  /** sha256 of the migration file, as `checksumOf` computes it. */
  readonly checksum: string;
  /** The release that first shipped it, e.g. `v0.1.0`. */
  readonly release: string;
}

export interface MigrationLock {
  readonly released: Readonly<Record<string, LockEntry>>;
}

/** How a locked migration can disagree with the files on disk. */
export interface LockViolation {
  readonly id: string;
  readonly kind: 'missing' | 'checksum';
  readonly expected: string;
  readonly actual: string;
}

/** Read the lock, treating an absent file as an empty lock. */
export function readLock(path: string): MigrationLock {
  if (!existsSync(path)) return { released: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MigrationLock>;
  return { released: parsed.released ?? {} };
}

/**
 * Every way the lock and the files disagree.
 *
 * Returns the full list rather than throwing on the first, because a reordered release produces
 * several at once and fixing them one CI run at a time is how a developer gives up and deletes the
 * lock.
 *
 * Note the asymmetry: a migration **on disk but not in the lock** is fine — that is every
 * unreleased migration. Only a locked id that has changed or vanished is a violation.
 */
export function lockViolations(
  lock: MigrationLock,
  source: MigrationSource,
): readonly LockViolation[] {
  const onDisk = new Map(source.list().map((migration) => [migration.id, migration.checksum]));
  const violations: LockViolation[] = [];
  for (const [id, entry] of Object.entries(lock.released)) {
    const actual = onDisk.get(id);
    if (actual === undefined) {
      violations.push({ id, kind: 'missing', expected: entry.checksum, actual: '(absent)' });
      continue;
    }
    if (actual !== entry.checksum) {
      violations.push({ id, kind: 'checksum', expected: entry.checksum, actual });
    }
  }
  return violations;
}

/** Throw if the lock and the files disagree. */
export function assertLockMatches(lock: MigrationLock, source: MigrationSource): void {
  const violations = lockViolations(lock, source);
  if (violations.length === 0) return;
  throw new StorageError(
    'MIGRATION_CHECKSUM_MISMATCH',
    `${String(violations.length)} released migration(s) no longer match migrations.lock.json`,
    {
      hint:
        'A migration that has already shipped was edited or removed. Revert it and add a new ' +
        'migration instead: upgrades are forward-only, and a host who applied the old version ' +
        'would end up with a different schema from one who applies the new.',
      detail: {
        violations: violations.map((entry) => `${entry.id}:${entry.kind}`).join(', '),
      },
    },
  );
}

/**
 * The lock a release would write: every current migration, at the given release.
 *
 * Existing entries win, so re-running this at a later release does not re-stamp an older
 * migration with a newer version — the lock records *when a migration first shipped*, which is
 * what makes "never edited after release" checkable.
 */
export function lockFor(
  lock: MigrationLock,
  source: MigrationSource,
  release: string,
): MigrationLock {
  const released: Record<string, LockEntry> = { ...lock.released };
  for (const migration of source.list()) {
    released[migration.id] ??= { checksum: migration.checksum, release };
  }
  return { released };
}

/** Write a lock, with the comment preserved so the file keeps explaining itself. */
export function writeLock(path: string, lock: MigrationLock, comment: string): void {
  writeFileSync(path, `${JSON.stringify({ $comment: comment, ...lock }, null, 2)}\n`);
}
