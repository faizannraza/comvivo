/**
 * `Cache-Control: no-store` on `/api/*` and `/control/*` (`09` §3.2, §3.1; `M3-T14`).
 *
 * Two things this prevents, and the second is the one `09` §3.2 names:
 *
 *  - a **shared cache** between the browser and the server serving one member's reply to another;
 *  - the browser's **back-forward cache** restoring a page full of group data after the member
 *    signed out — which a `Cache-Control: private` would not stop.
 *
 * Scoped by path rather than applied everywhere, because `/assets/*` is immutable and
 * `max-age=31536000` on it is the whole reason the dashboard loads instantly on a second visit. A
 * blanket `no-store` would be a performance regression nobody would attribute to a security header.
 */
import type { MiddlewareHandler } from 'hono';

/** The prefixes `09` §3.2's caching rule covers. */
export const NO_STORE_PREFIXES = ['/api/', '/control/'] as const;

/** Whether a path is one `09` §3.2 requires `no-store` on. */
export function needsNoStore(path: string): boolean {
  return NO_STORE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function noStore(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    // **After** `next()`, so it is the final word: a handler that set its own `Cache-Control` is
    // overridden on these paths, and one that set none gets the header it must have.
    if (needsNoStore(c.req.path)) c.header('Cache-Control', 'no-store');
  };
}
