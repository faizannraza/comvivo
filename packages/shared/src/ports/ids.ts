/**
 * The `IdGenerator` port.
 *
 * ADR-019: **TypeID** — a type prefix plus a UUIDv7 in Crockford base32, so an id is readable in a
 * log (`grp_01jd8…`), sortable by creation time, and impossible to mistake for another entity's.
 *
 * Why this matters more here than in most products: the single worst bug this codebase can have is
 * operating on the wrong group or the wrong member, because that is invariant **I4 (group
 * isolation)** or **I3 (requester authority)** failing silently. A `MemberId` that cannot be passed
 * where a `GroupId` belongs turns a whole class of leak into a compile error.
 *
 * The registry, the brand and the parser live in `../ids.ts` (`02` §3.1), which is pure and
 * importable from anywhere. This file is only the port, so `core` can take a generator without
 * taking a way to make one.
 *
 * Implementations: `TypeIdGenerator` (`id-generator.ts`) and `DeterministicIdGenerator`
 * (`testing/deterministic-ids.ts`).
 */
import type { Id, IdPrefix } from '../ids.js';

export interface IdGenerator {
  /**
   * A fresh id for the given prefix.
   *
   * Monotonic within a millisecond, so ids sort by creation order even when two are made in the
   * same tick — which matters for the turn journal and the outbox, where order *is* the semantics
   * (`01` §6.2, invariants I6 and I7).
   *
   * The returned id is branded with the **prefix**, so `next('grp')` cannot be assigned where a
   * `MemberId` is wanted. An earlier shape took the brand as a separate argument, which meant
   * `generate('grp', 'member')` typechecked and produced a group id branded as a member — exactly
   * the confusion the branding exists to prevent. Renamed to `next` to match `02` §3.1.
   */
  next<P extends IdPrefix>(prefix: P): Id<P>;
}
