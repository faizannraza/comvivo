/**
 * `ToolOutcome` and `ToolErrorCode` (`10` §3.2.3), plus their constructors.
 *
 * These are **public SDK types and the built-ins use the same ones** — that sentence in the spec is
 * the whole design. There is one way for a tool to say "done", "that did not work" and "I need to
 * ask", whether the tool ships in this repository or in somebody's weekend project, so `05` has one
 * mapping from an outcome to a `tool_result` block instead of one per provider.
 *
 * ## Why three kinds and not an exception
 *
 * A thrown error is a bug. A `kind: 'error'` outcome is a *result*: the calendar was unreachable,
 * the id was not found, the policy said no. The model needs to read the second kind and decide what
 * to do next, which it cannot do with a stack trace — and the host needs to know whether retrying
 * is sensible, which is what `retryable` is for.
 *
 * `needs_input` is the third because the alternative is a tool that guesses. "Add it to the list"
 * with three lists called *groceries*, *costco* and *target* is a question, and a tool that picks
 * one is a tool the group stops trusting.
 */
import type { RichText } from '@comvivo/core';

/** `10` §3.2.3's error codes, in that order. */
export const TOOL_ERROR_CODES = [
  'invalid_input',
  'not_found',
  'unavailable',
  'rate_limited',
  'timeout',
  'permission_denied',
  'policy_denied',
  'upstream_error',
  'internal',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export interface ToolOk<O> {
  readonly kind: 'ok';
  readonly output: O;
  /** A preformatted rendering hint. `05` may ignore it; it never replaces the model's reply. */
  readonly display?: RichText;
}

export interface ToolFailure {
  readonly kind: 'error';
  readonly code: ToolErrorCode;
  /** Model-facing and member-facing. Say what failed and what would fix it; never a stack trace. */
  readonly message: string;
  readonly retryable: boolean;
}

export interface ToolNeedsInput {
  readonly kind: 'needs_input';
  readonly question: string;
  readonly choices?: readonly string[];
}

/**
 * The three arms are named interfaces rather than inline members of the union, so the constructors
 * can return the arm they build.
 *
 * `toolError(...).retryable` has to be readable: a tool that wraps another tool's failure needs to
 * see the code and the retryability it is passing on, and a bare `ToolOutcome<O>` would make it
 * narrow a union it just constructed.
 */
export type ToolOutcome<O> = ToolOk<O> | ToolFailure | ToolNeedsInput;

/**
 * Whether each code is worth retrying, unless the tool says otherwise.
 *
 * A total `Record`, so adding a code is a compile error here rather than a silently non-retryable
 * failure in production. The four `true`s are the transient ones: a rate limit, a timeout, an
 * upstream wobble and a service that is down come back. The five `false`s do not — retrying an
 * `invalid_input` sends the same bad arguments again, and retrying a `policy_denied` asks the group
 * the same question it already answered.
 */
export const RETRYABLE_BY_DEFAULT: Readonly<Record<ToolErrorCode, boolean>> = {
  invalid_input: false,
  not_found: false,
  unavailable: true,
  rate_limited: true,
  timeout: true,
  permission_denied: false,
  policy_denied: false,
  upstream_error: true,
  internal: false,
};

export interface ToolErrorOptions {
  /** Overrides `RETRYABLE_BY_DEFAULT[code]`. Set it when the tool knows better than the code does. */
  readonly retryable?: boolean;
}

/**
 * A successful call.
 *
 * Named `toolOk` rather than `ok` on purpose: `@comvivo/shared` exports an `ok` for `Result`, and
 * the built-in tools import both packages. One `ok` winning an import collision in a tool module
 * would be a type error at best and the wrong constructor at worst.
 */
export function toolOk<O>(output: O, display?: RichText): ToolOk<O> {
  // Spread rather than `display`, because `exactOptionalPropertyTypes` makes an explicit
  // `display: undefined` a different thing from an absent key — and the absent key is what
  // `05` serialises.
  return { kind: 'ok', output, ...(display === undefined ? {} : { display }) };
}

/** A failed call. `retryable` follows `RETRYABLE_BY_DEFAULT` unless the tool overrides it. */
export function toolError(
  code: ToolErrorCode,
  message: string,
  options: ToolErrorOptions = {},
): ToolFailure {
  return {
    kind: 'error',
    code,
    message,
    retryable: options.retryable ?? RETRYABLE_BY_DEFAULT[code],
  };
}

/** A question for the requester. `choices` renders as buttons where the channel supports them. */
export function toolNeedsInput(question: string, choices?: readonly string[]): ToolNeedsInput {
  return { kind: 'needs_input', question, ...(choices === undefined ? {} : { choices }) };
}

export function isToolOk<O>(outcome: ToolOutcome<O>): outcome is ToolOk<O> {
  return outcome.kind === 'ok';
}

export function isToolError<O>(outcome: ToolOutcome<O>): outcome is ToolFailure {
  return outcome.kind === 'error';
}

export function isToolNeedsInput<O>(outcome: ToolOutcome<O>): outcome is ToolNeedsInput {
  return outcome.kind === 'needs_input';
}
