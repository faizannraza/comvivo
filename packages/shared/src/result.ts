/**
 * `Result<T, E>` — the return type for anything that can fail for an expected reason.
 *
 * ADR-010: *"Domain decisions return discriminated unions; only bugs and infrastructure failures
 * throw."* That split is deliberate and load-bearing. "This member may not delete that event" is
 * not an exception — it is one of the answers the policy engine exists to give, and it must be
 * impossible to forget to handle. Throwing it would make the one case that matters most for
 * invariant **I3** the easiest one to swallow with a bare `catch`.
 *
 * So: a `Result` for every expected failure, a thrown typed error for a genuine fault (a disk that
 * will not write, a provider that is down) and a `BugError` for a broken invariant.
 */

/** A successful outcome. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** An expected failure, carrying a typed reason rather than a string. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(result: Result<T, E>): result is Ok<T> => result.ok;
export const isErr = <T, E>(result: Result<T, E>): result is Err<E> => !result.ok;

/** Transform the value, leaving a failure untouched. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Transform the error, leaving a success untouched. Use it to add context as a result travels up. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Chain another fallible step. The first failure short-circuits. */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/** The value, or a fallback. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/**
 * Collect many results into one. Returns **every** error rather than only the first, because a
 * host fixing a broken config file wants the whole list, not one round trip per mistake.
 */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E[]> {
  const values: T[] = [];
  const errors: E[] = [];
  for (const result of results) {
    if (result.ok) values.push(result.value);
    else errors.push(result.error);
  }
  return errors.length === 0 ? ok(values) : err(errors);
}
