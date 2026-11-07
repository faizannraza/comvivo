/**
 * A worker thread that opens its own read connection and polls (`02` §3.6.3 step 9).
 *
 * `02` §3.6.2's `openWorkerConnection` re-derives the database key inside the worker from a copy
 * transferred over a `MessagePort`, and zeroes the copy after opening. The spike models that
 * shape: the key arrives in `workerData`, the worker opens, loads the extension, reads, and then
 * overwrites its copy.
 *
 * The question this answers is whether a second connection to a SQLCipher database in WAL mode can
 * read while the main thread writes. If it cannot, the whole worker/main split in `01` §1 — the
 * one that keeps the dashboard's reads off the write path — has to be redesigned.
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';

const { dbPath, key } = workerData;
const keyBuffer = Buffer.from(key);

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("cipher='sqlcipher'");
db.pragma('legacy=4');
db.pragma(`key="x'${keyBuffer.toString('hex')}'"`);
db.pragma('busy_timeout = 5000');
// A read connection still needs the extension: a KNN query is a read.
sqliteVec.load(db);

// `08` §3.7: the transferred copy is zeroed once the connection holds the derived key.
keyBuffer.fill(0);

const count = db.prepare('select count(*) as c from rows_written');
const vecVersion = db.prepare('select vec_version() as v').get().v;

parentPort.on('message', (message) => {
  if (message === 'read') {
    parentPort.postMessage({ kind: 'count', value: count.get().c, vecVersion });
    return;
  }
  if (message === 'close') {
    db.close();
    parentPort.postMessage({ kind: 'closed' });
  }
});

parentPort.postMessage({ kind: 'ready', vecVersion, keyZeroed: keyBuffer.every((b) => b === 0) });
