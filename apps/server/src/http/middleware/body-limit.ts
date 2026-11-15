/**
 * `09` §3.2's body cap, as `hono/body-limit` (`09` §3.1; `M3-T14`).
 *
 * `api.maxBodyKb`, default 256 KB. The limit exists for two different reasons at once and both
 * are worth naming, because they imply different behaviour on the edge:
 *
 *  - **memory.** A JSON body is parsed into the heap, and `01` §11.10 budgets a Raspberry Pi. An
 *    unbounded body is an unbounded allocation from an unauthenticated request.
 *  - **honesty.** `09` §3.2 says 256 KB, and a cap nothing enforces is a sentence in a document.
 *
 * ## Why it refuses rather than truncates
 *
 * `hono/body-limit` throws, which `problem.ts` turns into `09` §3.2.1's `payload_too_large` (413).
 * Truncating would be worse than either: a constitution submitted as a JSON string field and
 * silently cut in half would parse, validate and be stored as a governance document the group
 * never wrote.
 */
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';

/** `09` §5.1's default. */
export const DEFAULT_MAX_BODY_KB = 256;

export function requestBodyLimit(maxBodyKb: number = DEFAULT_MAX_BODY_KB): MiddlewareHandler {
  if (!Number.isInteger(maxBodyKb) || maxBodyKb < 1) {
    throw new RangeError(`api.maxBodyKb must be a positive integer, got ${String(maxBodyKb)}`);
  }
  return bodyLimit({
    maxSize: maxBodyKb * 1024,
    onError: () => {
      // Rethrown as an `HTTPException` so `problem.ts` is still the only place that formats a
      // response. `hono/body-limit`'s own default returns a bare 413 with a text body, which
      // would be the one response on this server that is not problem+json — and a client that
      // parsed every error as problem+json would fail on exactly the request it needed to retry
      // smaller.
      throw new HTTPException(413, {
        message: `That request body is larger than ${String(maxBodyKb)} KB.`,
      });
    },
  });
}
