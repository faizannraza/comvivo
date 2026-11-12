/**
 * A worker that opens its own read-only connection and reads (`02` D22).
 *
 * The real thing, in a real `worker_threads` worker, because that is the only way to test what
 * `02` D22 actually claims: SQLite's `THREADSAFE=2` build allows one connection per thread, and a
 * worker reading while the main thread writes is the arrangement every heavy operation uses. A
 * same-thread test would prove nothing about it — and the interesting failure, two connections
 * fighting over WAL, only exists across threads.
 *
 * The key arrives over a `MessagePort` as a transferred `ArrayBuffer`, never in `workerData`: a
 * `workerData` clone lives in this worker's heap for its lifetime with nothing able to zero it.
 *
 * Protocol: the parent sends the handshake on `port`, then one `{ sql }` message per query; this
 * worker replies `{ ok, rows }` or `{ ok: false, error }`. It exits when the port closes.
 *
 * `{ kind: 'exec', sql }` runs `db.exec` instead of a prepared statement, which is the only way to
 * hold a transaction open **across** messages: better-sqlite3 refuses transaction control in
 * `prepare`. The concurrency test needs it — a reader that is merely *between* queries proves
 * nothing about a writer, because the read lock it would take has already been released.
 */
import { parentPort, workerData } from 'node:worker_threads';

if (parentPort === null) throw new Error('read-worker.mjs must run as a worker');

/**
 * The module under test, resolved by the **parent** and passed in.
 *
 * It was a static `import … from '../worker-connection.ts'`, which makes this worker depend on
 * `tsx`'s module-customization hooks being active inside a `new Worker()`. They are on Node 26 and
 * on 24.22, and they are **not** on 24.11 — the declared floor — where the nested relative
 * `./open.js` → `open.ts` rewrite does not happen and the worker dies with `Cannot find module
 * …/src/db/open.js`. Found the moment the floor leg was pinned to the exact declared version.
 *
 * So the parent decides: the built module when `dist/` exists, the source when it does not. On the
 * floor leg that means this exercises the artefact a host actually runs, which is the stronger
 * claim anyway; elsewhere it stays a source-mode test with no build step.
 */
const { openWorkerConnection, receiveHandshake } = await import(workerData.modulePath);

const handshake = await receiveHandshake(parentPort);
const opened = openWorkerConnection(handshake, {
  path: workerData.path,
  // A small cache: this worker is proving concurrency, not performance, and 192 MiB per worker
  // would be a real cost on a Pi.
  cacheSizeKiB: 2048,
  busyTimeoutMs: 2000,
});

parentPort.postMessage({ kind: 'ready', readonly: opened.readonly, role: opened.role });

parentPort.on('message', (message) => {
  if (message.kind === 'close') {
    opened.db.close();
    parentPort.close();
    return;
  }
  try {
    if (message.kind === 'exec') {
      opened.db.exec(message.sql);
      parentPort.postMessage({ kind: 'rows', ok: true, rows: [] });
      return;
    }
    const statement = opened.db.prepare(message.sql);
    // `.all()` on a statement that returns nothing raises "This statement does not return data",
    // which would mask the read-only refusal this worker exists to demonstrate. `reader` is
    // better-sqlite3's own answer to "does this return rows", so the branch cannot drift.
    const rows = statement.reader ? statement.all() : [{ changes: statement.run().changes }];
    parentPort.postMessage({ kind: 'rows', ok: true, rows });
  } catch (error) {
    parentPort.postMessage({ kind: 'rows', ok: false, error: String(error) });
  }
});
