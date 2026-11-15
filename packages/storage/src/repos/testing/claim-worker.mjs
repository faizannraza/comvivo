/**
 * A worker that opens its own write connection and tries to redeem one claim code (`M3-T1` AC).
 *
 * In a real `worker_threads` worker, because the acceptance criterion says "single-use **under
 * concurrency**" and a same-thread loop cannot show that. better-sqlite3 is synchronous: N calls
 * on one connection are N calls in a row, and the only thing a sequential test proves is that the
 * second `UPDATE` sees the first one's committed row — which is also what it would prove if the
 * statement were not conditional at all.
 *
 * Across threads the arrangement is the one `02` D22 describes and `C1` constrains: one connection
 * per thread, each opening `BEGIN IMMEDIATE`. What the test then observes is that they **queue**
 * rather than interleave, that exactly one gets `ok`, and that nobody gets `SQLITE_BUSY` — the
 * three facts together are the guarantee. See `onboarding.concurrency.int.test.ts`.
 *
 * Protocol: the parent sends `{ codeHash, chat, personId, nowMs, startAt }`; this worker busy-waits
 * until `startAt` so every worker reaches `BEGIN IMMEDIATE` in the same millisecond, redeems once,
 * and replies `{ kind, error? }`. `startAt` rather than a barrier message because a `postMessage`
 * round trip is tens of microseconds of jitter per worker, which is enough for them to arrive in
 * single file — and a test where the workers never actually contend would pass for the wrong
 * reason.
 */
import { parentPort, workerData } from 'node:worker_threads';

if (parentPort === null) throw new Error('claim-worker.mjs must run as a worker');

const { makeDb, SqliteStore, makeRepositories, TypeIdGenerator, SystemClock, SeededRng, Database } =
  await import(workerData.modulePath);

parentPort.on('message', (message) => {
  if (message.kind === 'close') {
    process.exit(0);
  }
  const db = new Database(workerData.path);
  try {
    // The one pragma that decides what "under concurrency" means here. Without it a second
    // `BEGIN IMMEDIATE` fails immediately with `SQLITE_BUSY` and the test would be measuring
    // SQLite's default impatience rather than our single-use guarantee.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    const drizzle = makeDb(db);
    const clock = new SystemClock();
    const ids = new TypeIdGenerator(clock);
    const rng = new SeededRng(7);
    const silent = {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      child: () => silent,
    };
    const repos = makeRepositories({ db: drizzle, connection: db, ids, rng, clock });
    const store = new SqliteStore({ db, clock, logger: silent, ids, rng });

    while (Date.now() < message.startAt) {
      // Spin. `Atomics.wait` would be tidier, but the point is to be *inside* the `BEGIN
      // IMMEDIATE` attempt the instant the clock turns over, and a sleep rounds up.
    }

    const verdict = store.write(
      (uow) =>
        repos.onboarding.redeemClaimCode(uow, {
          codeHash: new Uint8Array(message.codeHash),
          channel: message.channel,
          now: uow.now,
          usedInChat: message.chat,
          usedByPersonId: message.personId,
        }),
      { op: 'claim.redeem' },
    );
    parentPort.postMessage({ kind: verdict.kind, id: verdict.code?.id });
  } catch (error) {
    parentPort.postMessage({ kind: 'threw', error: String(error) });
  } finally {
    db.close();
  }
});
