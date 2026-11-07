/**
 * A worker-thread read connection against a live writer (`02` §3.6.3 step 9).
 *
 * `01` §1 splits the process into a writer and a worker precisely so the dashboard's reads never
 * queue behind a turn's writes. That split only works if a second connection to an **encrypted**
 * database in WAL mode can read while the first one writes — so this is a load-bearing fact, not a
 * curiosity, and if it failed the architecture would need redesigning rather than tuning.
 *
 * It also checks the two details `08` §3.7 requires of `openWorkerConnection`: the worker opens
 * read-only, and the transferred copy of the key is zeroed once the connection holds it.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { DB_FILENAME, openSpikeDatabase, withSpikeDirAsync } from './open.js';

const WORKER = new URL('worker-reader.mjs', import.meta.url).pathname;

interface Ready {
  readonly kind: 'ready';
  readonly vecVersion: string;
  readonly keyZeroed: boolean;
}
interface CountMessage {
  readonly kind: 'count';
  readonly value: number;
  readonly vecVersion: string;
}
type WorkerMessage = Ready | CountMessage | { readonly kind: 'closed' };

/** Start the worker and resolve once it reports `ready`. */
async function startReader(dbPath: string, key: Buffer): Promise<{ worker: Worker; ready: Ready }> {
  const worker = new Worker(WORKER, {
    workerData: { dbPath, key: Uint8Array.from(key) },
  });
  const ready = await new Promise<Ready>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('message', (message: WorkerMessage) => {
      if (message.kind === 'ready') resolve(message);
      else reject(new Error(`unexpected first message: ${message.kind}`));
    });
  });
  return { worker, ready };
}

/**
 * Ask the worker for a count and wait for its answer.
 *
 * Both listeners are removed when the promise settles. Leaving the `error` one attached made Node
 * print `MaxListenersExceededWarning: 11 error listeners added to [Worker]` on the tenth read —
 * harmless here, and exactly the kind of warning that teaches a team to stop reading warnings.
 */
async function readCount(worker: Worker): Promise<number> {
  const answer = await new Promise<CountMessage>((resolve, reject) => {
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onMessage = (message: WorkerMessage): void => {
      cleanup();
      if (message.kind === 'count') resolve(message);
      else reject(new Error(`unexpected message: ${message.kind}`));
    };
    function cleanup(): void {
      worker.off('error', onError);
      worker.off('message', onMessage);
    }
    worker.on('error', onError);
    worker.on('message', onMessage);
    worker.postMessage('read');
  });
  return answer.value;
}

describe('a worker read connection', { tags: ['db', 'slow'] }, () => {
  it('opens, loads sqlite-vec, and sees rows the main thread committed', async () => {
    await withSpikeDirAsync(async (dir) => {
      const key = randomBytes(32);
      const dbPath = join(dir, DB_FILENAME);
      const db = openSpikeDatabase({ path: dbPath, key });
      try {
        db.exec('create table rows_written (n integer primary key, payload text not null)');
        const insert = db.prepare('insert into rows_written (n, payload) values (?, ?)');
        db.transaction(() => {
          for (let n = 1; n <= 100; n += 1) insert.run(n, `row-${String(n)}`);
        })();

        const { worker, ready } = await startReader(dbPath, key);
        try {
          // The extension loads in the worker too, which is what makes a KNN query a read-path
          // operation rather than a write-path one.
          expect(ready.vecVersion).toMatch(/^v0\.1\.\d+$/);
          // `08` §3.7: the transferred key copy is zeroed once the connection holds it.
          expect(ready.keyZeroed).toBe(true);
          expect(await readCount(worker)).toBe(100);
        } finally {
          await worker.terminate();
        }
      } finally {
        db.close();
      }
    });
  });

  it('keeps reading while the main thread writes, which is the whole point of the split', async () => {
    await withSpikeDirAsync(async (dir) => {
      const key = randomBytes(32);
      const dbPath = join(dir, DB_FILENAME);
      const db = openSpikeDatabase({ path: dbPath, key });
      try {
        db.exec('create table rows_written (n integer primary key, payload text not null)');
        const insert = db.prepare('insert into rows_written (n, payload) values (?, ?)');
        insert.run(1, 'first');

        const { worker } = await startReader(dbPath, key);
        try {
          const counts: number[] = [];
          for (let round = 0; round < 10; round += 1) {
            // Write on the main thread…
            db.transaction(() => {
              for (let i = 0; i < 25; i += 1) insert.run(round * 25 + i + 2, `row-${String(i)}`);
            })();
            // …and read from the worker, with no coordination beyond WAL. Serial on purpose:
            // the interleaving of write-then-read is the test.
            counts.push(await readCount(worker));
          }
          // Monotonic and finishing at the full count: the reader sees successive snapshots rather
          // than a frozen one or an error.
          expect(counts).toEqual([...counts].sort((a, b) => a - b));
          expect(counts.at(-1)).toBe(251);
          expect(counts[0]).toBeGreaterThan(1);
        } finally {
          await worker.terminate();
        }
      } finally {
        db.close();
      }
    });
  });

  it('refuses to write from the read connection', async () => {
    // `02` §3.6.2 opens worker connections `readonly`. Asserted because "the worker only reads" is
    // otherwise a convention, and a stray write from the read side under WAL is how two
    // connections end up fighting over the write lock.
    await withSpikeDirAsync(async (dir) => {
      const key = randomBytes(32);
      const dbPath = join(dir, DB_FILENAME);
      const db = openSpikeDatabase({ path: dbPath, key });
      db.exec('create table rows_written (n integer primary key, payload text not null)');
      db.close();

      const readOnly = openSpikeDatabase({
        path: dbPath,
        key,
        readonly: true,
        fileMustExist: true,
      });
      try {
        expect(() =>
          readOnly.prepare('insert into rows_written (n, payload) values (1, ?)').run('nope'),
        ).toThrow(/readonly/i);
      } finally {
        readOnly.close();
      }
      await Promise.resolve();
    });
  });
});
