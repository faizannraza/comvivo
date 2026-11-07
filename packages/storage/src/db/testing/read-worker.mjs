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
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openWorkerConnection, receiveHandshake } from '../worker-connection.ts';

if (parentPort === null) throw new Error('read-worker.mjs must run as a worker');

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
