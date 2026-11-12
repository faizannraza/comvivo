/**
 * Worker connections, in real worker threads (`02` §3.6.2, D22).
 *
 * `02` D22's claim is that a worker can read while the main thread writes, and that claim is only
 * testable across threads: SQLite's `THREADSAFE=2` build allows one connection per thread, and the
 * failure this arrangement risks — two connections disagreeing about WAL state — does not exist
 * within one thread. So these tests spawn real workers.
 *
 * The other half is the **key**, and that is where the care goes. `02` §3.6.2 says the key reaches
 * a worker through a `MessagePort`-transferred copy and "the copy is zeroed after open". Both
 * halves are asserted: that the transfer detaches the sender's buffer rather than cloning it, and
 * that the worker's copy is cleared whether the open succeeds or fails.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MessageChannel, type MessagePort, Worker } from 'node:worker_threads';
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { writeSourcePathsTsconfig } from '../../../../scripts/support/paths-tsconfig.js';
import { withDataDir } from '../datadir/testing/data-dir.js';
import { initDatabase } from './init.js';
import { openDatabase } from './open.js';
import {
  openWorkerConnection,
  receiveHandshake,
  sendDatabaseKey,
  sendNoDatabaseKey,
  type WorkerHandshake,
  type WorkerKeyMessage,
} from './worker-connection.js';

const WORKER = new URL('./testing/read-worker.mjs', import.meta.url);
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname;

interface WorkerReply {
  readonly kind: string;
  readonly ok?: boolean;
  readonly rows?: readonly Record<string, unknown>[];
  readonly error?: string;
  readonly readonly?: boolean;
  readonly role?: string;
}

/**
 * Start a reader worker against `path`, handing it `key` over the worker's own port.
 *
 * `worker.postMessage` writes to the same `MessagePort` the worker sees as `parentPort`, so the
 * transfer semantics under test are exactly the ones production uses — no extra channel needed.
 */
function startReader(
  path: string,
  key: Buffer | null,
): {
  readonly worker: Worker;
  readonly ready: Promise<WorkerReply>;
  query: (sql: string) => Promise<WorkerReply>;
  exec: (sql: string) => Promise<WorkerReply>;
  stop: () => Promise<void>;
} {
  // `tsx` so the worker can import the TypeScript it is testing, and `TSX_TSCONFIG_PATH` so it
  // resolves `@comvivo/*` to source rather than to `dist/`. See `writeSourcePathsTsconfig`,
  // which owns the reasoning and is shared with `schema/ddl.int.test.ts`.
  // `dist/` when it is there, source otherwise — see the note in `read-worker.mjs`. Resolved here
  // rather than in the worker because the worker is the one place that cannot be relied on to have
  // TypeScript loading available.
  // Both relative to **this** file (`src/db/`), not to the worker in `src/db/testing/`.
  const built = new URL('../../dist/db/worker-connection.js', import.meta.url);
  const modulePath = existsSync(built)
    ? built.href
    : new URL('./worker-connection.ts', import.meta.url).href;

  const worker = new Worker(WORKER, {
    workerData: { path, modulePath },
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: writeSourcePathsTsconfig(dirname(path), REPO_ROOT, 'tsconfig.worker.json'),
    },
  });

  const waiting: { resolve: (reply: WorkerReply) => void; reject: (error: unknown) => void }[] = [];
  const queued: WorkerReply[] = [];
  worker.on('message', (reply: WorkerReply) => {
    const next = waiting.shift();
    if (next === undefined) queued.push(reply);
    else next.resolve(reply);
  });
  worker.on('error', (error) => {
    const next = waiting.shift();
    if (next !== undefined) next.reject(error);
  });

  const nextReply = (): Promise<WorkerReply> =>
    new Promise<WorkerReply>((resolve, reject) => {
      const ready = queued.shift();
      if (ready !== undefined) resolve(ready);
      else waiting.push({ resolve, reject });
    });

  const ready = nextReply();
  if (key === null) sendNoDatabaseKey(worker as unknown as MessagePort);
  else sendDatabaseKey(worker as unknown as MessagePort, key);

  return {
    worker,
    ready,
    query: (sql: string) => {
      const reply = nextReply();
      worker.postMessage({ kind: 'query', sql });
      return reply;
    },
    /** `db.exec`, for the transaction control better-sqlite3 refuses in `prepare`. */
    exec: (sql: string) => {
      const reply = nextReply();
      worker.postMessage({ kind: 'exec', sql });
      return reply;
    },
    stop: async () => {
      worker.postMessage({ kind: 'close' });
      await worker.terminate();
    },
  };
}

describe('the key transfer (02 §3.6.2)', () => {
  it('detaches the sender’s buffer rather than cloning it', () => {
    // The property that makes this safe: after the transfer there is **one** copy of the key in the
    // process, not two. A `postMessage` without a transfer list would clone silently, and the clone
    // would be unreachable and unzeroable.
    //
    // Asserting `key` is zeroed does **not** show that. `sendDatabaseKey` calls `zeroize(key)`
    // unconditionally, so the old version of this test passed with the transfer list removed —
    // precisely the failure its own comment describes. Found by the M1 independent review.
    //
    // The observable property is detachment: a transferred `ArrayBuffer` has `byteLength === 0` in
    // the sender afterwards, and a cloned one still has 32 bytes.
    const { port1, port2 } = new MessageChannel();
    try {
      const key = Buffer.from(randomBytes(32));
      const expected = Buffer.from(key);
      const sent: {
        message: WorkerKeyMessage | undefined;
        transfer: readonly unknown[] | undefined;
      } = { message: undefined, transfer: undefined };
      const realPostMessage = port1.postMessage.bind(port1);
      port1.postMessage = (message: unknown, transfer?: readonly unknown[]): void => {
        sent.message = message as WorkerKeyMessage;
        sent.transfer = transfer;
        realPostMessage(message as never, transfer as never);
      };

      sendDatabaseKey(port1, key);

      // The transfer list names the very buffer the message carries, so the key is moved rather
      // than copied. Identity, not shape: a list holding some other buffer would detach the wrong
      // thing and clone the key anyway.
      expect(sent.transfer, 'postMessage was called with no transfer list').toBeDefined();
      expect(sent.transfer).toHaveLength(1);
      expect(sent.transfer?.[0]).toBe(sent.message?.key);
      // And the move really happened.
      expect(sent.message?.key.byteLength, 'the sender still holds the key bytes').toBe(0);
      // The caller's own copy is cleared too, which is the second half of "one copy".
      expect(key.every((byte) => byte === 0)).toBe(true);
      // Non-vacuity: the bytes that went across were the key, so this is not a test of an
      // already-empty buffer.
      expect(expected.every((byte) => byte === 0)).toBe(false);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it('refuses a key that is not 32 bytes, before it reaches a worker', () => {
    const { port1, port2 } = new MessageChannel();
    try {
      expect(() => {
        sendDatabaseKey(port1, Buffer.alloc(16));
      }).toThrow(StorageError);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it('zeroes the worker’s copy after opening', async () => {
    // `02` §3.6.2: "The copy is zeroed after open." Asserted here rather than in the worker,
    // because the handshake object is what holds the transferred buffer and it is observable.
    await withDataDir(async (root) => {
      const path = join(root, 'w.db');
      const key = randomBytes(32);
      initDatabase({ path, key: Buffer.from(key) }).db.close();

      const transferable = new ArrayBuffer(32);
      new Uint8Array(transferable).set(key);
      const handshake: WorkerHandshake = { kind: 'database-key', key: transferable };

      const opened = openWorkerConnection(handshake, { path });
      try {
        expect(new Uint8Array(handshake.key).every((byte) => byte === 0)).toBe(true);
      } finally {
        opened.db.close();
      }
    });
  });

  it('zeroes the copy even when the open fails', async () => {
    // The `finally` case, and the one a hand-rolled version forgets: a wrong key means the open
    // throws, and the key must not be left alive in a buffer the caller never sees.
    await withDataDir(async (root) => {
      const path = join(root, 'w.db');
      initDatabase({ path, key: randomBytes(32) }).db.close();

      const transferable = new ArrayBuffer(32);
      new Uint8Array(transferable).set(randomBytes(32));
      const handshake: WorkerHandshake = { kind: 'database-key', key: transferable };

      expect(() => openWorkerConnection(handshake, { path })).toThrow(StorageError);
      expect(new Uint8Array(handshake.key).every((byte) => byte === 0)).toBe(true);
    });
  });

  it('reports a detached or wrong-sized buffer as a bug', async () => {
    await withDataDir(async (root) => {
      const path = join(root, 'w.db');
      initDatabase({ path, key: randomBytes(32) }).db.close();

      const handshake: WorkerHandshake = { kind: 'database-key', key: new ArrayBuffer(0) };
      try {
        openWorkerConnection(handshake, { path });
        expect.unreachable('a zero-length key is not a key');
      } catch (caught) {
        const error = caught as StorageError;
        expect(error.storageCode).toBe('STORAGE_KEY_INVALID');
        expect(error.code).toBe('bug');
        expect(error.hint).toContain('detached buffer');
      }
    });
  });

  it('times out rather than waiting forever for a handshake', async () => {
    // A worker that never got its key would otherwise hold its thread indefinitely, and a stuck
    // backup job is harder to diagnose than a failed one.
    const { port1, port2 } = new MessageChannel();
    try {
      await expect(receiveHandshake(port2, 20)).rejects.toThrow(/no database key arrived/);
    } finally {
      port1.close();
    }
  });
});

describe('a worker reads while the main thread writes (02 D22)', { tags: ['db', 'slow'] }, () => {
  it('opens read-only in the worker, by default', async () => {
    // A worker that wrote would be a second writer — which the instance lock exists to prevent and
    // which SQLite's WAL would not stop.
    await withDataDir(async (root) => {
      const path = join(root, 'd22.db');
      const key = randomBytes(32);
      const main = initDatabase({ path, key: Buffer.from(key) });
      main.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');

      const reader = startReader(path, Buffer.from(key));
      try {
        const ready = await reader.ready;
        expect(ready.kind).toBe('ready');
        expect(ready.readonly).toBe(true);
        expect(ready.role).toBe('worker');

        const attempt = await reader.query("INSERT INTO t (body) VALUES ('nope')");
        expect(attempt.ok).toBe(false);
        expect(attempt.error).toContain('readonly');
      } finally {
        await reader.stop();
        main.db.close();
      }
    });
  });

  it('reads rows the main thread committed, including ones written after it opened', async () => {
    // The actual D22 claim. The worker opens, the main thread keeps writing, and the worker sees
    // each committed batch — which is what makes a backup or an export possible without pausing.
    await withDataDir(async (root) => {
      const path = join(root, 'd22.db');
      const key = randomBytes(32);
      const main = initDatabase({ path, key: Buffer.from(key) });
      main.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');
      const insert = main.db.prepare('INSERT INTO t (body) VALUES (?)');
      insert.run('first');

      const reader = startReader(path, Buffer.from(key));
      try {
        await reader.ready;
        const before = await reader.query('SELECT count(*) AS n FROM t');
        expect(before.rows?.[0]).toEqual({ n: 1 });

        // Main thread writes while the worker's connection is open.
        for (let n = 0; n < 200; n += 1) insert.run(`row ${String(n)}`);

        const after = await reader.query('SELECT count(*) AS n FROM t');
        expect(after.rows?.[0]).toEqual({ n: 201 });
      } finally {
        await reader.stop();
        main.db.close();
      }
    });
  });

  it('lets the main thread keep writing while the worker holds a read open', async () => {
    // The direction that matters for a backup: a long read must not block the writer. In WAL mode
    // it does not, and this is the test that would notice if the pragma sequence lost WAL.
    //
    // **The reader has to be holding a read, not merely be between two.** The first version of
    // this test fired a slow `SELECT` without awaiting it and then wrote — but the main thread is
    // single-threaded, so it could neither observe the worker's progress nor be sure the query had
    // started, and with a rollback journal the writer would simply have waited out a read lock
    // that was no longer held. It passed for no reason. So: an explicit `BEGIN DEFERRED`, a
    // materialised read inside it to take the lock, then the writes, and only then `COMMIT`.
    // Under a rollback journal those writes raise `SQLITE_BUSY`; under WAL they do not. The
    // reader's snapshot is asserted afterwards, which is the other half of what `02` D22 claims.
    // Found by the M1 exit gate's reviewer.
    //
    // The rollback-journal half is **measured** rather than asserted here, because both
    // connections apply `RUNTIME_PRAGMAS` and the worker's open switches the file back to WAL —
    // so the mode cannot be held down from inside this test. Measured separately on 2026-11-12,
    // same SQLite build, two connections pinned to `journal_mode = delete`: the reader's
    // `BEGIN DEFERRED` plus one materialised read makes the writer's next insert fail with
    // `SqliteError: database is locked`. That is the failure this arrangement would surface if the
    // pragma sequence ever stopped setting WAL.
    await withDataDir(async (root) => {
      const path = join(root, 'd22.db');
      const key = randomBytes(32);
      const main = initDatabase({ path, key: Buffer.from(key) });
      main.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT)');
      const insert = main.db.prepare('INSERT INTO t (body) VALUES (?)');
      for (let n = 0; n < 2000; n += 1) insert.run(`row ${String(n)}`);

      const reader = startReader(path, Buffer.from(key));
      try {
        await reader.ready;
        expect((await reader.exec('BEGIN DEFERRED')).ok).toBe(true);
        // Inside the transaction, and materialised: a deferred transaction takes no lock until it
        // reads, so a `BEGIN` on its own would leave this test proving nothing again.
        const before = await reader.query('SELECT count(*) AS n FROM t');
        expect(before.ok).toBe(true);
        expect((before.rows?.[0] as { n: number } | undefined)?.n).toBe(2000);

        // The writer proceeds while that read transaction is open — no `SQLITE_BUSY`, which is
        // what WAL buys and what every heavy operation in `02` D22 depends on.
        for (let n = 0; n < 500; n += 1) insert.run(`more ${String(n)}`);
        expect(main.db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2500 });

        // And the reader still sees the snapshot it began with, not the writer's rows.
        const during = await reader.query('SELECT count(*) AS n FROM t');
        expect((during.rows?.[0] as { n: number } | undefined)?.n).toBe(2000);
        expect((await reader.exec('COMMIT')).ok).toBe(true);

        // After the commit its next read is current again, which is the test above in miniature
        // and the proof that the 2000 was a snapshot rather than a stale cache.
        const after = await reader.query('SELECT count(*) AS n FROM t');
        expect((after.rows?.[0] as { n: number } | undefined)?.n).toBe(2500);
      } finally {
        await reader.stop();
        main.db.close();
      }
    });
  });

  it('refuses the worker a database it has the wrong key for', async () => {
    await withDataDir(async (root) => {
      const path = join(root, 'd22.db');
      const main = initDatabase({ path, key: randomBytes(32) });
      main.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      main.db.close();

      const reader = startReader(path, randomBytes(32));
      try {
        await expect(reader.ready).rejects.toThrow();
      } finally {
        await reader.worker.terminate();
      }
    });
  });

  it('works without a key, for an unencrypted install', async () => {
    await withDataDir(async (root) => {
      const path = join(root, 'plain.db');
      const main = initDatabase({ path, key: null });
      main.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      main.db.prepare('INSERT INTO t (id) VALUES (1)').run();

      const reader = startReader(path, null);
      try {
        expect((await reader.ready).kind).toBe('ready');
        const rows = await reader.query('SELECT count(*) AS n FROM t');
        expect(rows.rows?.[0]).toEqual({ n: 1 });
      } finally {
        await reader.stop();
        main.db.close();
      }
    });
  });

  it('will not create a database the worker cannot find', async () => {
    // `fileMustExist` for every role but `main`. A worker that created an empty database would
    // leave something the next boot reads as a fresh install.
    //
    // Both halves matter, and the **writable** one is what makes this about `fileMustExist` at
    // all: a read-only open of a missing file fails for its own reason, so a version of this test
    // that only did that would have passed with `fileMustExist` removed entirely (found by the M1
    // independent review). It goes through `openDatabase` because `openWorkerConnection` no longer
    // takes a `readonly` option — a worker connection that could write is a second writer, which
    // `C1` forbids, and the M1 exit gate's reviewer was right that an opt-out property is not a
    // guard. `openDatabase` is the layer the knob belongs to.
    await withDataDir(async (root) => {
      const handshake: WorkerHandshake = { kind: 'no-database-key' };
      const absent = join(root, 'absent.db');

      // Writable, role `worker`: `fileMustExist` is the only thing that can refuse this, and the
      // file must not appear as a side effect.
      expect(() =>
        openDatabase({ path: absent, key: null, role: 'worker', readonly: false }),
      ).toThrow(StorageError);
      expect(existsSync(absent), 'the worker created a database').toBe(false);

      // And the worker's own entry point refuses too, read-only, for its own reason.
      expect(() => openWorkerConnection(handshake, { path: absent })).toThrow(StorageError);
      expect(existsSync(absent)).toBe(false);
    });
  });
});
