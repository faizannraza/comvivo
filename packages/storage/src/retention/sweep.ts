/**
 * `retention.sweep` — the daily pass that honours `02` §3.13.1's windows (`02` §3.13.2).
 *
 * §3.13.2's pseudocode is four lines and every one of them is load-bearing:
 *
 * ```
 * for table in [...]:
 *   loop:
 *     n = store.write(uow => uow.deletions.sweepChunk(table, now, 1000))
 *     if n == 0: break
 *     await setImmediate()
 * then: PRAGMA incremental_vacuum(2048); PRAGMA wal_checkpoint(TRUNCATE)
 * ```
 *
 *  - **One transaction per chunk**, so the write lock is held for a thousand rows rather than for
 *    the whole pass. A host sending a message while retention runs waits milliseconds.
 *  - **`setImmediate` between chunks**, so the event loop runs. Without it the thousand-row limit
 *    bounds the lock but not the *thread*, and the instance stops answering for the whole sweep.
 *  - **The vacuum and the checkpoint last**, and outside any transaction, because SQLite refuses
 *    both inside one. Deleting rows returns pages to the free list; `incremental_vacuum` is what
 *    returns them to the filesystem, and on a Pi with a 32 GB card that difference is the product
 *    working or not.
 *
 * ## `now` is read once
 *
 * One reading for the whole pass, taken at the start. A sweep that re-read the clock per chunk
 * would move its own cutoff forward while it ran, so a row that was six hours inside the window at
 * the start could fall outside it by the end — and the pass would delete data the host's settings
 * said to keep, occasionally, depending on how long the sweep took.
 */
import type { RetentionWindows, Store, SweepableTable } from '@comvivo/core';
import { SWEEP_CHUNK_ROWS, SWEEPABLE_TABLES } from '@comvivo/core';
import type { Logger } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { optimizeFtsIndexes } from './fts.js';

export interface RetentionSweepOptions {
  readonly store: Pick<Store, 'write'>;
  readonly db: Db;
  readonly connection: Database.Database;
  readonly logger: Logger;
  /** Overridden by tests so a chunked loop can be driven with three rows instead of a thousand. */
  readonly chunkRows?: number;
}

export interface SweepResult {
  /** Rows removed per table. Tables with nothing to do are left out. */
  readonly deleted: Readonly<Record<string, number>>;
  readonly total: number;
  /** `02` §3.13.2's `RETENTION_UNEXTRACTED`: messages deleted before extraction read them. */
  readonly unextracted: number;
}

export class RetentionSweep {
  readonly #options: RetentionSweepOptions;

  constructor(options: RetentionSweepOptions) {
    this.#options = options;
  }

  /**
   * One full pass.
   *
   * `now` is a parameter rather than a clock read, for the same reason every repository takes
   * `uow.now`: a sweep a test cannot place in time is a sweep no test can assert the boundary of.
   */
  async run(now: Temporal.Instant, windows: RetentionWindows): Promise<SweepResult> {
    const limit = this.#options.chunkRows ?? SWEEP_CHUNK_ROWS;
    // Counted **before** anything is deleted, which is the only time it can be counted: `02`
    // §3.13.2 says retention wins over memory and the sweep "deletes anyway", so this number is a
    // warning and not a veto — and after the delete there is nothing left to count.
    const unextracted = this.#countUnextracted(now);
    if (unextracted > 0) {
      this.#options.logger.warn('retention.unextracted', { count: unextracted });
    }

    const deleted: Record<string, number> = {};
    let total = 0;
    for (const table of SWEEPABLE_TABLES) {
      const removed = await this.#drain(table, now, windows, limit);
      if (removed > 0) deleted[table] = removed;
      total += removed;
    }

    // Outside every transaction: SQLite refuses the two pragmas inside one, and an `optimize`
    // rewrites every FTS segment so it has no business holding a write lock either. A crash
    // between the deletes and these three leaves a correct database with pages on its free list
    // and stale terms in the indexes, which the next pass takes.
    //
    // The FTS optimize is `02` §3.13.2's list as amended at `M1-T26`: `secure-delete` makes a
    // deleted row unmatchable and overwrites its position list, but leaves its **terms** in the
    // segment dictionary — so a swept message's distinctive words stay in `messages_fts_data` as
    // raw bytes until a merge rewrites them. `schema/search.sql.ts` has the measurement.
    optimizeFtsIndexes(this.#options.connection);
    this.#options.connection.pragma('incremental_vacuum(2048)');
    this.#options.connection.pragma('wal_checkpoint(TRUNCATE)');

    this.#options.logger.info('retention.swept', { count: total });
    return { deleted, total, unextracted };
  }

  /** One table, to exhaustion: a transaction per chunk and a yield between them. */
  async #drain(
    table: SweepableTable,
    now: Temporal.Instant,
    windows: RetentionWindows,
    limit: number,
  ): Promise<number> {
    let deleted = 0;
    for (;;) {
      const n = this.#options.store.write(
        (uow) => uow.deletions.sweepChunk(uow, table, now, windows, limit),
        { op: `retention.sweep.${table}` },
      );
      if (n === 0) return deleted;
      deleted += n;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  /**
   * How many about-to-be-swept messages extraction never read (`02` §3.13.2).
   *
   * The condition is `extraction_cursors.last_rid < rid`, and the `LEFT JOIN` with `coalesce(…, 0)`
   * is what makes a conversation with **no** cursor row count as "read nothing" rather than
   * vanishing from the result — which is the common case for a conversation whose extraction never
   * ran at all, and the one most worth warning about.
   *
   * It is a count and not a list: the ids would be message ids, and a log line carrying them is a
   * log line carrying a pointer to content (`01` §11.7).
   */
  #countUnextracted(now: Temporal.Instant): number {
    const rows = this.#options.db.all<{ n: number }>(
      sql`SELECT count(*) AS n
            FROM messages m
            LEFT JOIN extraction_cursors c ON c.conversation_id = m.conversation_id
           WHERE m.retention_until IS NOT NULL
             AND m.retention_until <= ${now.epochMilliseconds}
             AND m.rid > coalesce(c.last_rid, 0)`,
    );
    return rows[0]?.n ?? 0;
  }
}
