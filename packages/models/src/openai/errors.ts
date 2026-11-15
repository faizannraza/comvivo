/**
 * OpenAI SDK exception → `ModelCallError` (`05` §3.5.4; `M2-T11`).
 *
 * `05` §3.5.4 says the `openai` SDK "uses the same class family … and maps to the same kinds".
 * Mostly true, and the differences are what this file is for. Measured against openai 7.55.0 on
 * 2026-11-13:
 *
 *  - There is **no `RequestTimeoutError`**. A client-side timeout surfaces as
 *    `APIConnectionTimeoutError`, which extends `APIConnectionError` — so the order below matters
 *    for the same reason it does on Anthropic.
 *  - There is **no overload class**. Anthropic has `OverloadedError` with `status: 529`; OpenAI
 *    returns 503 through the generic `InternalServerError`, whose `TStatus` is plain `number`. So
 *    overload is a **status check**, not an `instanceof`, and getting it wrong matters: the circuit
 *    breaker counts a server fault and treats back-pressure differently.
 *  - There is no 413 class either, so `request_too_large` is a status check too.
 *  - `ConflictError` (409) and `UnprocessableEntityError` (422) exist and both mean the request was
 *    wrong, not that the provider failed.
 *  - `LengthFinishReasonError` and `ContentFilterFinishReasonError` extend `OpenAIError`, **not**
 *    `APIError` — they are raised by the SDK's parsing helpers rather than by the transport. They
 *    are mapped explicitly, because falling through to `unknown` would make a truncated structured
 *    output look like a provider outage and trip the breaker.
 */
import { ModelCallError, type ModelCallErrorKind, type ProviderId } from '@comvivo/core';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  UnprocessableEntityError,
} from 'openai';
// Not re-exported from the package root — `openai`'s `index.d.ts` lists sixteen error classes and
// these two are not among them, because they are raised by the parsing helpers rather than by the
// transport. The `./error` subpath is the package's own documented home for the full set.
import { ContentFilterFinishReasonError, LengthFinishReasonError } from 'openai/error';
import { retryAfterMs } from '../anthropic/errors.js';
import { OPENAI_PROVIDER } from './response.js';

/** Statuses with no SDK class of their own. */
const STATUS = { billing: 402, tooLarge: 413, overloaded: 503 } as const;

/**
 * The fields a `ModelCallError` needs, read defensively.
 *
 * Same shape as the Anthropic reader and for the same reason: `instanceof APIError` narrows the
 * class's three type parameters to `any`, and letting an `any` cross a function boundary is what
 * `no-unsafe-argument` exists to stop. Reading through a `Record<string, unknown>` view with
 * `typeof` guards turns each field back into a real type at the one place that knows what it is.
 *
 * `requestID` is the SDK's spelling on both providers — capital `ID` — which is the kind of detail
 * that silently returns `undefined` forever if you guess `requestId`.
 */
function apiErrorFields(error: unknown): {
  readonly status: number | undefined;
  readonly headers: Headers | undefined;
  readonly type: string | undefined;
  readonly requestId: string | undefined;
} {
  const fields = error as Record<string, unknown>;
  const status = typeof fields['status'] === 'number' ? fields['status'] : undefined;
  const headers = fields['headers'] instanceof Headers ? fields['headers'] : undefined;
  const code = typeof fields['code'] === 'string' ? fields['code'] : undefined;
  const category = typeof fields['type'] === 'string' ? fields['type'] : undefined;
  const requestId = typeof fields['requestID'] === 'string' ? fields['requestID'] : undefined;
  return { status, headers, type: code ?? category, requestId };
}

/**
 * Map any thrown value to a `ModelCallError`.
 *
 * `provider` is a **parameter**, defaulting to `openai`. It has to be: the OpenAI-compatible local
 * adapter (`M2-T12`) reuses this mapper because it uses the same SDK, and a hard-coded `'openai'`
 * attributed every local-server failure to OpenAI. That is wrong in three places at once — the
 * trace, the log line and, worst, the **circuit-breaker registry**, which is keyed by provider: a
 * local Ollama going down would have opened the *OpenAI* circuit and refused cloud calls that were
 * perfectly healthy. Found by `M2-T14`'s shared contract suite, which asserts the provider on
 * every adapter's errors and is the only test that compares the four.
 */
export function toModelCallError(
  error: unknown,
  nowMs: number,
  provider: ProviderId = OPENAI_PROVIDER,
): ModelCallError {
  if (error instanceof ModelCallError) return error;

  // Most specific first: `APIConnectionTimeoutError extends APIConnectionError`.
  if (error instanceof APIUserAbortError) return new ModelCallError('aborted', provider);
  if (error instanceof APIConnectionTimeoutError) {
    return new ModelCallError('timeout', provider);
  }
  if (error instanceof APIConnectionError) return new ModelCallError('network', provider);

  // Raised by the SDK's parsing helpers, not by the transport, so they are not `APIError`s. A
  // truncated structured output reported as `unknown` would trip the breaker on a healthy provider.
  if (error instanceof LengthFinishReasonError) {
    return new ModelCallError('bad_request', provider, { type: 'length' });
  }
  if (error instanceof ContentFilterFinishReasonError) {
    return new ModelCallError('bad_request', provider, { type: 'content_filter' });
  }

  if (!(error instanceof APIError)) return new ModelCallError('unknown', provider);

  const { status, headers, type, requestId } = apiErrorFields(error);
  const wait = retryAfterMs(headers, nowMs);
  return new ModelCallError(errorKind(error, status), provider, {
    ...(status === undefined ? {} : { status }),
    ...(type === undefined ? {} : { type }),
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
    ...(requestId === undefined ? {} : { requestId }),
  });
}

/** The `instanceof` chain, most specific first, with the three status-only kinds after it. */
function errorKind(error: unknown, status: number | undefined): ModelCallErrorKind {
  if (error instanceof RateLimitError) return 'rate_limited';
  if (error instanceof AuthenticationError) return 'auth';
  if (error instanceof PermissionDeniedError) return 'permission';
  if (error instanceof NotFoundError) return 'model_not_found';
  if (status === STATUS.tooLarge) return 'request_too_large';
  if (status === STATUS.billing) return 'billing';
  if (
    error instanceof BadRequestError ||
    error instanceof UnprocessableEntityError ||
    error instanceof ConflictError
  ) {
    return 'bad_request';
  }
  // Before `InternalServerError`, which 503 is an instance of. The breaker counts a server fault
  // and treats back-pressure from a busy provider differently.
  if (status === STATUS.overloaded) return 'overloaded';
  if (error instanceof InternalServerError) return 'server';
  return 'unknown';
}
