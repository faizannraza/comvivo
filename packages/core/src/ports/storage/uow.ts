/**
 * The transaction primitives a repository port needs (`02` §3.7.1).
 *
 * ## Why this module exists
 *
 * `store.ts` declares `ReadScope` and `UnitOfWork`, which name every repository interface. The
 * repository ports in turn need `TxToken` and `WriteResult`. Declaring all of it in one module
 * made `store.ts -> repos/membership.ts -> store.ts` — a cycle dependency-cruiser refuses, and is
 * right to: "a cycle between modules means the boundary between them is not real. Extract the
 * shared part instead of importing backwards." This is the shared part.
 *
 * ## The narrowing that came with it
 *
 * `02` §3.7.1 says "`TxToken` is the `UnitOfWork` itself", and at every call site it still is —
 * `UnitOfWork` extends `TxToken`, so passing one where a token is expected typechecks. What
 * changed is the **declared** type of a repository's first parameter: the token is now the
 * transaction's own facts (`now`, `afterCommit`) rather than the whole set of repositories.
 *
 * That is strictly better, and worth stating rather than leaving to be discovered: with the full
 * `UnitOfWork` as the token, any repository could reach any other through its own argument — a
 * back door around the explicit constructor dependencies that make the wiring reviewable.
 * `SqliteMemberRepository` takes `Pick<GroupRepository, 'bumpMembershipEpoch'>` precisely so its
 * one cross-aggregate write is visible in its signature; a token carrying `groupsW` would have
 * made that ceremony pointless.
 */
import type { Temporal } from 'temporal-polyfill';

/**
 * `never` for anything promise-like, so an `async` callback is a compile error.
 *
 * `PromiseLike` rather than `Promise`: a thenable from another library, or a `Promise` from a
 * different realm, is just as fatal here and does not pass an `instanceof Promise` check either.
 */
export type NotPromise<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * A synchronous transaction runner, handed to something that must not hold a transaction itself.
 *
 * A **named** alias rather than the signature written out at each use, and the reason is a
 * TypeScript limitation worth recording: comparing two structurally identical *generic* signatures
 * whose return type is a deferred conditional makes the compiler check `T` against
 * `NotPromise<T>` contravariantly and refuse the assignment (`TS2328`) — even for two declarations
 * that are character for character the same. Naming the type makes the comparison an identity
 * check, which succeeds.
 *
 * That is not a detail: `BlobPutArgs.write` had the constraint **erased** to
 * `(fn: (uow: TxToken) => T) => T` precisely because the honest signature would not compose, and
 * with it went the only thing stopping an `async` callback from holding a write lock across an
 * `await` at that boundary (`C1`). Found by the M1 exit gate's reviewer.
 */
export type SyncTxRunner = <T>(fn: (uow: TxToken) => NotPromise<T>) => T;

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
 * The transaction-stable clock reading every scope carries.
 *
 * One reading per transaction, so every row a logical change writes carries the same instant and
 * every query in one read agrees about the present. A clock read per row would let `createdAt`
 * orderings disagree with the transaction's own atomicity, and the turn journal and outbox read
 * timestamps as sequence (I6, I7).
 */
export interface TxClock {
  readonly now: Temporal.Instant;
}

/**
 * The token repositories take, making "this needs a transaction" visible in the signature.
 *
 * `UnitOfWork` in `store.ts` extends this, so `02` §3.7.1's "`TxToken` is the `UnitOfWork` itself"
 * still holds at every call site. See the module header for why the declared type is narrower.
 */
export interface TxToken extends TxClock {
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
