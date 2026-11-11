/**
 * `SqliteStore` — the one place that opens a transaction (`02` §3.7.2).
 *
 * `01` §1 and `CLAUDE.md` §2: **better-sqlite3 transactions never span an `await`.** The reason is
 * in `core/src/ports/storage/store.ts`, and it is worth repeating because the failure is silent:
 * `db.transaction(fn)` commits the moment `fn` returns, so an `async fn` returns a promise, the
 * transaction commits around nothing, and the work then runs outside it with no isolation and no
 * rollback. Nothing throws.
 *
 * This module is therefore the **only** one allowed to call `db.transaction(...)`, enforced by a
 * lint rule rather than by review. Everything else goes through `write` and `read`.
 *
 * Three behaviours here are worth reading before changing anything:
 *
 *  - **Nesting becomes a savepoint.** better-sqlite3's transaction functions nest, and the inner
 *    one becomes a `SAVEPOINT`. That is what lets a helper that needs a transaction compose inside
 *    a larger one instead of committing early or failing.
 *  - **`afterCommit` hooks follow the savepoint.** A hook registered inside a nested transaction
 *    that then rolls back must not run — the work it was announcing did not happen. `02` §3.7.2's
 *    `mark` is how: the hook list is truncated back to where the savepoint started (F12).
 *  - **A write inside a read is refused.** `BEGIN DEFERRED` cannot upgrade to a write lock without
 *    risking `SQLITE_BUSY` against another reader, and silently promoting the outer transaction
 *    would break the snapshot the read exists to provide.
 */
import { performance } from 'node:perf_hooks';
import type { NotPromise, ReadScope, Store, TxMeta, UnitOfWork } from '@comvivo/core';
import {
  type Clock,
  type IdGenerator,
  type Logger,
  type Rng,
  StorageError,
  SystemRng,
} from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { makeRepositories, type Repositories } from '../repos/index.js';
import { makeDb } from './drizzle.js';
import { isSqliteError, mapSqliteError } from './errors.js';

/**
 * The reader half of a repository set, as `ReadScope` names them.
 *
 * Spelled out rather than spread wholesale, so a `read` transaction cannot reach a writer by
 * accident: the object `read` hands out has exactly the seven reader properties, and TypeScript's
 * structural typing would otherwise let the writer methods through on the same instances.
 */
function readersOf(repos: Repositories): Omit<ReadScope, 'now'> {
  return {
    groups: repos.groups,
    persons: repos.persons,
    identities: repos.identities,
    members: repos.members,
    conversations: repos.conversations,
    messages: repos.messages,
    settings: repos.settings,
    memories: repos.memories,
    calendar: repos.calendar,
    reminders: repos.reminders,
    tasks: repos.tasks,
    lists: repos.lists,
    polls: repos.polls,
    plans: repos.plans,
    decisions: repos.decisions,
    governance: repos.governance,
    turns: repos.journal,
    traces: repos.traces,
    audit: repos.audit,
    usage: repos.usage,
    labels: repos.labels,
  };
}

/** `02` §3.7.2: `storage.slowTxMs`, default 50. */
export const DEFAULT_SLOW_TX_MS = 50;

export interface SqliteStoreOptions {
  readonly db: Database.Database;
  readonly clock: Clock;
  /** Slow-transaction logging goes here. Never parameters, never content (`01` §11.7). */
  readonly logger: Logger;
  /**
   * The id generator, for the repositories that mint ids of their own.
   *
   * Only `EmbeddingSpaceManager` does today — a space is created by configuration loading rather
   * than by a caller who could supply an id. Injected rather than constructed here because
   * `01` §4 makes ids a port: a test needs a deterministic sequence, and `TypeIdGenerator` reaches
   * a CSPRNG.
   */
  readonly ids: IdGenerator;
  /**
   * The random source the outbox's backoff draws its jitter from (`02` §3.10.3).
   *
   * A port for the same reason ids are: the formula is in `core`, where `Math.random` is banned,
   * and a retry delay a test cannot predict is a retry delay no test asserts. Defaults to
   * `SystemRng` so a host need not supply one.
   */
  readonly rng?: Rng;
  /** `storage.slowTxMs`. A transaction over this logs `storage.slow_tx`. */
  readonly slowTxMs?: number;
  /**
   * The repository set, if one is already built.
   *
   * Omitted in production: the store builds its own from `db`, which is the only way to guarantee
   * that the repositories and the transaction wrapper share a connection. Supplied by tests that
   * need to observe a repository directly, and by `02` D22's read-only worker, which has a
   * narrower set.
   */
  readonly repositories?: Repositories;
}

/**
 * Is this value promise-like?
 *
 * Duck-typed rather than `instanceof Promise`, because a thenable from another library — or a
 * `Promise` from another realm — is just as fatal here and would pass an `instanceof` check in
 * neither case. This is guard 4 of the four in `store.ts`: the one that catches an untyped caller.
 */
export function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

export class SqliteStore implements Store {
  readonly #db: Database.Database;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #slowTxMs: number;
  readonly #repositories: Repositories;

  /** Write nesting depth. 0 means the next `write` is the outermost one. */
  #depth = 0;
  /** Read nesting depth, so a `write` inside a `read` can be refused. */
  #readDepth = 0;
  /** Hooks for the **outermost** write. Nested writes append to this same list. */
  #hooks: (() => void)[] = [];

  constructor(options: SqliteStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#logger = options.logger;
    this.#slowTxMs = options.slowTxMs ?? DEFAULT_SLOW_TX_MS;
    // Built here rather than taken as an option, so there is exactly one repository set per store
    // and a caller cannot hand in one built against a different connection. `makeRepositories` is
    // still exported, because a test that wants a repository without a transaction wrapper is a
    // reasonable thing to want.
    this.#repositories =
      options.repositories ??
      makeRepositories({
        db: makeDb(options.db),
        connection: options.db,
        ids: options.ids,
        rng: options.rng ?? new SystemRng(),
        clock: options.clock,
      });
  }

  write<T>(fn: (uow: UnitOfWork) => NotPromise<T>, meta?: TxMeta): T {
    if (this.#readDepth > 0) {
      throw new StorageError(
        'STORAGE_WRITE_IN_READ',
        'a write was attempted inside a read transaction',
        {
          hint:
            'This is a bug. A `read` takes a `BEGIN DEFERRED` snapshot, and promoting it to a ' +
            'write would both break the snapshot its caller relies on and risk `SQLITE_BUSY` ' +
            'against another reader. Do the write in its own `store.write`, before or after.',
          category: 'bug',
          ...(meta === undefined ? {} : { detail: { op: meta.op } }),
        },
      );
    }

    const outer = this.#depth === 0;
    if (outer) this.#hooks = [];
    // Where this transaction's hooks start. A savepoint rollback truncates back to here, so a
    // nested transaction that fails does not leave hooks announcing work that was undone (F12).
    const mark = this.#hooks.length;
    const startedAt = performance.now();

    const run = this.#db.transaction(() => {
      this.#depth += 1;
      try {
        const result = fn(this.#unitOfWork());
        if (isThenable(result)) {
          // Guard 4. The transaction is still open, so throwing here rolls it back — which is the
          // whole point: an async callback's work has not run yet, and committing would commit
          // nothing while reporting success.
          throw new StorageError(
            'STORAGE_TX_ASYNC_CALLBACK',
            'a transaction callback returned a promise',
            {
              hint:
                'Transaction callbacks must be synchronous (`01` §1). better-sqlite3 commits when ' +
                'the callback returns, so an async one commits an empty transaction and then does ' +
                'its work outside it, with no isolation and no rollback. Move the awaiting outside ' +
                'the transaction.',
              category: 'bug',
              ...(meta === undefined ? {} : { detail: { op: meta.op } }),
            },
          );
        }
        return result;
      } finally {
        this.#depth -= 1;
      }
    });

    let result: T;
    try {
      // `immediate()` takes the write lock up front (`02` D10). Nested calls run as savepoints.
      result = outer ? run.immediate() : run();
    } catch (caught) {
      // Rolled back, so the hooks it registered must not run.
      if (outer) this.#hooks = [];
      else this.#hooks.length = mark;
      throw this.#asStorageFailure(caught, meta);
    }

    if (outer) {
      this.#warnIfSlow(performance.now() - startedAt, meta);
      // Taken and cleared before running, so a hook that itself calls `write` starts from an empty
      // list rather than re-running the batch it is inside.
      const hooks = this.#hooks;
      this.#hooks = [];
      for (const hook of hooks) this.#runHook(hook, meta);
    }
    return result;
  }

  read<T>(fn: (scope: ReadScope) => NotPromise<T>, meta?: TxMeta): T {
    const outer = this.#readDepth === 0;
    const startedAt = performance.now();

    const run = this.#db.transaction(() => {
      this.#readDepth += 1;
      try {
        const result = fn(this.#readScope());
        if (isThenable(result)) {
          throw new StorageError(
            'STORAGE_TX_ASYNC_CALLBACK',
            'a read callback returned a promise',
            {
              hint:
                'Read callbacks must be synchronous (`01` §1). An async one returns before the ' +
                'snapshot is used, so the reads happen outside it and can disagree with each ' +
                'other — which is the one thing a read transaction exists to prevent.',
              category: 'bug',
              ...(meta === undefined ? {} : { detail: { op: meta.op } }),
            },
          );
        }
        return result;
      } finally {
        this.#readDepth -= 1;
      }
    });

    try {
      // `deferred()` — a read must not take a write lock, or every context build would serialise
      // against the writer.
      const result = outer ? run.deferred() : run();
      if (outer) this.#warnIfSlow(performance.now() - startedAt, meta);
      return result;
    } catch (caught) {
      throw this.#asStorageFailure(caught, meta);
    }
  }

  /**
   * Map a **database** failure, and let anything else through untouched.
   *
   * The distinction matters more than it looks. A transaction callback contains arbitrary caller
   * code — a policy check, a validation, a domain invariant — and `mapSqliteError`'s fallback turns
   * any unrecognised throw into `STORAGE_IO` with the message "the database failed". The first
   * version of this class ran every throw through it, so a `ValidationError` raised inside a
   * transaction reached the caller as a storage failure with its own message gone. That is worse
   * than unhelpful: it reports the host's disk as the problem and invites a retry of something that
   * will fail identically every time.
   *
   * So only a real SQLite error — or an already-mapped `StorageError` — is translated. Everything
   * else is rethrown exactly as it was raised, with its stack intact.
   */
  #asStorageFailure(caught: unknown, meta?: TxMeta): unknown {
    if (!isSqliteError(caught) && !(caught instanceof StorageError)) return caught;
    return mapSqliteError(caught, {
      encrypted: true,
      ...(meta === undefined ? {} : { operation: meta.op }),
    });
  }

  /** Write nesting depth, for tests and for `doctor`. */
  get depth(): number {
    return this.#depth;
  }

  /** Read nesting depth. */
  get readDepth(): number {
    return this.#readDepth;
  }

  /**
   * The unit of work handed to a callback.
   *
   * `now` is read **once per transaction**, so every row one logical change writes carries the
   * same instant. A clock read per row would let `createdAt` orderings disagree with the
   * transaction's own atomicity, and the turn journal and outbox read timestamps as sequence
   * (I6, I7).
   *
   * Every repository `02` §3.7.1 lists is here, and that completeness is itself a finding: `M1-T19`
   * through `M1-T22` added eleven repositories to `Repositories` and **none** to `ReadScope` or
   * `UnitOfWork`, so nothing could reach them through a transaction at all. Their contract tests
   * passed because they go through `world.repos.*` directly, which is how the gap survived four
   * green suites. `M1-T26` adds `deletions`.
   */
  #unitOfWork(): UnitOfWork {
    const hooks = this.#hooks;
    const repos = this.#repositories;
    return {
      ...readersOf(repos),
      now: this.#clock.now(),
      afterCommit(cb: () => void): void {
        hooks.push(cb);
      },
      groupsW: repos.groups,
      personsW: repos.persons,
      identitiesW: repos.identities,
      membersW: repos.members,
      conversationsW: repos.conversations,
      messagesW: repos.messages,
      settingsW: repos.settings,
      labelsW: repos.labels,
      deletions: repos.deletions,
      memoriesW: repos.memories,
      calendarW: repos.calendar,
      remindersW: repos.reminders,
      tasksW: repos.tasks,
      listsW: repos.lists,
      pollsW: repos.polls,
      plansW: repos.plans,
      decisionsW: repos.decisions,
      governanceW: repos.governance,
      journal: repos.journal,
      tracesW: repos.traces,
      auditW: repos.audit,
      usageW: repos.usage,
      outbox: repos.outbox,
      jobs: repos.jobs,
    };
  }

  #readScope(): ReadScope {
    return { ...readersOf(this.#repositories), now: this.#clock.now() };
  }

  /**
   * Run one `afterCommit` hook, swallowing its failure.
   *
   * The transaction has already committed, so there is nothing to undo. Letting a hook's error
   * propagate would report a successful write as a failure and invite the caller to retry a
   * change that already landed — which for the outbox means sending twice (I6).
   */
  #runHook(hook: () => void, meta?: TxMeta): void {
    try {
      hook();
    } catch (caught) {
      // `err` is the allowlisted diagnostics field, and `op` goes in `detail` because `LogFields`
      // has no named slot for it. A `detail` string must be token-shaped (`fields.ts`), which an
      // `op` like `turn.commit` is.
      this.#logger.error('storage.after_commit_failed', {
        err: {
          type: caught instanceof Error ? caught.name : typeof caught,
          message: caught instanceof Error ? caught.message : String(caught),
        },
        ...(meta === undefined ? {} : { detail: { op: meta.op } }),
      });
    }
  }

  /**
   * Log a transaction that held the write lock too long (`02` §3.7.2).
   *
   * `op` and a duration, never parameters. A slow transaction is almost always a loop that should
   * have been batched, and on a Pi the write lock is the one resource everything else waits on —
   * so this is the signal that distinguishes "the Pi is slow" from "one query is holding the
   * database".
   */
  #warnIfSlow(durationMs: number, meta?: TxMeta): void {
    if (durationMs <= this.#slowTxMs) return;
    this.#logger.warn('storage.slow_tx', {
      durationMs: Math.round(durationMs),
      detail: {
        thresholdMs: this.#slowTxMs,
        ...(meta === undefined ? {} : { op: meta.op }),
      },
    });
  }
}
