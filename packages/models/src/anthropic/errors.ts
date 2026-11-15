/**
 * SDK exception → `ModelCallError` (`05` §3.5.3.10; `M2-T6`).
 *
 * `14` assigns `errors.ts` to `M2-T9`. It lands here because `run()` cannot satisfy the port
 * without it: `ModelGateway.run` is documented to reject with a `ModelCallError`, and an adapter
 * that let a raw `Anthropic.APIError` escape would make every caller above it reach into somebody
 * else's SDK to decide whether to retry. `M2-T9` keeps the **middleware** — the priority limiter,
 * the circuit breaker, the usage and trace hooks — which is the substance of that task. Logged as
 * a plan change.
 *
 * ## Order is load-bearing
 *
 * `instanceof` against a class hierarchy matches the *first* arm that fits, so the specific classes
 * have to come first: `APIConnectionTimeoutError extends APIConnectionError`, and
 * `OverloadedError`, `ServiceUnavailableError`, `GatewayTimeoutError` and `NotImplementedError` all
 * extend `InternalServerError`. Checking the base class first would report a timeout as a generic
 * network failure and an overload as a plain 5xx — and the breaker treats those differently.
 *
 * ## One correction to `05` §3.5.3.10
 *
 * The spec maps 529 as "`InternalServerError` with `.type === 'overloaded_error'`", which is a
 * string match on an error body. `@anthropic-ai/sdk` 1.7.0 has a dedicated
 * **`OverloadedError`** class with `readonly status: 529`, and its error factory maps 529 to it —
 * so the typed class replaces the string match, which is what the SDK's own guidance asks for.
 * 413 gains a class too (`ContentTooLargeError`); 402 still has none, so billing stays a status
 * check on `APIError`.
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ContentTooLargeError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
  RequestTimeoutError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk';
import { ModelCallError, type ModelCallErrorKind } from '@comvivo/core';
import { ANTHROPIC_PROVIDER } from './response.js';

/** `02` §3.3.7's billing status, which the SDK has no class for. */
const BILLING_STATUS = 402;

/** How long to wait, from a `retry-after` header in seconds or an HTTP-date. */
export function retryAfterMs(headers: Headers | undefined, nowMs: number): number | undefined {
  const raw = headers?.get('retry-after');
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  // An HTTP-date is legal in `retry-after` and the SDKs honour it. `Date.parse` rather than a
  // `Date` constructor so an unparseable value is `NaN` instead of an Invalid Date that silently
  // becomes 0 ms — a zero wait on a rate limit is a hot loop.
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/**
 * The four fields a `ModelCallError` needs, read defensively.
 *
 * Takes `unknown`, not `APIError`. `instanceof APIError` narrows the class's three type parameters
 * to `any`, and `no-unsafe-argument` is right to refuse letting an `any` cross a function boundary
 * — typing the parameter as `APIError` would have accepted the `any` and re-exported the problem.
 * A `typeof` guard per field turns each one back into a real type at the only place that knows what
 * it should be, and the fields are the same four whatever the generics say.
 *
 * `error.type` is read from the SDK's own first-class field rather than dug out of `error.error`:
 * 1.7.0 parses `error.type`, `error.errorCode` and `error.details` off the response body, and its
 * own doc comment says to branch on those rather than on the message.
 */
function apiErrorFields(error: unknown): {
  readonly status: number | undefined;
  readonly headers: Headers | undefined;
  readonly type: string | undefined;
  readonly requestId: string | undefined;
} {
  const raw: unknown = error;
  const fields = raw as Record<string, unknown>;
  const status = typeof fields['status'] === 'number' ? fields['status'] : undefined;
  const headers = fields['headers'] instanceof Headers ? fields['headers'] : undefined;
  // `errorCode` is the stable, machine-readable name when the body carries one; `type` is the
  // broad category. Prefer the specific, fall back to the category, so `detail.type` is the most
  // precise thing the provider said.
  const code = typeof fields['errorCode'] === 'string' ? fields['errorCode'] : undefined;
  const category = typeof fields['type'] === 'string' ? fields['type'] : undefined;
  const requestId = typeof fields['requestID'] === 'string' ? fields['requestID'] : undefined;
  return { status, headers, type: code ?? category, requestId };
}

/**
 * Map any thrown value to a `ModelCallError`.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so an HTTP-date `retry-after` is testable:
 * the whole point of the header is a wait relative to now, and a test that cannot choose "now"
 * cannot assert the arithmetic.
 */
export function toModelCallError(error: unknown, nowMs: number): ModelCallError {
  if (error instanceof ModelCallError) return error;

  // Not an `APIError` at all: an abort, a connection failure, or something from our own code.
  // Order matters — `APIConnectionTimeoutError extends APIConnectionError`.
  if (error instanceof APIUserAbortError) {
    return new ModelCallError('aborted', ANTHROPIC_PROVIDER);
  }
  if (error instanceof APIConnectionTimeoutError) {
    return new ModelCallError('timeout', ANTHROPIC_PROVIDER);
  }
  if (error instanceof APIConnectionError) {
    return new ModelCallError('network', ANTHROPIC_PROVIDER);
  }
  if (!(error instanceof APIError)) {
    return new ModelCallError('unknown', ANTHROPIC_PROVIDER);
  }

  const { status, headers, type, requestId } = apiErrorFields(error);
  const wait = retryAfterMs(headers, nowMs);
  return new ModelCallError(errorKind(error, status), ANTHROPIC_PROVIDER, {
    ...(status === undefined ? {} : { status }),
    ...(type === undefined ? {} : { type }),
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    ...(requestId === undefined ? {} : { requestId }),
  });
}

/** The `instanceof` chain, most specific first (`05` §3.5.3.10's table). */
function errorKind(error: unknown, status: number | undefined): ModelCallErrorKind {
  if (error instanceof RateLimitError) return 'rate_limited';
  if (error instanceof AuthenticationError) return 'auth';
  if (error instanceof PermissionDeniedError) return 'permission';
  if (error instanceof NotFoundError) return 'model_not_found';
  if (error instanceof ContentTooLargeError) return 'request_too_large';
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
    return 'bad_request';
  }
  if (error instanceof RequestTimeoutError) return 'timeout';
  // Before `InternalServerError`: `OverloadedError` extends it, and the breaker treats a 529 as
  // back-pressure from a busy provider rather than as a server fault.
  if (error instanceof OverloadedError) return 'overloaded';
  if (error instanceof InternalServerError) return 'server';
  if (status === BILLING_STATUS) return 'billing';
  return 'unknown';
}
