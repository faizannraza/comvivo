/**
 * `@google/genai` exception → `ModelCallError` (`05` §3.5.5; `M2-T13`).
 *
 * ## There is only one error class
 *
 * Measured against 3.0.0 on 2026-11-13: the SDK exports exactly **`ApiError`**, whose whole shape
 * is `{ message: string; status: number }`, plus an unrelated `ContinuationInterruptedError`. No
 * `RateLimitError`, no `AuthenticationError`, no connection or timeout classes, and **no headers**.
 *
 * Two consequences, both recorded in `05` §3.5.5 in the same commit:
 *
 *  1. The whole mapping is a **status table**. Where the other two adapters lead with `instanceof`
 *     and fall back to a status, this one has nothing to lead with.
 *  2. **`retryAfterMs` is never populated.** `ApiError` carries no headers, so a `retry-after` the
 *     server sent is not reachable from the thrown value. The middleware's backoff falls back to
 *     its own schedule, which is correct but less polite than honouring the server's number — and
 *     saying so here is better than a field that is silently always absent.
 *
 * An abort is `AbortSignal`'s own `DOMException`/`AbortError`, not an SDK class, so it is detected
 * by name. A fetch failure is a `TypeError` from undici, which is why "not an `ApiError`" cannot
 * simply mean `unknown`.
 */

import { ModelCallError, type ModelCallErrorKind } from '@comvivo/core';
import { ApiError } from '@google/genai';
import { GOOGLE_PROVIDER } from './response.js';

/**
 * HTTP status → kind.
 *
 * 429 is `rate_limited` and **not** `overloaded`: Google returns 429 both for quota and for
 * capacity, and the breaker must not open on either (`05` §3.5.3.10 — a breaker that opened on
 * rate limits turns a busy minute into a five-minute outage). 503 is the capacity signal.
 */
const BY_STATUS: Readonly<Record<number, ModelCallErrorKind>> = {
  400: 'bad_request',
  401: 'auth',
  403: 'permission',
  404: 'model_not_found',
  408: 'timeout',
  413: 'request_too_large',
  422: 'bad_request',
  429: 'rate_limited',
  499: 'aborted',
  500: 'server',
  502: 'server',
  503: 'overloaded',
  504: 'timeout',
};

/** 402 has no row above because Google bills through the project, not through a request status. */
const BILLING_STATUS = 402;

/** Whether a thrown value is an abort rather than a provider failure. */
function isAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // `AbortSignal` throws a `DOMException` named `AbortError`; some runtimes throw a plain `Error`
  // with the same name. Matching the name covers both without importing a DOM lib.
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

/**
 * Whether a thrown value is a transport failure.
 *
 * `undici` throws a `TypeError` with a `cause` for a connection failure, which is the shape a
 * `fetch`-based SDK surfaces. Without this, every network blip would map to `unknown` and the
 * circuit breaker — which counts `unknown` — would be driven by the wrong signal.
 */
function isNetwork(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'FetchError') return true;
  return error instanceof TypeError && 'cause' in error;
}

export function toModelCallError(error: unknown): ModelCallError {
  if (error instanceof ModelCallError) return error;
  if (isAbort(error)) {
    return new ModelCallError(
      error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'aborted',
      GOOGLE_PROVIDER,
    );
  }

  if (error instanceof ApiError) {
    const status = error.status;
    const kind = BY_STATUS[status] ?? (status === BILLING_STATUS ? 'billing' : fallbackFor(status));
    return new ModelCallError(kind, GOOGLE_PROVIDER, { status });
  }

  if (isNetwork(error)) return new ModelCallError('network', GOOGLE_PROVIDER);
  return new ModelCallError('unknown', GOOGLE_PROVIDER);
}

/**
 * A status the table does not name.
 *
 * Grouped by class rather than reported as `unknown`, because the breaker's decision depends on it:
 * any 5xx is a provider fault worth counting, and any other 4xx is our request being wrong and must
 * **not** count — a bad request retried is a bad request billed twice.
 */
function fallbackFor(status: number): ModelCallErrorKind {
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}
