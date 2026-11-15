/**
 * `M3-T1`'s second acceptance criterion: **claim codes are single-use under concurrency**.
 *
 * Its own file, and in real `worker_threads` workers, because "under concurrency" is the whole
 * clause. better-sqlite3 is synchronous, so N redemptions on one connection are N redemptions in a
 * row — and a sequential test passes whether or not the `UPDATE` is conditional at all. What it
 * would be measuring is that the second statement can see the first one's committed row, which is
 * a property of SQLite rather than of this code.
 *
 * Across threads, with `BEGIN IMMEDIATE` (`02` D10) and one connection per thread (`02` D22), the
 * arrangement is the real one. Three facts are then observable and the AC needs all three:
 *
 *  1. exactly one worker is told `ok`;
 *  2. every other is told `already_used` — not `threw`, which is what a lock timeout would look
 *     like, and not `ok`, which is what a read-then-write would produce;
 *  3. the row records **one** redeemer, so no second binding could have been made.
 *
 * `01` §14 **A27** is why the third matters more than it looks: a chat binds only by redeeming one
 * of these, so two winners would be two chats bound to one group — and the second is a chat whose
 * members nobody invited.
 */
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { expectWritten } from '@comvivo/core';
import { SystemClock, TypeIdGenerator } from '@comvivo/shared';
import { sha256 } from '@comvivo/shared/crypto';
import { SeededRng, silentLogger } from '@comvivo/shared/testing';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import {
  workerModule,
  writeSourcePathsTsconfig,
} from '../../../../scripts/support/paths-tsconfig.js';
import { withDataDir } from '../datadir/testing/data-dir.js';
import { makeDb } from '../db/drizzle.js';
import { SqliteStore } from '../db/tx.js';
import { applyMigrations } from '../schema/testing/migrated-db.js';
import { makeRepositories } from './index.js';
import { group, groupId, person, personId } from './testing/harness.js';

const WORKER = new URL('./testing/claim-worker.mjs', import.meta.url);
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;

/** Enough threads to contend, few enough that the suite stays quick on a Pi. */
const WORKERS = 8;

/** How long the workers get to line up before they all begin. */
const LINE_UP_MS = 250;

interface Verdict {
  readonly kind: string;
  readonly id?: string;
  readonly error?: string;
  /** Echoed back, so a winner can be matched against the row it wrote. */
  readonly chat?: string;
}

/**
 * The module the workers import: the build while it is current, the source otherwise.
 *
 * `workerModule` owns the reasoning, and this test is the one that found it — the first version
 * preferred `dist/` unconditionally and passed with the conditional `UPDATE`'s `used_at IS NULL`
 * deleted, because `pnpm typecheck` had just built the correct bytes.
 */
function workerDeps(): string {
  return workerModule(
    new URL('../../dist/repos/testing/worker-deps.js', import.meta.url),
    new URL('./testing/worker-deps.ts', import.meta.url),
    new URL('../', import.meta.url),
  );
}

describe('a claim code under concurrency (M3-T1 AC)', { tags: ['slow'] }, () => {
  it(`is redeemed exactly once by ${String(WORKERS)} threads racing for it`, async () => {
    await withDataDir(async (root) => {
      const path = join(root, 'claims.db');
      const codeHash = sha256('VLG-7K2M-9QXA');
      const seeded = seed(path, codeHash);

      const tsconfig = writeSourcePathsTsconfig(dirname(path), REPO_ROOT, 'tsconfig.worker.json');
      const modulePath = workerDeps();
      const startAt = Date.now() + LINE_UP_MS;
      const workers = Array.from({ length: WORKERS }, (_unused, index) => {
        // A **distinct chat per worker**, so `used_in_chat` identifies which one won. With one
        // shared chat the row would look correct even if two workers had bound two chats to the
        // group, and A27's whole point is that the second chat is one nobody invited.
        const chat = `chat-race-${String(index)}`;
        const worker = new Worker(WORKER, {
          workerData: { path, modulePath },
          execArgv: ['--import', 'tsx'],
          env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
        });
        const verdict = new Promise<Verdict>((resolve, reject) => {
          worker.once('message', (reply: Verdict) => {
            resolve(reply);
          });
          worker.once('error', reject);
        });
        worker.postMessage({
          kind: 'redeem',
          codeHash: [...codeHash],
          channel: 'simulator',
          chat,
          personId: seeded.personId,
          startAt,
        });
        return { worker, verdict, chat };
      });

      let verdicts: readonly Verdict[];
      try {
        verdicts = await Promise.all(
          workers.map(async (each) => ({ ...(await each.verdict), chat: each.chat })),
        );
      } finally {
        await Promise.all(workers.map((each) => each.worker.terminate()));
      }

      const kinds = verdicts.map((verdict) => verdict.kind).toSorted();
      // Named in the message, because the interesting failures are specific: all `threw` means the
      // busy timeout is too short, two `ok` means the write is not conditional, and any `expired`
      // means the fixture's TTL ran out while the workers were starting.
      const report = kinds.join(', ');
      expect(
        kinds.filter((kind) => kind === 'ok'),
        report,
      ).toHaveLength(1);
      expect(
        kinds.filter((kind) => kind === 'already_used'),
        report,
      ).toHaveLength(WORKERS - 1);

      // And the row agrees with the **winner**, not merely with the fixture. One redeemer, one
      // chat — the fact A27 depends on.
      const winner = verdicts.find((verdict) => verdict.kind === 'ok');
      expect(winner, report).toBeDefined();
      const db = new Database(path, { readonly: true });
      try {
        const row = db
          .prepare('SELECT used_at, used_in_chat, used_by_person_id FROM claim_codes WHERE id = ?')
          .get(seeded.codeId) as {
          used_at: number | null;
          used_in_chat: string | null;
          used_by_person_id: string | null;
        };
        expect(row.used_at).not.toBeNull();
        expect(row.used_in_chat).toBe(winner?.chat);
        expect(row.used_by_person_id).toBe(seeded.personId);
      } finally {
        db.close();
      }
    });
  });
});

/** A file-backed database with one group, one person and one unspent host claim code. */
function seed(
  path: string,
  codeHash: Uint8Array,
): { readonly codeId: string; readonly personId: string } {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('trusted_schema = ON');
    sqliteVec.load(db);
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    const drizzle = makeDb(db);
    const clock = new SystemClock();
    const ids = new TypeIdGenerator(clock);
    const rng = new SeededRng(7);
    const repos = makeRepositories({ db: drizzle, connection: db, ids, rng, clock });
    const store = new SqliteStore({ db, clock, logger: silentLogger, ids, rng });
    const owner = groupId('race');
    return store.write((uow) => {
      expectWritten(repos.groups.create(uow, group(owner, 'Racers')), 'the group');
      expectWritten(repos.persons.create(uow, person('rc')), 'the person');
      const code = expectWritten(
        repos.onboarding.createClaimCode(uow, {
          kind: 'host',
          codeHash,
          // An hour, so a slow machine starting eight workers cannot expire the fixture and turn
          // the assertion into "every worker said `expired`" — which would pass the "exactly one
          // `ok`" check if it were written as "at most one".
          expiresAt: uow.now.add({ hours: 1 }),
        }),
        'the claim code',
      );
      return { codeId: code.id, personId: personId('rc') };
    });
  } finally {
    db.close();
  }
}
