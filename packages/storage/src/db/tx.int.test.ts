/**
 * `SqliteStore` against a real database (`02` §3.7.2, §9.3; `01` §1).
 *
 * `02` §9.3 names two of these, and they are the two that matter:
 *
 *  - **`store.tx-async-guard`** — an `async` callback throws `STORAGE_TX_ASYNC_CALLBACK`, nothing
 *    is committed, and `afterCommit` hooks do not run.
 *  - **`store.nested-savepoint`** — an inner failure rolls back only the inner work when caught.
 *
 * Integration rather than unit, because both are claims about what SQLite actually did. A fake
 * driver would let a wrong implementation pass: the whole hazard here is that better-sqlite3
 * commits when the callback *returns*, so the only convincing evidence is the state of a real table
 * afterwards.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { type Logger, StorageError, SystemClock } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { withDataDir } from '../datadir/testing/data-dir.js';
import { initDatabase } from './init.js';
import { DEFAULT_SLOW_TX_MS, isThenable, SqliteStore } from './tx.js';

/** A line the fake logger captured: the event code and its fields. */
interface Line {
  readonly level: string;
  readonly event: string;
  readonly fields: Record<string, unknown>;
}

/** A logger that records instead of writing. Only the methods `SqliteStore` uses. */
function recordingLogger(): { lines: Line[]; logger: Logger } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (event: string, fields?: Record<string, unknown>): void => {
      lines.push({ level, event, fields: fields ?? {} });
    };
  const logger = {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    content: at('content'),
    child: () => logger,
  };
  return { lines, logger: logger as unknown as Logger };
}

function makeStore(
  db: Database.Database,
  options: { readonly logger: Logger; readonly slowTxMs?: number },
): SqliteStore {
  return new SqliteStore({
    db,
    clock: new SystemClock(),
    logger: options.logger,
    ...(options.slowTxMs === undefined ? {} : { slowTxMs: options.slowTxMs }),
  });
}

/** A database with one table, a store over it, and a recording logger. */
async function withStore<T>(
  fn: (world: {
    readonly store: SqliteStore;
    readonly db: Database.Database;
    readonly lines: Line[];
    readonly rows: () => number;
    readonly bodies: () => string[];
  }) => T,
  options: { readonly slowTxMs?: number } = {},
): Promise<T> {
  return withDataDir(async (root) => {
    const opened = initDatabase({ path: join(root, 'tx.db'), key: randomBytes(32) });
    try {
      opened.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
      const { lines, logger } = recordingLogger();
      const store = makeStore(opened.db, {
        logger,
        ...(options.slowTxMs === undefined ? {} : { slowTxMs: options.slowTxMs }),
      });
      return fn({
        store,
        db: opened.db,
        lines,
        rows: () => (opened.db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n,
        bodies: () =>
          (opened.db.prepare('SELECT body FROM t ORDER BY id').all() as { body: string }[]).map(
            (row) => row.body,
          ),
      });
    } finally {
      opened.db.close();
    }
  });
}

/** Insert one row inside a transaction. */
function insert(db: Database.Database, body: string): void {
  db.prepare('INSERT INTO t (body) VALUES (?)').run(body);
}

describe('writes commit and roll back', { tags: ['db', 'slow'] }, () => {
  it('commits what the callback did and returns its value', async () => {
    await withStore(({ store, db, rows }) => {
      const result = store.write((uow) => {
        expect(uow.now).toBeDefined();
        insert(db, 'one');
        insert(db, 'two');
        return 'done';
      });
      expect(result).toBe('done');
      expect(rows()).toBe(2);
    });
  });

  it('rolls back everything when the callback throws', async () => {
    await withStore(({ store, db, rows }) => {
      expect(() =>
        store.write(() => {
          insert(db, 'one');
          throw new Error('no');
        }),
      ).toThrow('no');
      expect(rows()).toBe(0);
    });
  });

  it('lets a caller\u2019s own error through unchanged', async () => {
    // **The finding this test exists for.** A transaction callback contains arbitrary caller code,
    // and the first version ran every throw through `mapSqliteError` — whose fallback turns an
    // unrecognised error into `STORAGE_IO` with the message "the database failed". A validation or
    // policy error raised inside a transaction therefore reached the caller as a storage failure
    // with its own message gone, which blames the host's disk for a bug and invites a retry that
    // will fail identically every time.
    class DomainError extends Error {}
    await withStore(({ store, db, rows }) => {
      const thrown = new DomainError('the group has no quorum');
      try {
        store.write(() => {
          insert(db, 'one');
          throw thrown;
        });
        expect.unreachable('the error must propagate');
      } catch (caught) {
        // The same object, not a copy and not a wrapper.
        expect(caught).toBe(thrown);
        expect(caught).toBeInstanceOf(DomainError);
        expect((caught as Error).message).toBe('the group has no quorum');
      }
      // And it still rolled back.
      expect(rows()).toBe(0);
    });
  });

  it('maps a SQLite failure to a StorageError', async () => {
    // Everything out of a transaction is a `StorageError`, so a caller has one error type to
    // handle rather than two (`02` §4.3).
    await withStore(({ store, db }) => {
      try {
        store.write(() => {
          db.prepare('INSERT INTO t (id, body) VALUES (1, NULL)').run();
        });
        expect.unreachable('a NOT NULL violation must be refused');
      } catch (caught) {
        expect(caught).toBeInstanceOf(StorageError);
        const error = caught as StorageError;
        expect(error.storageCode).toBe('STORAGE_CONSTRAINT');
        expect(error.detail).toMatchObject({ constraint: 't.body' });
      }
    });
  });

  it('names the op in the error, when one was given', async () => {
    await withStore(({ store }) => {
      try {
        store.write(
          () => {
            throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' });
          },
          { op: 'turn.commit' },
        );
        expect.unreachable('the throw must propagate');
      } catch (caught) {
        expect((caught as StorageError).message).toContain('while turn.commit');
      }
    });
  });

  it('reads with a consistent snapshot', async () => {
    await withStore(({ store, db }) => {
      store.write(() => {
        insert(db, 'one');
      });
      const seen = store.read(() => {
        const first = (db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n;
        const second = (db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n;
        return [first, second];
      });
      expect(seen).toEqual([1, 1]);
    });
  });

  it('tracks its own nesting depth', async () => {
    await withStore(({ store }) => {
      expect(store.depth).toBe(0);
      store.write(() => {
        expect(store.depth).toBe(1);
        store.write(() => {
          expect(store.depth).toBe(2);
        });
        expect(store.depth).toBe(1);
      });
      expect(store.depth).toBe(0);
    });
  });
});

describe('store.tx-async-guard (02 §9.3)', { tags: ['db', 'slow'] }, () => {
  it('throws STORAGE_TX_ASYNC_CALLBACK, commits nothing, and runs no hooks', async () => {
    // The named test, and all three clauses matter. better-sqlite3 commits when the callback
    // returns, so an async callback would otherwise commit an **empty** transaction, report
    // success, and then do its work outside any transaction at all — with the `afterCommit` hooks
    // having already fired for work that had not happened.
    await withStore(({ store, db, rows }) => {
      const ran: string[] = [];
      try {
        // The type refuses this (`NotPromise`), and the lint rule refuses it syntactically; the
        // cast is how an untyped caller would reach the runtime guard, which is guard 4.
        (store.write as unknown as (fn: () => Promise<void>) => void)(async () => {
          insert(db, 'never');
          await Promise.resolve();
        });
        expect.unreachable('an async callback must be refused');
      } catch (caught) {
        expect(caught).toBeInstanceOf(StorageError);
        expect((caught as StorageError).storageCode).toBe('STORAGE_TX_ASYNC_CALLBACK');
        expect((caught as StorageError).code).toBe('bug');
      }
      // Nothing committed: the throw happened inside the transaction, so it rolled back.
      expect(rows()).toBe(0);
      expect(ran).toEqual([]);
    });
  });

  it('refuses an async read callback too', async () => {
    // A read's snapshot is just as useless if the reads happen after it closes.
    await withStore(({ store }) => {
      expect(() =>
        (store.read as unknown as (fn: () => Promise<void>) => void)(async () => {
          await Promise.resolve();
        }),
      ).toThrow(StorageError);
    });
  });

  it('discards hooks registered before the async return', async () => {
    // The clause that is easiest to get wrong: a hook registered in the part of the callback that
    // ran synchronously must still not fire, because the transaction rolled back.
    await withStore(({ store, db }) => {
      const ran: string[] = [];
      expect(() =>
        (
          store.write as unknown as (
            fn: (uow: { afterCommit(cb: () => void): void }) => Promise<void>,
          ) => void
        )(async (uow) => {
          uow.afterCommit(() => ran.push('hook'));
          insert(db, 'never');
          await Promise.resolve();
        }),
      ).toThrow(StorageError);
      expect(ran).toEqual([]);
    });
  });

  it('refuses any thenable, not only a real Promise', async () => {
    // A thenable from another library — or a `Promise` from another realm — is just as fatal and
    // passes neither an `instanceof Promise` check nor the type.
    //
    // `noThenProperty` is suppressed here and below because a `then` property is precisely what is
    // under test: the rule exists to stop one being written by accident, and these are written on
    // purpose to prove the guard does not rely on `instanceof Promise`.
    await withStore(({ store }) => {
      expect(() =>
        (store.write as unknown as (fn: () => unknown) => void)(() => ({
          // biome-ignore lint/suspicious/noThenProperty: a thenable is the fixture (02 §3.7.2 guard 4)
          then: () => undefined,
        })),
      ).toThrow(StorageError);
    });
  });

  it('recognises thenables through isThenable, and ordinary values not at all', () => {
    expect(isThenable(Promise.resolve())).toBe(true);
    // biome-ignore-start lint/suspicious/noThenProperty: thenables are the fixtures here
    expect(isThenable({ then: () => undefined })).toBe(true);
    expect(isThenable(Object.assign(() => undefined, { then: () => undefined }))).toBe(true);
    for (const value of [undefined, null, 0, '', 'x', { then: 1 }, [], () => undefined]) {
      expect(isThenable(value), String(value)).toBe(false);
    }
    // biome-ignore-end lint/suspicious/noThenProperty: end of the thenable fixtures
  });
});

describe('store.nested-savepoint (02 §9.3)', { tags: ['db', 'slow'] }, () => {
  it('rolls back only the inner work when the inner failure is caught', async () => {
    // The named test. A helper that needs a transaction must compose inside a larger one, and when
    // it fails the caller must be able to recover without losing what it had already done.
    await withStore(({ store, db, bodies }) => {
      store.write(() => {
        insert(db, 'outer-before');
        try {
          store.write(() => {
            insert(db, 'inner');
            throw new Error('inner failed');
          });
        } catch {
          // Caught, so the outer transaction continues.
        }
        insert(db, 'outer-after');
      });

      expect(bodies()).toEqual(['outer-before', 'outer-after']);
    });
  });

  it('rolls everything back when the inner failure is not caught', async () => {
    await withStore(({ store, db, rows }) => {
      expect(() =>
        store.write(() => {
          insert(db, 'outer');
          store.write(() => {
            insert(db, 'inner');
            throw new Error('inner failed');
          });
        }),
      ).toThrow();
      expect(rows()).toBe(0);
    });
  });

  it('commits the inner work when nothing fails', async () => {
    await withStore(({ store, db, bodies }) => {
      store.write(() => {
        insert(db, 'outer');
        store.write(() => {
          insert(db, 'inner');
        });
      });
      expect(bodies()).toEqual(['outer', 'inner']);
    });
  });

  it('keeps nesting several levels deep', async () => {
    await withStore(({ store, db, bodies }) => {
      store.write(() => {
        insert(db, 'a');
        store.write(() => {
          insert(db, 'b');
          store.write(() => {
            insert(db, 'c');
          });
        });
      });
      expect(bodies()).toEqual(['a', 'b', 'c']);
    });
  });
});

describe('afterCommit hooks (02 §3.7.2)', { tags: ['db', 'slow'] }, () => {
  it('runs after the commit, in registration order', async () => {
    // After, because the effects these announce — enqueueing work, waking the outbox — must not
    // happen for a transaction that then rolls back. For the outbox that is invariant I6 failing
    // in the direction that sends a message twice.
    await withStore(({ store, db, rows }) => {
      const ran: string[] = [];
      store.write((uow) => {
        uow.afterCommit(() => {
          ran.push('first');
          // Already committed by the time a hook runs.
          expect(rows()).toBe(1);
        });
        uow.afterCommit(() => ran.push('second'));
        insert(db, 'one');
        expect(ran).toEqual([]);
      });
      expect(ran).toEqual(['first', 'second']);
    });
  });

  it('does not run them when the transaction rolls back', async () => {
    await withStore(({ store, db }) => {
      const ran: string[] = [];
      expect(() =>
        store.write((uow) => {
          uow.afterCommit(() => ran.push('hook'));
          insert(db, 'one');
          throw new Error('no');
        }),
      ).toThrow('no');
      expect(ran).toEqual([]);
    });
  });

  it('discards only the inner hooks when a savepoint rolls back (F12)', async () => {
    // **The subtle one.** A hook registered inside a nested transaction that then rolls back must
    // not run — the work it was announcing was undone — while the outer transaction's hooks must.
    // `02` §3.7.2's `mark` is what truncates the list back to where the savepoint started.
    await withStore(({ store, db }) => {
      const ran: string[] = [];
      store.write((uow) => {
        uow.afterCommit(() => ran.push('outer'));
        insert(db, 'outer');
        try {
          store.write((inner) => {
            inner.afterCommit(() => ran.push('inner'));
            insert(db, 'inner');
            throw new Error('inner failed');
          });
        } catch {
          // Caught: the outer transaction continues and commits.
        }
      });
      expect(ran).toEqual(['outer']);
    });
  });

  it('keeps the inner hooks when the savepoint commits', async () => {
    await withStore(({ store, db }) => {
      const ran: string[] = [];
      store.write((uow) => {
        uow.afterCommit(() => ran.push('outer'));
        insert(db, 'outer');
        store.write((inner) => {
          inner.afterCommit(() => ran.push('inner'));
          insert(db, 'inner');
        });
      });
      expect(ran).toEqual(['outer', 'inner']);
    });
  });

  it('logs a hook that throws and runs the rest', async () => {
    // The transaction already committed, so a hook's failure cannot be undone. Letting it
    // propagate would report a committed write as a failure and invite a retry of a change that
    // already landed.
    await withStore(({ store, db, lines }) => {
      const ran: string[] = [];
      store.write((uow) => {
        uow.afterCommit(() => {
          throw new Error('hook exploded');
        });
        uow.afterCommit(() => ran.push('second'));
        insert(db, 'one');
      });

      expect(ran).toEqual(['second']);
      const logged = lines.find((line) => line.event === 'storage.after_commit_failed');
      expect(logged?.level).toBe('error');
      expect(logged?.fields).toMatchObject({ err: { type: 'Error', message: 'hook exploded' } });
    });
  });

  it('lets a hook open its own transaction without re-running the batch', async () => {
    // A hook that calls `write` must start from an empty hook list, or the batch it is inside
    // would run again — and `afterCommit` would become a loop rather than a notification.
    await withStore(({ store, db, bodies }) => {
      const ran: string[] = [];
      store.write((uow) => {
        uow.afterCommit(() => {
          ran.push('hook');
          store.write(() => {
            insert(db, 'from-hook');
          });
        });
        insert(db, 'original');
      });
      expect(ran).toEqual(['hook']);
      expect(bodies()).toEqual(['original', 'from-hook']);
    });
  });
});

describe('a write inside a read is refused', { tags: ['db', 'slow'] }, () => {
  it('throws STORAGE_WRITE_IN_READ rather than promoting the transaction', async () => {
    // `BEGIN DEFERRED` cannot take a write lock without risking `SQLITE_BUSY` against another
    // reader, and promoting it silently would break the snapshot the read exists to provide.
    await withStore(({ store, db }) => {
      try {
        store.read(() => {
          store.write(() => {
            insert(db, 'nope');
          });
        });
        expect.unreachable('a write inside a read must be refused');
      } catch (caught) {
        expect(caught).toBeInstanceOf(StorageError);
        const error = caught as StorageError;
        expect(error.storageCode).toBe('STORAGE_WRITE_IN_READ');
        expect(error.code).toBe('bug');
        expect(error.hint).toContain('own `store.write`');
      }
    });
  });

  it('allows a write again once the read has finished', async () => {
    await withStore(({ store, db, rows }) => {
      store.read(() => undefined);
      expect(store.readDepth).toBe(0);
      store.write(() => {
        insert(db, 'one');
      });
      expect(rows()).toBe(1);
    });
  });

  it('allows nested reads', async () => {
    await withStore(({ store }) => {
      const depths = store.read(() => {
        const outer = store.readDepth;
        const inner = store.read(() => store.readDepth);
        return [outer, inner];
      });
      expect(depths).toEqual([1, 2]);
    });
  });
});

describe('slow-transaction logging (02 §3.7.2)', { tags: ['db', 'slow'] }, () => {
  it('logs a transaction over the threshold, with the op and no parameters', async () => {
    // `op` and a duration, never parameters. On a Pi the write lock is the one resource everything
    // else waits on, so this is what separates "the Pi is slow" from "one transaction is holding
    // the database".
    await withStore(
      ({ store, db, lines }) => {
        store.write(
          () => {
            const insertOne = db.prepare('INSERT INTO t (body) VALUES (?)');
            for (let n = 0; n < 2000; n += 1) insertOne.run(`row ${String(n)}`);
          },
          { op: 'seed.rows' },
        );

        const slow = lines.find((line) => line.event === 'storage.slow_tx');
        expect(slow).toBeDefined();
        if (slow === undefined) return;
        expect(slow.level).toBe('warn');
        expect(slow.fields).toMatchObject({ detail: { op: 'seed.rows', thresholdMs: 0 } });
        expect(typeof (slow.fields as { durationMs?: unknown }).durationMs).toBe('number');
      },
      // Zero, so any real work crosses it — the alternative is a test that sleeps.
      { slowTxMs: 0 },
    );
  });

  it('says nothing about a fast transaction', async () => {
    await withStore(({ store, db, lines }) => {
      store.write(
        () => {
          insert(db, 'one');
        },
        { op: 'fast.one' },
      );
      expect(lines.filter((line) => line.event === 'storage.slow_tx')).toEqual([]);
    });
  });

  it('logs only the outermost transaction, not each savepoint', async () => {
    // Otherwise one slow outer transaction would produce a line per nested helper, and the signal
    // would be buried in its own noise.
    await withStore(
      ({ store, db, lines }) => {
        store.write(
          () => {
            insert(db, 'outer');
            store.write(() => {
              insert(db, 'inner');
            });
          },
          { op: 'outer.only' },
        );
        expect(lines.filter((line) => line.event === 'storage.slow_tx')).toHaveLength(1);
      },
      { slowTxMs: 0 },
    );
  });

  it('defaults the threshold to the specified 50 ms', async () => {
    expect(DEFAULT_SLOW_TX_MS).toBe(50);
    await Promise.resolve();
  });

  it('logs a slow read too', async () => {
    await withStore(
      ({ store, db, lines }) => {
        store.read(
          () => {
            db.prepare('SELECT count(*) AS n FROM t').get();
          },
          { op: 'slow.read' },
        );
        expect(lines.some((line) => line.event === 'storage.slow_tx')).toBe(true);
      },
      { slowTxMs: 0 },
    );
  });
});
