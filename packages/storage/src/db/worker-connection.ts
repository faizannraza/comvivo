/**
 * Worker connections (`02` §3.6.2, D22).
 *
 * `02` D22: one read/write connection on the main thread, and each heavy operation — backup,
 * export, purge scans, performance seeding — opens its **own** connection in a `worker_threads`
 * worker. Not a connection pool: better-sqlite3 is synchronous, so a second connection on the main
 * thread adds nothing but a second way to block it, and SQLite's `THREADSAFE=2` build means one
 * connection per thread is the only safe arrangement anyway.
 *
 * The part that needs care is the **key**. A worker needs the derived database key, and there are
 * three ways to get it there, two of which are wrong:
 *
 *  - `workerData` — rejected. It is structured-cloned at spawn and the clone lives in the worker's
 *    heap for the worker's lifetime, with nothing able to zero it.
 *  - an environment variable — rejected, and worse: a child inherits it, and `/proc/<pid>/environ`
 *    carries it for the life of the process. This is the same S9 reasoning `unlock-sources.ts`
 *    applies to `COMVIVO_MASTER_KEY`.
 *  - a `MessagePort` — used. The key arrives as a transferred `ArrayBuffer`, which means the
 *    sender's copy is **detached** by the transfer rather than copied, so there is exactly one copy
 *    at any moment. The worker zeroes it immediately after `PRAGMA key`.
 *
 * `02` §3.6.2 says "re-derives `db_key` inside the worker from a `MessagePort`-transferred copy of
 * the derived key. The copy is zeroed after open." That is what this implements, and the zeroing is
 * the half that is easy to leave out and impossible to notice.
 */

import type { MessagePort } from 'node:worker_threads';
import { StorageError } from '@comvivo/shared';
import { zeroize } from '@comvivo/shared/crypto';
import { type OpenDatabase, type OpenOptions, openDatabase } from './open.js';

/** The message a worker waits for before it can open anything. */
export interface WorkerKeyMessage {
  readonly kind: 'database-key';
  /** The derived database key, **transferred** rather than copied. 32 bytes. */
  readonly key: ArrayBuffer;
}

/** What the main thread tells a worker that does not need a key (an unencrypted install). */
export interface WorkerNoKeyMessage {
  readonly kind: 'no-database-key';
}

export type WorkerHandshake = WorkerKeyMessage | WorkerNoKeyMessage;

/** `08` §3.7.9: a 256-bit database key. */
const KEY_BYTES = 32;

/**
 * Send the database key to a worker, giving up this thread's copy.
 *
 * The buffer is **transferred**, so `key`'s backing store is detached here — after this returns,
 * the caller's view is zero-length and there is one copy of the key in the process rather than two.
 * That is the property worth having: a `postMessage` without the transfer list would silently
 * clone, and the clone would be unreachable and unzeroable.
 *
 * Takes ownership of `key`. Callers get it from `KeyService.useDatabaseKeyHex`, which means they
 * are holding a copy they made for this purpose.
 */
export function sendDatabaseKey(port: MessagePort, key: Uint8Array): void {
  if (key.length !== KEY_BYTES) {
    throw new StorageError(
      'STORAGE_KEY_INVALID',
      `a database key is ${String(KEY_BYTES)} bytes, got ${String(key.length)}`,
      { hint: 'This is a bug: the key tree derives a 256-bit database key.', category: 'bug' },
    );
  }

  // A standalone `ArrayBuffer` of exactly the key, so the transfer cannot hand over a view into a
  // larger pool — which is how a transfer ends up detaching something the caller still needs.
  const transferable = new ArrayBuffer(KEY_BYTES);
  new Uint8Array(transferable).set(key);
  const message: WorkerKeyMessage = { kind: 'database-key', key: transferable };
  port.postMessage(message, [transferable]);
  // The caller's copy is ours to clear: it was made for this call and the transfer means the
  // worker has the only live copy now.
  zeroize(key);
}

/** Tell a worker there is no key, so it does not wait forever on an unencrypted install. */
export function sendNoDatabaseKey(port: MessagePort): void {
  const message: WorkerNoKeyMessage = { kind: 'no-database-key' };
  port.postMessage(message);
}

/**
 * Open a worker's connection from a handshake message.
 *
 * Read-only by default, because that is what `02` D22's heavy operations are: a backup reads, an
 * export reads, a purge scan reads. A worker that wrote would be a second writer, which the
 * instance lock exists to prevent and which SQLite's WAL would not stop.
 *
 * The key is zeroed before this returns, on every path — including the failure path, which is the
 * one a `finally` exists for and the one a hand-rolled version forgets.
 */
export function openWorkerConnection(
  handshake: WorkerHandshake,
  options: Omit<OpenOptions, 'key' | 'role'> & { readonly readonly?: boolean },
): OpenDatabase {
  if (handshake.kind === 'no-database-key') {
    return openDatabase({
      ...options,
      key: null,
      role: 'worker',
      readonly: options.readonly ?? true,
    });
  }

  if (handshake.key.byteLength !== KEY_BYTES) {
    throw new StorageError(
      'STORAGE_KEY_INVALID',
      `the transferred database key is ${String(handshake.key.byteLength)} bytes, expected ` +
        String(KEY_BYTES),
      {
        hint:
          'This is a bug, or the transfer was a clone rather than a transfer — a detached buffer ' +
          'reads as zero length.',
        category: 'bug',
      },
    );
  }

  const key = Buffer.from(handshake.key);
  try {
    return openDatabase({
      ...options,
      key,
      role: 'worker',
      readonly: options.readonly ?? true,
    });
  } finally {
    // `02` §3.6.2: "The copy is zeroed after open." Both the `Buffer` view and the transferred
    // backing store, because they are two references to one allocation and only clearing one of
    // them leaves the bytes readable through the other.
    zeroize(key);
    zeroize(new Uint8Array(handshake.key));
  }
}

/**
 * Wait for the handshake on a port.
 *
 * A promise rather than an event handler, so a worker's entry point reads as a sequence: get the
 * key, open the database, do the work. `timeoutMs` exists because a worker that never receives a
 * handshake would otherwise hold its thread forever, and a stuck backup job is harder to diagnose
 * than a failed one.
 */
export function receiveHandshake(port: MessagePort, timeoutMs = 10_000): Promise<WorkerHandshake> {
  return new Promise<WorkerHandshake>((resolve, reject) => {
    const timer = setTimeout(() => {
      port.close();
      reject(
        new StorageError('STORAGE_IO', 'no database key arrived from the main thread', {
          hint: 'This is a bug: a worker is started with a port and sent its key immediately.',
          category: 'bug',
        }),
      );
    }, timeoutMs);
    // Unreferenced so a waiting worker does not keep the event loop alive on its own.
    timer.unref();

    port.once('message', (message: WorkerHandshake) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}
