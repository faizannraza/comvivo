/**
 * `group.purge` — the resumable chunked deletion of one group (`02` §3.13.4).
 *
 * `02` §3.13.4 splits group deletion in two, and the split is the design:
 *
 *  - **One transaction** marks the group `deleting`, pauses its partition, cancels its queued work
 *    and undelivered sends, writes the `deletions` row and enqueues this job. That is
 *    `requestGroupPurge` in `primitives.ts`, and from the instant it commits the group answers
 *    `not_found` to every read.
 *  - **This job** then deletes the rows, in chunks of 5 000, with a yield between them, resuming
 *    from `deletions.progress` after a crash.
 *
 * `02` D18 is why: a million-row cascade in one transaction blocks the event loop for seconds and
 * holds the write lock for all of them. A family group is nowhere near a million rows — but a group
 * with three years of a busy chat is hundreds of thousands, and "deleting a group makes the
 * instance unresponsive for ten seconds" is a product failure even when the deletion is correct.
 *
 * ## The steps are the introspected table order, not a list
 *
 * `inventory.ts` discovers every table with a `group_id`, children before parents, `groups` last.
 * A hand-written list would have to be edited by every milestone that adds a table, and the failure
 * when it was not would be **invisible**: every group-scoped table cascades from `groups`, so the
 * final `DELETE FROM groups` removes whatever the steps missed. The test would pass. What would be
 * lost is the chunking — a missed table is not a leak, it is the stall D18 exists to prevent.
 *
 * Three steps are **not** introspected, because they are not scoped by `group_id` at all: `jobs`
 * and `job_schedules` are keyed by `partition_key`, and `job_partitions` by the partition itself.
 * No cascade reaches them, so without these three a deleted group would leave its queue rows and
 * its paused-partition marker behind forever.
 *
 * ## Resumption is by step name, and that is why the order has to be stable
 *
 * `deletions.progress.step` holds the table a crashed purge was working on. Each step runs to
 * exhaustion before the cursor advances, so resuming *at* that step is always safe — it is
 * idempotent, and at worst it re-reads a table that is already empty. What is not safe is an order
 * that changes between two runs, which is why `inventory.ts` sorts rather than relying on
 * `sqlite_schema`'s order.
 */
import type { Store, TxToken } from '@comvivo/core';
import { PURGE_CHUNK_ROWS } from '@comvivo/core';
import { type DeletionId, type Logger, StorageError } from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { Db } from '../db/drizzle.js';
import { deleteByColumnChunk, deleteGroupChunk } from './chunk.js';
import { type GroupScopedTable, groupScopedTables } from './inventory.js';

/** One step of a purge: a name for `deletions.progress`, and a bounded delete. */
interface PurgeStep {
  readonly name: string;
  readonly run: (uow: TxToken, limit: number) => number;
}

export interface GroupPurgeOptions {
  readonly store: Pick<Store, 'write'>;
  readonly db: Db;
  readonly connection: Database.Database;
  readonly logger: Logger;
  /** Overridden by tests, so a resumption can be driven without seeding five thousand rows. */
  readonly chunkRows?: number;
}

export interface GroupPurgeResult {
  readonly groupId: string;
  /** Rows deleted per step, for the audit detail and the log line. Never content. */
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
}

/**
 * The step name of the final transaction.
 *
 * A name rather than "the last table", because the final step is not a chunked delete: it removes
 * the `groups` row, reclaims the pages and marks the `deletions` row complete, all in one
 * transaction. A resumption that finds this name knows the rows are gone and only the finish is
 * owed.
 */
const FINISH_STEP = 'finish';

export class GroupPurge {
  readonly #options: GroupPurgeOptions;

  constructor(options: GroupPurgeOptions) {
    this.#options = options;
  }

  /**
   * Run — or resume — the purge of the group named by `deletionId`.
   *
   * `async`, and every transaction inside it is a separate `store.write`: `01` §1 forbids an
   * `await` inside a transaction, and the yield between chunks is the whole reason this is a job
   * rather than a function call.
   */
  async run(deletionId: DeletionId): Promise<GroupPurgeResult> {
    const limit = this.#options.chunkRows ?? PURGE_CHUNK_ROWS;
    const record = this.#options.store.write((uow) => uow.deletions.byId(deletionId));
    if (record === undefined || record.scope !== 'group') {
      throw new StorageError('STORAGE_CONSTRAINT', 'that deletion is not a group purge', {
        hint: 'The payload names a `deletions` row that does not exist or has another scope.',
        category: 'bug',
        detail: { deletionId },
      });
    }
    const groupId = record.subjectRef;
    const steps = this.#steps(groupId);
    this.#options.logger.info('deletion.started', { groupId, detail: { scope: 'group' } });
    /**
     * Per-step counts, for the result and the log line — **not** for the progress record.
     *
     * `DeletionProgress.counts` is capped at 64 keys and there are more than sixty group-scoped
     * tables, so a record carrying one counter per step would fail its own validation on a database
     * with a few more tables. That is a purge unable to write its own progress, which is a purge
     * that cannot resume. The column gets a running total; the breakdown stays here.
     */
    const counts: Record<string, number> = {};
    let total = record.progress.counts['deleted'] ?? 0;

    // Resume where the crash left off. `indexOf` on a name that is no longer a step — a table a
    // migration dropped between the crash and the restart — restarts the purge from the beginning,
    // which is correct: every step is idempotent, and the alternative is skipping the rest.
    const resumeAt = Math.max(
      0,
      steps.findIndex((step) => step.name === record.progress.step),
    );

    for (const step of steps.slice(resumeAt)) {
      const deleted = await this.#drain(step, deletionId, limit);
      if (deleted > 0) counts[step.name] = deleted;
      total += deleted;
      this.#options.store.write((uow) =>
        uow.deletions.advance(uow, deletionId, {
          step: step.name,
          cursor: null,
          counts: { deleted: total },
        }),
      );
    }

    this.#finish(deletionId, total);
    this.#options.logger.info('deletion.completed', {
      groupId,
      count: total,
      detail: { scope: 'group' },
    });
    return { groupId, counts, total };
  }

  /** Run one step to exhaustion, one transaction and one yield per chunk. */
  async #drain(step: PurgeStep, deletionId: DeletionId, limit: number): Promise<number> {
    let deleted = 0;
    for (;;) {
      const n = this.#options.store.write((uow) => {
        // The fence: a purge whose `deletions` row was completed by another runner stops here
        // rather than deleting rows nobody is tracking.
        const live = uow.deletions.byId(deletionId);
        if (live === undefined || live.status === 'completed') return 0;
        return step.run(uow, limit);
      });
      if (n === 0) return deleted;
      deleted += n;
      // `02` §3.13.2's "yield the event loop between chunks". Without it the loop holds the thread
      // for the whole purge and the chunking buys nothing but a shorter write lock.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  /**
   * The last transaction: the group row, the page reclaim, and the completion.
   *
   * `incremental_vacuum` and `wal_checkpoint(TRUNCATE)` are outside the transaction because SQLite
   * refuses both inside one — and that is fine here: by this point every row is gone, so a crash
   * before the reclaim leaves a correct database with pages on its free list, which the next
   * maintenance pass takes.
   */
  #finish(deletionId: DeletionId, total: number): void {
    this.#options.store.write((uow) => {
      uow.deletions.advance(uow, deletionId, {
        step: FINISH_STEP,
        cursor: null,
        counts: { deleted: total },
      });
      uow.deletions.complete(uow, deletionId, uow.now);
    });
    this.#options.connection.pragma('incremental_vacuum(2048)');
    this.#options.connection.pragma('wal_checkpoint(TRUNCATE)');
  }

  /**
   * Every step, in order: the introspected tables, then the three keyed on something else.
   *
   * `groups` is moved out of the introspected list and into the finish transaction — it is one row,
   * it is the thing whose absence means "purged", and deleting it in a chunk loop would mean a
   * second transaction after it with nothing to do.
   */
  #steps(groupId: string): readonly PurgeStep[] {
    const { db } = this.#options;
    const tables = groupScopedTables(this.#options.connection).filter(
      (entry) => entry.table !== 'groups',
    );
    const rowSteps = tables.map((entry: GroupScopedTable) => ({
      name: entry.table,
      run: (_uow: TxToken, limit: number) => deleteGroupChunk(db, entry, groupId, limit),
    }));
    return [
      ...rowSteps,
      // `partition_key` is the group id for a group-scoped kind (`02` §3.10.1). No cascade reaches
      // these: `jobs` and `job_schedules` hold a partition key, not a foreign key, so a purge that
      // skipped them would leave a deleted group's queue rows and its paused-partition marker in
      // the database forever — and `job_partitions` is what the claim query reads, so the marker
      // would quietly exclude a partition key that could one day be reused.
      {
        name: 'jobs.partition',
        run: (_uow, limit) => deleteByColumnChunk(db, 'jobs', 'partition_key', groupId, limit),
      },
      {
        name: 'job_schedules.partition',
        run: (_uow, limit) =>
          deleteByColumnChunk(db, 'job_schedules', 'partition_key', groupId, limit),
      },
      {
        name: 'job_partitions.row',
        run: (_uow, limit) =>
          deleteByColumnChunk(db, 'job_partitions', 'partition_key', groupId, limit),
      },
      {
        name: 'groups.row',
        run: (uow: TxToken, _limit: number) => deleteGroupRow(uow, db, groupId),
      },
    ];
  }
}

/** Delete the group row itself. One row, so no chunking — and `02` §3.13.4 puts it last. */
function deleteGroupRow(_uow: TxToken, db: Db, groupId: string): number {
  return deleteGroupChunk(db, { table: 'groups', column: 'id', virtual: false }, groupId, 1);
}
