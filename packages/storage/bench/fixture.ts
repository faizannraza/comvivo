/**
 * The fixture a storage benchmark measures against (`02` §3.16.4, §3.16.5).
 *
 * A file-backed database, because half of §3.16.4's rows are about I/O: the cold-open row is
 * nothing else, the retention chunk writes pages, and the KNN rows are the ones §3.16.4's own note
 * is about — the same query measured 508 ms p50 with an 8 MiB page cache and 5 ms with 192 MiB on
 * an Apple M1, a 100× difference from one pragma. An in-memory database would have no cliff to be
 * on the right side of.
 *
 * Generated once per process and reused: the stress profile takes minutes, and every benchmark
 * here reads rather than writes (the two that write do so inside a transaction they roll back, or
 * on rows they created).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND, SystemClock, TypeIdGenerator } from '@comvivo/shared';
import { SeededRng } from '@comvivo/shared/testing';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import type { Db } from '../src/db/drizzle.js';
import { makeDb } from '../src/db/drizzle.js';
import { openDatabase } from '../src/db/open.js';
import {
  SEED_PROFILES,
  type SeedProfile,
  type SeedReport,
  seedPerfDatabase,
} from '../src/perf/seed.js';
import { silentLogger } from '../src/repos/testing/harness.js';
import { applyMigrations } from '../src/schema/testing/migrated-db.js';

export interface PerfFixture {
  readonly connection: Database;
  readonly db: Db;
  readonly report: SeedReport;
  readonly path: string;
  readonly close: () => void;
}

/**
 * Is this environment variable's value one of the profiles?
 *
 * A type guard rather than `SEED_PROFILES[name as SeedProfile['name']]`, which is what this was:
 * the cast asserts that an arbitrary environment string is a valid key, so the indexed access
 * types as `SeedProfile` and the `=== undefined` check below it became dead code — caught the
 * moment `eslint.config.ts` started type-checking this directory at `M1-T33`. The cast was the
 * bug; the check was right.
 */
function isProfileName(name: string): name is SeedProfile['name'] {
  return Object.hasOwn(SEED_PROFILES, name);
}

/** Which profile a bench run uses. `COMVIVO_BENCH_PROFILE`, defaulting to the small one. */
export function profileFromEnv(): SeedProfile {
  const name = process.env[`${BRAND.envPrefix}BENCH_PROFILE`] ?? 'release-small';
  if (!isProfileName(name)) {
    throw new Error(
      `unknown bench profile ${name}; one of ${Object.keys(SEED_PROFILES).join(', ')}`,
    );
  }
  return SEED_PROFILES[name];
}

/**
 * Build the fixture, or return the one this process already built.
 *
 * A module-level cache, deliberately: `02` §3.16.5's stress profile is minutes of work and every
 * benchmark in this directory reads the same database. The alternative — one fixture per benchmark
 * — would spend an hour to measure a second.
 */
const cache: { fixture?: PerfFixture | undefined } = {};

export function perfFixture(profile: SeedProfile = profileFromEnv()): PerfFixture {
  const existing = cache.fixture;
  if (existing !== undefined && existing.report.profile === profile.name) return existing;
  cache.fixture?.close();

  const dir = mkdtempSync(join(tmpdir(), `${BRAND.slug}-perf-`));
  const path = join(dir, `${BRAND.slug}.db`);
  // Unencrypted: §3.16.4's figures are about the query plans and the page cache, and SQLCipher's
  // cost is a separate measurement (`02` §3.6.4). `M1-T2`'s spike owns that comparison.
  // `openDatabase` returns a descriptor, not the handle: the extra fields are what `02` §3.6.2's
  // boot check reports, and the bench's cold-open row measures this very call.
  const opened = openDatabase({ path, key: null, role: 'main', loadVec: true });
  const connection = opened.db;
  applyMigrations(connection);
  const db = makeDb(connection);
  const clock = new SystemClock();
  // Progress to stderr, not stdout: the runner writes a markdown summary to stdout, and the stress
  // profile is half a minute of silence otherwise. Every tenth of the work, so a slow machine still
  // prints about ten lines.
  let printed = 0;
  const report = seedPerfDatabase(profile, {
    db,
    connection,
    ids: new TypeIdGenerator(clock),
    rng: new SeededRng(profile.seed),
    logger: silentLogger,
    onProgress: (written, total) => {
      const tenth = Math.floor((written / total) * 10);
      if (tenth === printed) return;
      printed = tenth;
      process.stderr.write(`seeding ${profile.name}: ${String(tenth * 10)}%\n`);
    },
  });

  const fixture: PerfFixture = {
    connection,
    db,
    report,
    path,
    close: () => {
      connection.close();
      rmSync(dir, { recursive: true, force: true });
      cache.fixture = undefined;
    },
  };
  cache.fixture = fixture;
  return fixture;
}
