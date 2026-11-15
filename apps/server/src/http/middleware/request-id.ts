/**
 * `X-Request-Id` (`09` §3.1; `M3-T14`).
 *
 * First in `09` §3.1's chain, and it has to be: every other middleware and every problem body
 * names the request id, and `problem.ts` can only report the id of a request that has one. A
 * failure in the second middleware still produces a problem a host can find in the log.
 *
 * ## Why an inbound header is echoed but not trusted
 *
 * `09` §3.1 says "echo `X-Request-Id`", because a reverse proxy or a tracing sidecar has usually
 * already assigned one and a second id would make the two logs impossible to join. But the header
 * is attacker-controlled on any listener that is reachable, and the id ends up in a log line and
 * in a JSON body — so it is accepted only when it **looks like an id**: up to 64 characters of
 * ASCII letters, digits, `-` and `_`. Anything else is replaced rather than rejected, because a
 * malformed trace header is not a reason to refuse a request.
 *
 * Without that filter the id is a log-injection vector: a newline in it writes a second, forged
 * line into a JSON log, and `11` §3.10.1's whole premise is that a log line means what it says.
 */
import type { MiddlewareHandler } from 'hono';

/**
 * Type `c.get('requestId')` for the whole app.
 *
 * Without this the getter returns `any`, and `requestIdOf` in `problem.ts` — the one function that
 * reads it — would be doing a `typeof` check on an `any` and calling it a guard. `string |
 * undefined` rather than `string`, because an app that mounts a route without this middleware
 * genuinely has no id: `app.test.ts`'s `defaultHook` case builds exactly that, and the honest type
 * is what makes `requestIdOf`'s fallback a real branch rather than dead code.
 */
declare module 'hono' {
  interface ContextVariableMap {
    requestId: string | undefined;
  }
}

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** `02`'s TypeID prefix for a request, so an id in a log is recognisable at a glance. */
export const REQUEST_ID_PREFIX = 'req_';

/** What an inbound id may contain. Deliberately narrower than RFC 7230's token. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface RequestIdOptions {
  /** Injected so a test gets a deterministic id. Production passes the id generator's. */
  readonly generate: () => string;
}

export function requestId(options: RequestIdOptions): MiddlewareHandler {
  return async (c, next) => {
    const inbound = c.req.header(REQUEST_ID_HEADER);
    const id = inbound !== undefined && SAFE_ID.test(inbound) ? inbound : options.generate();
    c.set('requestId', id);
    // Set before `next()`, so a response produced further down the chain — a 413 from the body
    // limit, say — still carries it.
    c.header(REQUEST_ID_HEADER, id);
    await next();
  };
}

/** Whether a would-be request id is one this middleware would echo. Exported for the test. */
export function isSafeRequestId(candidate: string): boolean {
  return SAFE_ID.test(candidate);
}
