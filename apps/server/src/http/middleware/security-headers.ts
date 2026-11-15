/**
 * `08` §3.8.4's header set, which is normative there and restated by `09` §3.2 (`M3-T14`).
 *
 * ## Two policies, not one
 *
 * §3.8.4 gives **two** `Content-Security-Policy` values and the difference is the point. An HTML
 * response gets the strict nonce policy, because it is the one a browser executes scripts from.
 * An API or ICS response gets `default-src 'none'; frame-ancestors 'none'` — nothing to execute,
 * nothing to frame — and sending the HTML policy there would advertise a nonce for a document that
 * has none, which is how `'strict-dynamic'` ends up being treated as decoration.
 *
 * ## Why the nonce is minted here and not by the SPA
 *
 * `'strict-dynamic'` makes the nonce the *only* thing that can start a script, so a nonce reused
 * across two responses is a nonce an attacker who saw one page can use on the next. It is 128 bits
 * of `crypto.randomBytes` per **request**, put on the context for `spa.ts` to template into the
 * document — `09` §3.1's "the CSP nonce" marker. Hono's `secureHeaders` has a `NONCE` symbol for
 * this; the policy is written out here instead, because §3.8.4 is a normative table and a reader
 * checking the implementation against it should find the same string, not a builder.
 *
 * ## The one exception, and why it is a parameter
 *
 * Home Assistant's Supervisor frames the dashboard same-origin, so the **ingress listener only**
 * uses `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` (§3.8.4, `09` §3.10.11). A
 * parameter rather than a runtime check of the port, because the two listeners are constructed in
 * `listeners.ts` from different config and a header set that inferred its own exception would be
 * one line away from applying it everywhere.
 */
// `@comvivo/shared/crypto`, not `node:crypto`. `08` PSC-8 keeps every source of unpredictable
// bytes in one reviewed directory, and `crypto-only-in-shared-crypto-and-storage-crypto` enforces
// it — a CSP nonce is exactly the kind of "it's only a nonce" use that erodes the rule.
import { randomBytes } from '@comvivo/shared/crypto';
import type { MiddlewareHandler } from 'hono';

/** Where the per-request nonce lives, for `spa.ts` to template in. */
export const CSP_NONCE_KEY = 'cspNonce';

/** `08` §3.8.4's non-CSP headers, which are the same on every listener and every content type. */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
};

/** `08` §3.8.4's API/ICS policy: nothing to run, nothing to frame. */
export function apiCsp(frameAncestors: string): string {
  return `default-src 'none'; frame-ancestors ${frameAncestors}`;
}

/**
 * `08` §3.8.4's HTML policy, verbatim apart from the nonce.
 *
 * Written as one template rather than assembled from directives, so a reader can diff it against
 * the spec's table. `upgrade-insecure-requests` is appended only where §3.8.4 says — exposure
 * modes P and T, which is to say when the instance is reached over HTTPS — because sending it on a
 * loopback install would upgrade `http://127.0.0.1` requests to a port nothing listens on.
 */
export function htmlCsp(
  nonce: string,
  options: {
    readonly frameAncestors: string;
    readonly upgradeInsecure: boolean;
  },
): string {
  const policy =
    `default-src 'none'; ` +
    `script-src 'nonce-${nonce}' 'strict-dynamic'; ` +
    `style-src 'self' 'nonce-${nonce}'; ` +
    `img-src 'self' data: blob:; ` +
    `font-src 'self'; ` +
    `connect-src 'self'; ` +
    `manifest-src 'self'; ` +
    `worker-src 'self'; ` +
    `media-src 'self' blob:; ` +
    `frame-src 'none'; ` +
    `frame-ancestors ${options.frameAncestors}; ` +
    `base-uri 'none'; ` +
    `form-action 'self'; ` +
    `object-src 'none'; ` +
    `require-trusted-types-for 'script'; ` +
    `trusted-types 'none'`;
  return options.upgradeInsecure ? `${policy}; upgrade-insecure-requests` : policy;
}

export interface SecurityHeadersOptions {
  /**
   * The Home Assistant ingress listener, which `08` §3.8.4 exempts from frame refusal.
   *
   * `false` everywhere else, and that is the default a caller gets by omitting it — the safe
   * direction, because the cost of getting it wrong this way is a dashboard that will not frame
   * inside HA, and the other way is every install being framable.
   */
  readonly ingress?: boolean;
  /**
   * Whether this listener is reached over HTTPS (`08` §3.8.4's P/T modes).
   *
   * Controls `Strict-Transport-Security` and `upgrade-insecure-requests`. Off by default because
   * the default install is loopback: an HSTS header from `http://127.0.0.1` pins the browser to
   * HTTPS for localhost, which breaks every other local development server on the machine and
   * cannot be undone from the server side.
   */
  readonly https?: boolean;
  /** Injected so a test gets a deterministic nonce. 16 bytes, base64. */
  readonly nonce?: () => string;
}

/** 128 bits, per request. See the module header on why it is never reused. */
export function randomNonce(): string {
  return randomBytes(16).toString('base64');
}

/**
 * Whether a response is HTML, and therefore gets the strict policy.
 *
 * Decided from the **response**'s content type rather than the request's `Accept`, because what
 * matters is what the browser will parse. A request that said `Accept: text/html` and received
 * JSON is an API error page, and giving it the script policy would be claiming a nonce that is in
 * no document.
 */
function isHtml(contentType: string | undefined): boolean {
  return contentType?.includes('text/html') === true;
}

export function securityHeaders(options: SecurityHeadersOptions = {}): MiddlewareHandler {
  const frameAncestors = options.ingress === true ? "'self'" : "'none'";
  const frameOptions = options.ingress === true ? 'SAMEORIGIN' : 'DENY';
  const nonceOf = options.nonce ?? randomNonce;
  const https = options.https === true;
  return async (c, next) => {
    // Minted **before** the handler, because `spa.ts` reads it off the context to template the
    // document — a nonce decided afterwards could not be in the HTML it authorises.
    const nonce = nonceOf();
    c.set(CSP_NONCE_KEY, nonce);
    await next();

    for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
      c.header(name, value);
    }
    c.header('X-Frame-Options', frameOptions);
    if (https) {
      // `08` §3.8.4: no `preload` by default. Preload is a submission to a browser-vendor list
      // that is slow to leave, and a host who put Comvivo on a subdomain they later reuse would
      // have made that decision for every future service on it.
      c.header('Strict-Transport-Security', 'max-age=31536000');
    }
    c.header(
      'Content-Security-Policy',
      isHtml(c.res.headers.get('Content-Type') ?? undefined)
        ? htmlCsp(nonce, { frameAncestors, upgradeInsecure: https })
        : apiCsp(frameAncestors),
    );
  };
}
