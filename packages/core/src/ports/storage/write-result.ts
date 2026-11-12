/**
 * Constructors for `02` §3.7.1's `WriteResult`.
 *
 * The **type** lives in `uow.ts`, with the other transaction primitives, spelled exactly as
 * `02` §3.7.1 spells it. This module adds only the four constructors and one test helper, because
 * a repository writes these literals on every path and `{ kind: 'not_found' }` is one typo away
 * from a value that typechecks as `{ kind: string }` in the wrong place.
 *
 * A first version of this module declared its own `WriteResult` with a `currentVersion` on the
 * `conflict` arm, which was a mistake worth recording: a caller handling a conflict has to re-read
 * the row to decide what to do — the version alone would let it merge blindly, which is the thing
 * optimistic concurrency exists to prevent — and a re-read returns the version with the state. The
 * field would have been a shortcut to the one behaviour the union is designed to discourage.
 */
import type { WriteResult } from './uow.js';

/** A write that landed. `value` is the row as it now stands, not the patch that was applied. */
export function writeOk<T>(value: T): WriteResult<T> {
  return { kind: 'ok', value };
}

/**
 * A write refused because `expectVersion` did not match.
 *
 * The caller's right response is to re-read and decide again, which is a different act from a
 * retry: the row changed, so the decision that produced this write may no longer be the one to
 * make.
 */
export function writeConflict<T>(): WriteResult<T> {
  return { kind: 'conflict' };
}

/**
 * A write whose target is absent **or** outside the caller's group.
 *
 * One answer for two situations, deliberately. `I4` (group isolation) means a caller must not be
 * able to tell "no such row" from "that row belongs to another group" — the second answer confirms
 * the existence of a row in a group the caller cannot see, which is the information `I4` withholds.
 * Every repository scopes its `WHERE` on `group_id` and returns this for both.
 */
export function notFound<T>(): WriteResult<T> {
  return { kind: 'not_found' };
}

/** A write refused because `existingId` already holds this value (a dedupe or idempotency index). */
export function duplicate<T>(existingId: string): WriteResult<T> {
  return { kind: 'duplicate', existingId };
}

/**
 * Narrow a `WriteResult` to its value, throwing on anything else.
 *
 * For **tests and seed paths only**, where a refusal means the fixture is wrong and the useful
 * behaviour is a loud stack trace. Production callers branch on `kind`: that is the entire reason
 * the union exists, and a helper that collapses it is a way to lose the distinction by habit.
 *
 * Not named `unwrap`: `unwrapOr` in `@comvivo/shared` works on `Result` and reads as routine, while
 * this one is an assertion about the caller's assumptions.
 */
export function expectWritten<T>(result: WriteResult<T>, what: string): T {
  if (result.kind === 'ok') return result.value;
  const existing = result.kind === 'duplicate' ? ` (existing ${result.existingId})` : '';
  throw new Error(`expected ${what} to be written, got ${result.kind}${existing}`);
}
