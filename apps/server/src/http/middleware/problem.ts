/**
 * `09` §3.2.1's problem+json, as the one place an error becomes a response (`M3-T14`).
 *
 * Two entry points, and both have to exist or the shape is only half true:
 *
 *  - **`onError`** catches whatever a handler threw;
 *  - **`defaultHook`** catches a zod validation failure, which `@hono/zod-openapi` reports *without*
 *    throwing — it calls the hook with a result object, and a route that forgot to look would
 *    return `200` with an unvalidated body.
 *
 * ## Why the code table is a `Record` and not a `switch`
 *
 * `09` §3.2.1 lists twenty codes with an HTTP status each, and the status is what a client branches
 * on. A `switch` with a `default` is a list that silently stops matching the type it switches on;
 * a total `Record` makes a new code a compile error here, which is the one place that has to
 * decide what it means over the wire.
 *
 * ## What never reaches a client
 *
 * No stack trace, no `cause` chain, no SQL. `09` §3.2.1 is explicit for `internal`: "No stack
 * trace; the error is logged with `requestId`". That is the whole contract — the `requestId` in the
 * body is what ties the sentence a host reads to the line in the log that has the detail, and it is
 * why `request-id.ts` runs first in the chain.
 */
import {
  AppError,
  BRAND,
  type LoggedError,
  type Logger,
  StorageError,
  toLoggedError,
} from '@comvivo/shared';
import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

/** `09` §3.2.1's codes, plus `not_ready` — see `STATUS` below. */
export const PROBLEM_CODES = [
  'validation_failed',
  'unauthenticated',
  'token_invalid',
  'csrf_failed',
  'step_up_required',
  'forbidden',
  'policy_denied',
  'not_found',
  'conflict',
  'setup_required',
  'already_claimed',
  'precondition_failed',
  'payload_too_large',
  'unsupported_media_type',
  'etag_required',
  'rate_limited',
  'internal',
  'actor_busy',
  'server_draining',
  'not_ready',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/**
 * The HTTP status for each code (`09` §3.2.1's second column).
 *
 * `not_ready` is the twentieth and is **not** in §3.2.1's table: `09` §3.8 says `/readyz` "returns
 * a problem with failing check IDs only" and names no code for it. Added here rather than reusing
 * `internal`, because a 503 from `/readyz` is the ordinary answer during boot and reporting it as a
 * bug would make every cold start look like a crash. Recorded in `STATUS.md` → Plan changes.
 */
const STATUS: Readonly<Record<ProblemCode, number>> = {
  validation_failed: 400,
  unauthenticated: 401,
  token_invalid: 401,
  csrf_failed: 403,
  step_up_required: 403,
  forbidden: 403,
  policy_denied: 403,
  not_found: 404,
  conflict: 409,
  setup_required: 409,
  already_claimed: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  etag_required: 428,
  rate_limited: 429,
  internal: 500,
  actor_busy: 503,
  server_draining: 503,
  not_ready: 503,
};

/** The human title for each code. English, per `09` §3.2's locale rule. */
const TITLE: Readonly<Record<ProblemCode, string>> = {
  validation_failed: 'Validation failed',
  unauthenticated: 'Not signed in',
  token_invalid: 'That link or code cannot be used',
  csrf_failed: 'Request blocked',
  step_up_required: 'Confirm it is you',
  forbidden: 'Not allowed',
  policy_denied: 'Not allowed here',
  not_found: 'Not found',
  conflict: 'That has already changed',
  setup_required: 'Setup is not finished',
  already_claimed: 'Already set up',
  precondition_failed: 'That changed while you were editing',
  payload_too_large: 'Too large',
  unsupported_media_type: 'Send JSON',
  etag_required: 'Send the version you are editing',
  rate_limited: 'Too many requests',
  internal: 'Something went wrong',
  actor_busy: 'Busy',
  server_draining: 'Shutting down',
  not_ready: 'Not ready yet',
};

/** One field-level error (`09` §3.2.1's `errors[]`). */
export interface ProblemFieldError {
  readonly pointer: string;
  readonly code: string;
  readonly message: string;
}

/**
 * `09` §3.2.1's body. `type` is a URN so a client can branch without parsing prose.
 *
 * The per-code extra members — `09` §3.2.1's last column: `login`, `stepUp`, `reason`,
 * `userMessage`, `current`, `retryAfter`, a readiness failure's `failing` — are **top-level**
 * members, not a nested object. That is RFC 9457 §3.2's extension-member rule and it is what
 * §3.2.1's example shows; a client reads `problem.retryAfter`, and nesting them under an `extra`
 * key would have made every one of those columns unreachable at the name the spec gives it.
 */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: ProblemCode;
  readonly requestId: string;
  readonly errors?: readonly ProblemFieldError[];
  /** RFC 9457 extension members. An index signature because the set is per-code. */
  readonly [member: string]: unknown;
}

/**
 * An error a handler throws to produce a specific problem.
 *
 * Carries the **code** rather than the status, because the code is the stable half: `09` §3.2 says
 * "the dashboard localizes by `code`", so a handler that chose a status would be choosing the thing
 * clients do not read and leaving the thing they do to a mapping somewhere else.
 */
export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly errors: readonly ProblemFieldError[] | undefined;
  readonly extra: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ProblemCode,
    detail: string,
    options: {
      readonly errors?: readonly ProblemFieldError[];
      readonly extra?: Readonly<Record<string, unknown>>;
      readonly cause?: unknown;
    } = {},
  ) {
    super(detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProblemError';
    this.code = code;
    this.errors = options.errors;
    this.extra = options.extra;
  }
}

/** `urn:comvivo:problem:<code>`. Derived from `BRAND`, so a rename stays one command. */
export function problemType(code: ProblemCode): string {
  return `urn:${BRAND.slug}:problem:${code}`;
}

export function problemStatus(code: ProblemCode): number {
  return STATUS[code];
}

export function problemTitle(code: ProblemCode): string {
  return TITLE[code];
}

/** Build the body (`09` §3.2.1). `instance` is the path plus the request id, as the spec shows. */
export function toProblem(
  code: ProblemCode,
  detail: string,
  context: { readonly path: string; readonly requestId: string },
  options: {
    readonly errors?: readonly ProblemFieldError[];
    readonly extra?: Readonly<Record<string, unknown>>;
  } = {},
): Problem {
  return {
    // The extension members go **first**, so the standard members below always win. A caller that
    // passed `status` or `code` in `extra` cannot change the response's status or the code a client
    // branches on — and the guarantee is structural rather than a filter that could be wrong.
    //
    // Dropped silently rather than rejected, because this function is on the failure path: a throw
    // here turns a reported failure into no response at all, which is strictly worse than a
    // problem missing one member. `app.test.ts` asserts the shadowing attempt is a no-op.
    ...options.extra,
    type: problemType(code),
    title: TITLE[code],
    status: STATUS[code],
    detail,
    instance: `${context.path}#${context.requestId}`,
    code,
    requestId: context.requestId,
    ...(options.errors === undefined ? {} : { errors: options.errors }),
  };
}

/** `09` §3.2.1's media type. Not `application/json`: a client distinguishes them. */
export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

/** The request id `request-id.ts` put on the context, or a marker if it somehow did not. */
export function requestIdOf(c: Context): string {
  const id = c.get('requestId');
  // `request-id.ts` runs first in `09` §3.1's chain, so this is unreachable in the composed app.
  // A marker rather than a thrown error: the one thing worse than a problem with no request id is
  // no problem at all, on the path whose job is to report a failure.
  return typeof id === 'string' && id !== '' ? id : 'unknown';
}

/**
 * The only sentence an unrecognised failure produces.
 *
 * Fixed, and that is the point: `09` §3.2.1 gives `internal` no detail from the error, because an
 * exception's message is written for a developer reading a log and reaches a browser here. The
 * `requestId` in the body is what connects the two.
 */
export const INTERNAL_DETAIL = 'Something went wrong. The request id below is in the server log.';

export interface Classified {
  readonly code: ProblemCode;
  readonly detail: string;
  readonly errors?: readonly ProblemFieldError[];
  readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Classify a thrown value (`09` §3.2.1).
 *
 * Ordered by specificity, and the last arm is the one that matters: anything this function does not
 * recognise is `internal`, whose detail is a fixed sentence rather than the error's message. An
 * unrecognised error's message is the one place a SQL fragment, a file path or a provider's
 * response body reaches a client — `08` §3.10 layer 3 is about exactly that.
 */
export function classify(cause: unknown): Classified {
  if (cause instanceof ProblemError) {
    return {
      code: cause.code,
      detail: cause.message,
      ...(cause.errors === undefined ? {} : { errors: cause.errors }),
      ...(cause.extra === undefined ? {} : { extra: cause.extra }),
    };
  }
  if (cause instanceof HTTPException) {
    // Hono's own, raised by `bodyLimit` and by the router. Mapped by status rather than guessed at
    // from the message, because the message is the library's and may change with a minor.
    return { code: statusToCode(cause.status), detail: httpExceptionDetail(cause) };
  }
  // A storage failure or any other `AppError` that reached a handler is this program being wrong,
  // or the disk being full, and a client can do nothing with either. Logged with the request id;
  // reported as `internal`. `StorageError` extends `AppError`, so one arm covers both — spelled
  // out rather than relying on that, because a future error class that does not extend `AppError`
  // must land in the same place and the `instanceof` chain is not where a reader would check.
  if (cause instanceof StorageError || cause instanceof AppError) {
    return { code: 'internal', detail: INTERNAL_DETAIL };
  }
  return { code: 'internal', detail: INTERNAL_DETAIL };
}

function statusToCode(status: number): ProblemCode {
  switch (status) {
    case 400:
      return 'validation_failed';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    default:
      return 'internal';
  }
}

/**
 * What to say about an `HTTPException`.
 *
 * Its own message for the statuses a client caused, and the fixed sentence for the rest. The split
 * is deliberate: `bodyLimit`'s "that request body is larger than 256 KB" is useful and contains
 * nothing but a number, while a 500 from somewhere inside Hono is a library's internal text.
 */
function httpExceptionDetail(cause: HTTPException): string {
  return cause.status < 500 && cause.message !== '' ? cause.message : INTERNAL_DETAIL;
}

/**
 * `app.onError` (`09` §3.1: "The `problem.ts` `onError` wraps everything").
 *
 * Logs before responding, and logs at `error` only for `internal`: a 404 or a 412 is the API
 * working, and a log line per one would bury the failures that are not.
 */
export function problemOnError(logger: Logger): ErrorHandler {
  return (cause, c) => {
    const classified = classify(cause);
    const requestId = requestIdOf(c);
    if (classified.code === 'internal') {
      logger.error('http.request_failed', {
        detail: { requestId, path: c.req.path, method: c.req.method },
        err: loggedError(cause),
      });
    } else {
      logger.debug('http.request_refused', {
        detail: { requestId, path: c.req.path, code: classified.code },
      });
    }
    return problemResponse(
      c,
      toProblem(
        classified.code,
        classified.detail,
        { path: c.req.path, requestId },
        {
          ...(classified.errors === undefined ? {} : { errors: classified.errors }),
          ...(classified.extra === undefined ? {} : { extra: classified.extra }),
        },
      ),
    );
  };
}

/** The response, with `09` §3.2's `Cache-Control: no-store` for every problem. */
export function problemResponse(c: Context, body: Problem): Response {
  // `no-store` on a problem whatever the path: a 401 cached by a shared proxy would be served to
  // the next person, and `09` §3.2's caching rule is about exactly that. `/healthz` and `/readyz`
  // are not under `/api/`, so `no-store.ts` does not reach them.
  c.header('Cache-Control', 'no-store');
  c.header('Content-Type', PROBLEM_MEDIA_TYPE);
  const retryAfter = retryAfterSeconds(body);
  // `09` §3.2.1 names `Retry-After` for `rate_limited` ("also sent as a header"), `actor_busy` and
  // `server_draining`. Mirrored here, in the one place every problem becomes a response, rather
  // than at each of the three call sites: the body member is what the dashboard reads and the
  // header is what an HTTP client, a proxy and a `curl --retry` obey, and the two disagreeing is
  // the bug this placement makes impossible.
  if (retryAfter !== undefined) c.header('Retry-After', String(retryAfter));
  return c.body(JSON.stringify(body), body.status as 400);
}

/** A `retryAfter` extension member, if it is a whole number of seconds a client can act on. */
function retryAfterSeconds(body: Problem): number | undefined {
  const value = body['retryAfter'];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

/**
 * `@hono/zod-openapi`'s `defaultHook`, which is the half that does **not** throw.
 *
 * A validation failure arrives as `{ success: false, error }`, and a hook that ignored it would let
 * the handler run with an unvalidated request. `09` §3.2.1 maps it to `validation_failed` with an
 * `errors[]` entry per issue, and the pointer is a JSON pointer so a form can highlight a field.
 */
export function problemDefaultHook(
  result: { readonly success: boolean; readonly error?: unknown },
  c: Context,
): Response | undefined {
  if (result.success) return undefined;
  const errors = zodIssues(result.error);
  return problemResponse(
    c,
    toProblem(
      'validation_failed',
      errors.length === 1
        ? 'One field needs attention.'
        : `${String(errors.length)} fields need attention.`,
      { path: c.req.path, requestId: requestIdOf(c) },
      { errors },
    ),
  );
}

/**
 * zod's issues as `09` §3.2.1's `errors[]`.
 *
 * Read structurally rather than by importing zod's types: this module is the HTTP boundary and the
 * validator is `@hono/zod-openapi`'s business. The `message` is zod's, which is written for a
 * person — and it describes the *shape* a field should have, never its value, so nothing a caller
 * sent is echoed back.
 */
function zodIssues(error: unknown): readonly ProblemFieldError[] {
  const issues = (error as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((raw) => {
    const issue = raw as { path?: unknown; code?: unknown; message?: unknown };
    const path = Array.isArray(issue.path) ? issue.path : [];
    return {
      pointer: `/${path.map(String).join('/')}`,
      code: typeof issue.code === 'string' ? issue.code : 'invalid',
      message: typeof issue.message === 'string' ? issue.message : 'That value is not valid.',
    };
  });
}

/**
 * The error, through `08` §3.10 layer 3's allowlist.
 *
 * `toLoggedError` is `shared`'s and already does the work: it keeps `name`, `message`, `code`,
 * `status` and the provider's `requestId`, and nothing else. Used rather than reimplemented,
 * because a second allowlist here is a second place a provider's response body — which for
 * Telegram carries the bot token in the URL — could be let through.
 */
function loggedError(cause: unknown): LoggedError {
  return toLoggedError(cause);
}
