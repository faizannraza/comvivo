/**
 * SDK exception → `ModelCallError` (`05` §3.5.3.10, §9.3; `M2-T6`).
 *
 * `05` §9.3 asks for "errors → kinds (each SDK class)", and the test that matters most is the
 * ordering one: four classes extend `InternalServerError` and `APIConnectionTimeoutError` extends
 * `APIConnectionError`, so a chain written base-first reports a timeout as a generic network
 * failure and a 529 as a plain 5xx. The breaker and the limiter treat those differently, so the
 * mistake is a wrong retry policy rather than a wrong label.
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  ContentTooLargeError,
  GatewayTimeoutError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PermissionDeniedError,
  RateLimitError,
  RequestTimeoutError,
  ServiceUnavailableError,
  UnprocessableEntityError,
} from '@anthropic-ai/sdk';
import { ModelCallError } from '@comvivo/core';
import { describe, expect, it } from 'vitest';
import { retryAfterMs, toModelCallError } from './errors.js';

const NOW = 1_767_225_600_000;

/** An SDK error of the given class, as its own factory would build it. */
function apiError(
  Ctor: new (status: never, error: never, message: string | undefined, headers: never) => APIError,
  status: number,
  body: unknown = { type: 'error', error: { type: 'api_error', message: 'boom' } },
  headers: Headers = new Headers(),
): APIError {
  return new Ctor(status as never, body as never, 'boom', headers as never);
}

describe('retryAfterMs', () => {
  it('reads a seconds value', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '3' }), NOW)).toBe(3000);
    expect(retryAfterMs(new Headers({ 'retry-after': '0' }), NOW)).toBe(0);
  });

  it('reads an HTTP-date, which the header also allows', () => {
    const at = new Date(NOW + 5000).toUTCString();
    expect(retryAfterMs(new Headers({ 'retry-after': at }), NOW)).toBeGreaterThanOrEqual(4000);
  });

  it('never returns a negative wait for a date in the past', () => {
    const at = new Date(NOW - 60_000).toUTCString();
    expect(retryAfterMs(new Headers({ 'retry-after': at }), NOW)).toBe(0);
  });

  it('is undefined for an absent, empty or unparseable value', () => {
    expect(retryAfterMs(undefined, NOW)).toBeUndefined();
    expect(retryAfterMs(new Headers(), NOW)).toBeUndefined();
    expect(retryAfterMs(new Headers({ 'retry-after': '  ' }), NOW)).toBeUndefined();
    // A zero wait on a rate limit is a hot loop, which is why this is `undefined` and not 0.
    expect(retryAfterMs(new Headers({ 'retry-after': 'soon' }), NOW)).toBeUndefined();
  });
});

describe('toModelCallError', () => {
  it('maps the non-HTTP failures, timeout before connection', () => {
    expect(toModelCallError(new APIUserAbortError(), NOW).kind).toBe('aborted');
    expect(toModelCallError(new APIConnectionTimeoutError({}), NOW).kind).toBe('timeout');
    expect(toModelCallError(new APIConnectionError({ message: 'x' }), NOW).kind).toBe('network');
  });

  it('maps each status class to its kind', () => {
    const cases: readonly [number, new (...args: never[]) => APIError, string][] = [
      [400, BadRequestError, 'bad_request'],
      [401, AuthenticationError, 'auth'],
      [403, PermissionDeniedError, 'permission'],
      [404, NotFoundError, 'model_not_found'],
      [408, RequestTimeoutError, 'timeout'],
      [413, ContentTooLargeError, 'request_too_large'],
      [422, UnprocessableEntityError, 'bad_request'],
      [429, RateLimitError, 'rate_limited'],
      [500, InternalServerError, 'server'],
      [503, ServiceUnavailableError, 'server'],
      [504, GatewayTimeoutError, 'server'],
      [529, OverloadedError, 'overloaded'],
    ];
    for (const [status, Ctor, kind] of cases) {
      expect(toModelCallError(apiError(Ctor as never, status), NOW).kind, String(status)).toBe(
        kind,
      );
    }
  });

  it('maps a 529 to overloaded and not to server, which the ordering decides', () => {
    // `OverloadedError extends InternalServerError`, so a base-first chain would say `server` and
    // the breaker would count a busy provider as a fault.
    const overloaded = toModelCallError(apiError(OverloadedError as never, 529), NOW);
    expect(overloaded.kind).toBe('overloaded');
    expect(overloaded.retryable).toBe(true);
  });

  it('maps 402 by status, since the SDK has no billing class', () => {
    expect(toModelCallError(apiError(APIError as never, 402), NOW).kind).toBe('billing');
  });

  it('maps an unrecognised status to unknown rather than guessing', () => {
    expect(toModelCallError(apiError(APIError as never, 418), NOW).kind).toBe('unknown');
  });

  it('maps a non-error value to unknown', () => {
    expect(toModelCallError('a string', NOW).kind).toBe('unknown');
    expect(toModelCallError(new Error('ours'), NOW).kind).toBe('unknown');
  });

  it('passes a ModelCallError through unchanged', () => {
    const original = new ModelCallError('rate_limited', 'anthropic');
    expect(toModelCallError(original, NOW)).toBe(original);
  });

  it('carries the status, the retry-after and the request id', () => {
    const headers = new Headers({ 'retry-after': '7', 'request-id': 'req_abc' });
    const error = apiError(
      RateLimitError as never,
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      headers,
    );
    const mapped = toModelCallError(error, NOW);
    expect(mapped.detail).toMatchObject({ status: 429, retryAfterMs: 7000 });
    expect(mapped.kind).toBe('rate_limited');
  });

  it('never interpolates the provider’s message, which has carried prompt fragments', () => {
    const error = apiError(BadRequestError as never, 400, {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'messages.0.content: the secret recipe' },
    });
    const mapped = toModelCallError(error, NOW);
    expect(mapped.message).toBe('bad_request');
    expect(JSON.stringify(mapped.detail)).not.toContain('secret recipe');
  });

  it('reports retryability per 05 §3.5.3.10', () => {
    const retryable = ['rate_limited', 'overloaded', 'server', 'timeout', 'network'];
    const final = ['auth', 'permission', 'billing', 'model_not_found', 'bad_request', 'aborted'];
    for (const kind of retryable) {
      expect(new ModelCallError(kind as never, 'anthropic').retryable, kind).toBe(true);
    }
    for (const kind of final) {
      expect(new ModelCallError(kind as never, 'anthropic').retryable, kind).toBe(false);
    }
  });
});
