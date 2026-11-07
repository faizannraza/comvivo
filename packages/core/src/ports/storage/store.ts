/**
 * The `Store` port: the only way into a transaction (`02` §3.7.1, D10; `01` §1).
 *
 * ## Why transactions are synchronous
 *
 * better-sqlite3 is a **synchronous** driver. Its `db.transaction(fn)` wraps `fn` in
 * `BEGIN`/`COMMIT` and commits the moment `fn` returns — so an `async fn` returns a *promise*
 * immediately, the transaction commits around nothing, and the actual work then runs outside it
 * with no isolation and no rollback. Nothing throws. The data is simply wrong, intermittently,
 * under concurrency.
 *
 * That is why `01` §1 makes it a spine rule and `CLAUDE.md` §2 repeats it: **transactions never
 * span an `await`.** This file is where the rule becomes a type error rather than a convention.
 *
 * ## Four guards, because one is not enough
 *
 * `02` §3.7.2 lists them, and they fail in different directions:
 *
 *  1. **`NotPromise<T>`** turns an `async` callback into a compile error. Static, free, and the
 *     one that catches the mistake while it is being written.
 *  2. **A lint rule** (`eslint.config.ts`) rejects `async` callbacks to `write`/`read`/
 *     `transaction` syntactically — it catches the case where the return type is widened or the
 *     callback is written somewhere the type cannot reach it.
 *  3. **`no-floating-promises`** catches a promise *created* inside a callback and not awaited,
 *     which `NotPromise` cannot see because the callback still returns something synchronous.
 *  4. **A runtime check** in `SqliteStore` throws `STORAGE_TX_ASYNC_CALLBACK`. Defence in depth,
 *     for the untyped caller — a plugin, a REPL, a `JSON`-driven path.
 *
 * Any one of them can be defeated. A promise that reaches SQLite cannot be.
 *
 * ## `TxToken`
 *
 * Repository methods take the `UnitOfWork` as their first argument, so "this call needs a
 * transaction" is visible in the signature rather than being an unwritten rule about call order.
 * The alternative — repositories holding a connection and starting their own transactions — is how
 * a single logical change ends up as four commits, three of which can be interrupted.
 */
import type { Temporal } from 'temporal-polyfill';

/**
 * `never` for anything promise-like, so an `async` callback is a compile error.
 *
 * `PromiseLike` rather than `Promise`: a thenable from another library, or a `Promise` from a
 * different realm, is just as fatal here and does not pass an `instanceof Promise` check either.
 */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

/** What a caller is doing, for slow-transaction logs. Never parameters, never content. */
export interface TxMeta {
  /** A short, stable name — `turn.commit`, `outbox.claim`. Appears in logs and metrics. */
  readonly op: string;
}

/**
 * Every write returns a discriminated union, never a bare value or a thrown domain error
 * (`02` §3.7.1).
 *
 * The distinction that matters is between **expected** outcomes and **infrastructure failures**.
 * A version conflict, a missing row and a duplicate are all things the caller has to decide about,
 * so they are values. A full disk is not, so it throws `StorageError`. Collapsing the two — by
 * throwing on conflict, or by returning `undefined` for both "not found" and "disk error" — is how
 * a retry loop ends up retrying a full disk forever.
 */
export type WriteResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** Optimistic concurrency: `expectVersion` did not match. The caller re-reads and decides. */
  | { readonly kind: 'conflict' }
  | { readonly kind: 'not_found' }
  /** An idempotency or dedupe index already had this. `02` §4.3: returned, never thrown. */
  | { readonly kind: 'duplicate'; readonly existingId: string };

/**
 * A consistent read scope: `BEGIN DEFERRED` … `COMMIT`.
 *
 * Readers are added by the milestone that creates each aggregate (`M1-T12` onward), so the only
 * member today is the clock.
 *
 * **`now` is here rather than only on `UnitOfWork`**, which is a small refinement of `02` §3.7.1's
 * shape and is logged as one. A read transaction needs a transaction-stable clock reading for
 * exactly the reason a write does: a context build reads a dozen tables, and if it asks what time
 * it is twice it must get the same answer, or an "upcoming event" can be inside the window for one
 * query and outside it for the next. `UnitOfWork extends ReadScope`, so nothing is lost.
 *
 * It also removes an empty object type, which is worth stating because both linters refused every
 * spelling of one — an empty interface, `{}`, and `Readonly<Record<never, never>>` all resolve to
 * `{}` and accept **any** non-nullish value, `0` and `''` included. They were right: a `ReadScope`
 * parameter that accepts a number is not a type. Giving the interface the member it should have had
 * was the fix; suppressing the rule would have kept the hole.
 */
export interface ReadScope {
  /**
   * The clock, read once and stable for the whole transaction.
   *
   * One reading, so every row a logical change writes carries the same instant and every query in
   * one read agrees about the present.
   */
  readonly now: Temporal.Instant;
}

/**
 * A unit of work: `BEGIN IMMEDIATE` … `COMMIT`, plus the writes.
 *
 * `IMMEDIATE` rather than `DEFERRED` for writes, per `02` D10. A deferred transaction takes its
 * write lock on the first write, which means a transaction that reads and then writes can fail to
 * *upgrade* its lock and get `SQLITE_BUSY` — against a CLI command or a backup holding a read.
 * Taking the write lock up front turns that into waiting instead of failing.
 */
export interface UnitOfWork extends ReadScope {
  /**
   * Run `cb` **after** the commit succeeds, synchronously, in registration order.
   *
   * For the effects that must not happen unless the transaction did: enqueueing work, waking the
   * outbox, emitting a metric. Doing them inside the transaction means they happen for a
   * transaction that then rolls back — which for the outbox is invariant I6 (exactly-once intent)
   * failing in the direction that sends a message twice.
   *
   * Errors are logged and never thrown: the transaction has already committed, so there is nothing
   * to undo, and letting a hook's failure propagate would report a successful write as a failure
   * and invite the caller to retry it.
   */
  afterCommit(cb: () => void): void;
}

/**
 * The token repositories take, making "this needs a transaction" visible in the signature.
 *
 * It *is* the `UnitOfWork`. A distinct branded type would be stronger but would mean every
 * repository signature carrying two parameters that are always the same object.
 */
export type TxToken = UnitOfWork;

/**
 * The only way into a transaction (`02` §3.7.1).
 *
 * `01` §1 and `CLAUDE.md` §2: nothing outside the one implementing module may call the driver's
 * own `transaction()`. That is enforced by a lint rule rather than left to review, because the
 * failure is silent — a raw `db.transaction()` with an `async` callback commits around nothing.
 */
export interface Store {
  /**
   * `BEGIN IMMEDIATE` … `COMMIT`. `fn` **must** be synchronous.
   *
   * Nested calls become savepoints, so a helper that opens a transaction composes inside a larger
   * one instead of either failing or silently committing early.
   */
  write<T>(fn: (uow: UnitOfWork) => NotPromise<T>, meta?: TxMeta): T;

  /**
   * `BEGIN DEFERRED` … `COMMIT`, for multi-statement reads that must agree with each other.
   *
   * Needed because a context build reads a dozen tables, and without a snapshot a message could
   * appear in one query and not the next — producing a reply that cites something it then claims
   * does not exist.
   */
  read<T>(fn: (scope: ReadScope) => NotPromise<T>, meta?: TxMeta): T;
}
