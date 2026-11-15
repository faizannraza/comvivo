/**
 * `createHttpApp(deps)` — `09` §3.1's composition (`M3-T14`).
 *
 * ## The order is the contract
 *
 * `09` §3.1 fixes it: request-id → base-path → proxy → security-headers → (static/SPA) → no-store →
 * body-limit → rate-limit → session → csrf → rate-limit → route-level → handler, with
 * `problem.ts`'s `onError` around everything. Five of those exist at `M3-T14` and the rest arrive
 * with the tasks that need them, so this function registers what exists **in that order** and
 * `app.test.ts` asserts the order rather than trusting it.
 *
 * Why the order matters more than it looks: `request-id` must be first or a problem from any later
 * middleware has no id to name; `security-headers` must precede the static handler or an asset
 * response escapes the header set; and `body-limit` must precede anything that reads the body or
 * the cap is applied after the allocation it exists to prevent.
 *
 * ## Why `OpenAPIHono` now, with no documented routes yet
 *
 * `09` D-02 makes `@hono/zod-openapi` the API's spec source, and its `defaultHook` is the half of
 * `09` §3.2.1 that does not throw — a zod failure arrives as a result object, and a route that did
 * not look would answer 200 with an unvalidated body. Wiring the hook at the app's construction
 * means the first validated route (`M3-T36`) cannot be registered without it. The health endpoints
 * are plain Hono routes: `09` §3.8 serves them "before migrations finish", they validate nothing,
 * and they are an operational contract with a watchdog rather than an API resource.
 */

import type { Logger } from '@comvivo/shared';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Env, MiddlewareHandler } from 'hono';
import {
  type EventLoopProbe,
  type HealthState,
  nodeEventLoopProbe,
  type ReadinessCheck,
} from './health.js';
import { requestBodyLimit } from './middleware/body-limit.js';
import { noStore } from './middleware/no-store.js';
import { ProblemError, problemDefaultHook, problemOnError } from './middleware/problem.js';
import { requestId } from './middleware/request-id.js';
import { securityHeaders } from './middleware/security-headers.js';
import { mountHealthRoutes } from './routes/health.js';

export interface HttpAppDeps {
  readonly logger: Logger;
  readonly state: HealthState;
  readonly checks: readonly ReadinessCheck[];
  /** `api.maxBodyKb`. */
  readonly maxBodyKb: number;
  /** `dashboard.basePath`, or `'/'`. Health is mounted at the root **and** here (`09` §3.8). */
  readonly basePath?: string;
  /** The HA ingress listener's exceptions (`08` §3.8.4). */
  readonly ingress?: boolean;
  /** Whether this listener is reached over HTTPS (`08` §3.8.4's P/T modes). */
  readonly https?: boolean;
  readonly metricsToken?: string | undefined;
  /** Addresses that get `12` §4.3's detailed health body. */
  readonly detailFrom?: readonly string[];
  /** `12` §4.4's `COMVIVO_SHUTDOWN_GRACE_MS` in seconds — `server_draining`'s `Retry-After`. */
  readonly shutdownGraceS?: number;
  /** `req_…` ids, from the instance's id generator. */
  readonly generateRequestId: () => string;
  /** Injected so a test can drive the event-loop branch without stalling the loop. */
  readonly eventLoop?: EventLoopProbe;
  /** Injected so the security headers are deterministic in a test. */
  readonly nonce?: () => string;
}

/**
 * `09` §3.1's middleware order, as names.
 *
 * The five pieces of §3.1's chain that exist at `M3-T14` are these four plus `problem.ts`'s
 * `onError`, which is not a chain entry but wraps all of them. The rest of §3.1's list — base-path,
 * proxy, ingress, session, csrf, rate-limit, group-scope, recent-auth, idempotency — arrives with
 * the tasks that need them, and each inserts at its §3.1 position rather than at the end.
 *
 * This is the **expected** order; `registerMiddleware` below labels each handler with its name as
 * it registers it, and `app.test.ts` reads the labels back off the composed app's `routes` and
 * compares. That is what makes it a test rather than a comment: moving a `registerMiddleware` call
 * changes the array the test reads. A planted reordering — `request-id` last — passed the whole
 * suite before this existed, because `MIDDLEWARE_ORDER` was a constant nothing compared against.
 */
export const MIDDLEWARE_ORDER = [
  'request-id',
  'security-headers',
  'no-store',
  'body-limit',
] as const;

export type MiddlewareName = (typeof MIDDLEWARE_ORDER)[number];

/**
 * Register one middleware under its `09` §3.1 name.
 *
 * The name is stamped onto the handler so the composed app's registration order is **observable**.
 * Without it the order is three `app.use('*', …)` entries holding anonymous closures, which no
 * test can tell apart.
 *
 * `defineProperty` rather than a named function expression in each factory, because two of the four
 * names are not identifiers and one handler comes from `hono/body-limit` and cannot be named at its
 * source at all. No wrapper function: a wrapper would add a frame to every request on the paths it
 * covers, to serve a test.
 */
function registerMiddleware(
  app: OpenAPIHono,
  name: MiddlewareName,
  path: string,
  handler: MiddlewareHandler,
): void {
  Object.defineProperty(handler, 'name', { value: name, configurable: true });
  app.use(path, handler);
}

/** The middleware names the composed `app` registered, in order, each once. */
export function middlewareOrderOf(app: OpenAPIHono): readonly string[] {
  const expected = new Set<string>(MIDDLEWARE_ORDER);
  const seen: string[] = [];
  for (const route of app.routes) {
    const name = route.handler.name;
    if (expected.has(name) && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * Loopback, which `12` §4.3 gives the detailed health body.
 *
 * Both families, because a host reaching `http://localhost:7777` gets `::1` on a dual-stack machine
 * and `127.0.0.1` on an IPv4-only one — and `::ffff:127.0.0.1` when Node accepts an IPv4
 * connection on an IPv6 socket, which is the default. Omitting the mapped form is the mistake that
 * makes `curl localhost/healthz` show the plain status on exactly the machines where it matters.
 */
export const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'] as const;

export function createHttpApp(deps: HttpAppDeps): OpenAPIHono {
  // The type argument is explicit, not inferred. `problemDefaultHook` takes a plain `Context`, so
  // the constructor infers `OpenAPIHono<any>` from it — and `any` here would spread through
  // `return app` to everything the boot sequence does with the result.
  const app = new OpenAPIHono<Env>({ defaultHook: problemDefaultHook });

  // `09` §3.1: "The `problem.ts` `onError` wraps everything." Registered first so it is in place
  // before any middleware can throw.
  app.onError(problemOnError(deps.logger));

  registerMiddleware(app, 'request-id', '*', requestId({ generate: deps.generateRequestId }));
  registerMiddleware(
    app,
    'security-headers',
    '*',
    securityHeaders({
      ...(deps.ingress === undefined ? {} : { ingress: deps.ingress }),
      ...(deps.https === undefined ? {} : { https: deps.https }),
      ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
    }),
  );
  registerMiddleware(app, 'no-store', '*', noStore());
  // Scoped to the two prefixes that accept a body, rather than `*`. `hono/body-limit` reads the
  // request to measure it, and applying it to `GET /assets/*` would be work on every asset for a
  // body that is never there.
  for (const prefix of ['/api/*', '/control/*']) {
    registerMiddleware(app, 'body-limit', prefix, requestBodyLimit(deps.maxBodyKb));
  }

  const healthDeps = {
    state: deps.state,
    eventLoop: deps.eventLoop ?? nodeEventLoopProbe(),
    checks: deps.checks,
    metricsToken: deps.metricsToken,
    detailFrom: deps.detailFrom ?? LOOPBACK_ADDRESSES,
    ...(deps.shutdownGraceS === undefined ? {} : { shutdownGraceS: deps.shutdownGraceS }),
  };
  mountHealthRoutes(app, healthDeps);
  // And under `basePath`, per `09` §3.8's closing line: a reverse proxy that does not strip the
  // prefix would otherwise 404 the probe it was configured with.
  const prefix = normaliseBasePath(deps.basePath);
  if (prefix !== '') mountHealthRoutes(app, healthDeps, prefix);

  // A 404 that is problem+json like every other failure. Hono's default is a bare `404 Not Found`
  // text body, which would be the one response on this server a client cannot parse as a problem.
  //
  // A `ProblemError`, not a class of its own with a `status` field: `classify` recognises
  // `ProblemError` and sends anything it does not recognise to `internal`, so a bespoke error here
  // would have turned every 404 into a 500 — and `09` §3.2's rule that a wrong id prefix returns
  // 404 "so no information leaks" would have leaked the difference as a status code.
  app.notFound(() => {
    throw new ProblemError('not_found', 'No such endpoint.');
  });

  return app;
}

/** `09` §5.1: `basePath` starts with `/` and has no trailing slash, except `/` itself. */
export function normaliseBasePath(basePath: string | undefined): string {
  if (basePath === undefined || basePath === '' || basePath === '/') return '';
  const withSlash = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}
