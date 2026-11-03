/**
 * The `IdGenerator` port, and the branding that keeps ids apart.
 *
 * ADR-019: **TypeID** — a type prefix plus a UUIDv7 in Crockford base32, so an id is readable in a
 * log (`grp_01j8…`), sortable by creation time, and impossible to mistake for another entity's.
 *
 * Why this matters more here than in most products: the single worst bug this codebase can have is
 * operating on the wrong group or the wrong member, because that is invariant **I4 (group
 * isolation)** or **I3 (requester authority)** failing silently. A `MemberId` that cannot be passed
 * where a `GroupId` belongs turns a whole class of leak into a compile error.
 *
 * Generation is injected so ids are deterministic in tests (`DeterministicIdGenerator`, `M0-T7`).
 * `core` cannot call `crypto.randomUUID()` — it has no `node:*` and no randomness of its own.
 *
 * Implementations: `TypeIdGenerator` in `M1-T3`, `DeterministicIdGenerator` in `M0-T7`.
 * The authoritative prefix registry is `02` §3.3.13, wired up in `M1-T3`.
 */
import type { Branded } from '../zod.js';

/** An id's type prefix, e.g. `grp`, `mbr`, `mem`. Lowercase, 1–63 chars (TypeID spec). */
export type IdPrefix = string;

/** A TypeID for entity type `B`. */
export type TypedId<B extends string> = Branded<string, B>;

export interface IdGenerator {
  /**
   * A fresh id for the given prefix.
   *
   * Monotonic within a millisecond, so ids sort by creation order even when two are made in the
   * same tick — which matters for the turn journal and the outbox, where order *is* the semantics.
   */
  generate<B extends string>(prefix: IdPrefix, brand?: B): TypedId<B>;
}
