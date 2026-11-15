/**
 * `GET /healthz` and `GET /readyz` (`09` §3.8; `12` §4.3; `01` §14 **A15**; `M3-T14`).
 *
 * Both are served at the root **and** under `basePath`, on the main listener **and** on the ingress
 * listener (`09` §3.8's closing line) — which is why they are a function over a Hono app rather
 * than an app of their own: `listeners.ts` mounts the same routes twice.
 *
 * ## Why the detail is gated and the status is not
 *
 * `12` §4.3 splits the response. Everyone gets `{status}`; loopback, the trusted ingress source and
 * `COMVIVO_METRICS_TOKEN` holders also get the version, the phase, the uptime and the checks.
 *
 * That is not caution for its own sake. The detailed body names every configured channel and
 * whether its credentials are working, how far the outbox is behind and when the last backup was —
 * which is a reconnaissance report for anyone who can reach the port, and `08` SD-10 assumes the
 * port may be reachable. The **status** is safe to publish because a watchdog needs it and it says
 * nothing a failed request would not.
 */

import { envVar } from '@comvivo/shared';
import { secureEqual } from '@comvivo/shared/crypto';
import type { Env, Hono } from 'hono';
import {
  EVENT_LOOP_FAIL_MS,
  type EventLoopProbe,
  type HealthSnapshot,
  type HealthState,
  isLive,
  type ReadinessCheck,
  runReadiness,
} from '../health.js';
import {
  PROBLEM_MEDIA_TYPE,
  problemResponse,
  requestIdOf,
  toProblem,
} from '../middleware/problem.js';

/** `09` §3.8's two paths. Exported so `listeners.ts` can mount them under `basePath` too. */
export const HEALTH_PATH = '/healthz';
export const READY_PATH = '/readyz';

/**
 * The `Retry-After` a draining instance sends, in seconds.
 *
 * `12` §4.4's `COMVIVO_SHUTDOWN_GRACE_MS` default is 30 s, and that is the earliest a retry can
 * possibly succeed: before the grace is up this process is still finishing in-flight turns and
 * flushing the outbox. Overridable through `shutdownGraceS` so the boot can pass what the host
 * actually configured — a host that set a 5 s grace should not have proxies waiting 30.
 */
export const DRAINING_RETRY_AFTER_S = 30;

export interface HealthRouteDeps {
  readonly state: HealthState;
  readonly eventLoop: EventLoopProbe;
  readonly checks: readonly ReadinessCheck[];
  /** `COMVIVO_METRICS_TOKEN`, when the host set one. */
  readonly metricsToken?: string | undefined;
  /** CIDR-free: the exact remote addresses that get the detailed body (loopback, HA ingress). */
  readonly detailFrom: readonly string[];
  /** Injected for the uptime calculation and for tests. */
  readonly now?: () => number;
  /** `12` §4.4's shutdown grace in seconds, used as `server_draining`'s `Retry-After`. */
  readonly shutdownGraceS?: number;
}

/** `12` §4.3's detailed body. Only for the callers §4.3 lists. */
interface DetailedHealth extends HealthSnapshot {
  readonly uptimeS: number;
  readonly eventLoopP99Ms: number;
}

/**
 * Whether this caller gets `12` §4.3's detail.
 *
 * The token comparison is `secureEqual` from `@comvivo/shared/crypto` (`08` §3.7.13), which
 * hashes both sides before comparing. That is not ceremony: `timingSafeEqual` **throws** on
 * arguments of different lengths, so a hand-rolled version has to check the length first — and the
 * early return leaks the length of the configured token. Hashing makes both inputs 32 bytes by
 * construction, so the comparison is total and nothing leaks. `08` PSC-8 also keeps `node:crypto`
 * out of this directory, which is what sent this call to the reviewed module in the first place.
 */
function maySeeDetail(
  header: string | undefined,
  remote: string | undefined,
  deps: HealthRouteDeps,
): boolean {
  if (remote !== undefined && deps.detailFrom.includes(remote)) return true;
  const expected = deps.metricsToken;
  if (expected === undefined || expected === '' || header === undefined) return false;
  const bearer = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  return secureEqual(bearer, expected);
}

/**
 * Mount `/healthz` and `/readyz` on `app` at `prefix`.
 *
 * Plain Hono routes rather than `app.openapi`, and that is `09` §3.8's own framing: these are not
 * `/api/v1` resources, they take no input to validate, and they are served "before migrations
 * finish" — before the point at which an OpenAPI document means anything. `M3-T36` documents the
 * API surface; these two are an operational contract with a watchdog.
 */
export function mountHealthRoutes(app: Hono<Env>, deps: HealthRouteDeps, prefix = ''): void {
  const now = deps.now ?? Date.now;

  app.get(`${prefix}${HEALTH_PATH}`, (c) => {
    // No database, no await, no network. `09` §3.8: "No DB access per request (cached state)" —
    // and the one measurement is in-process, because a wedged event loop cannot report itself.
    const eventLoopP99Ms = deps.eventLoop.p99Ms();
    const snapshot = deps.state.snapshot();
    const status =
      eventLoopP99Ms > EVENT_LOOP_FAIL_MS && snapshot.status !== 'draining'
        ? // A stall is the one condition a restart genuinely fixes, so it outranks `ok`,
          // `starting` and `degraded`. Not `draining`: a process shutting down may legitimately
          // block the loop while it flushes, and reporting `fail` there would make a clean
          // shutdown look like a crash to whatever is reading the exit.
          ('fail' as const)
        : snapshot.status;

    // `Cache-Control` explicitly: `/healthz` is not under `/api/` so `no-store.ts` does not cover
    // it, and a proxy that cached a `starting` for sixty seconds would hold a watchdog's view of
    // the process at boot.
    c.header('Cache-Control', 'no-store');
    const code = isLive(status) ? 200 : 503;
    if (!maySeeDetail(c.req.header('Authorization'), remoteOf(c.env), deps)) {
      return c.json({ status }, code);
    }
    const detailed: DetailedHealth = {
      ...snapshot,
      status,
      uptimeS: Math.max(0, Math.round((now() - snapshot.startedAt) / 1000)),
      eventLoopP99Ms: Math.round(eventLoopP99Ms),
    };
    return c.json(detailed, code);
  });

  app.get(`${prefix}${READY_PATH}`, async (c) => {
    const snapshot = deps.state.snapshot();
    c.header('Cache-Control', 'no-store');
    // Draining is not "not ready" — it is "going away", and `09` §3.8 gives it its own code so a
    // load balancer can tell a rolling restart from a broken instance.
    if (snapshot.status === 'draining') {
      return problemResponse(
        c,
        toProblem(
          'server_draining',
          'This instance is shutting down.',
          { path: c.req.path, requestId: requestIdOf(c) },
          // `09` §3.2.1 gives this code a `Retry-After`. Without it a reverse proxy decides for
          // itself how long to hold the instance out, and the two most common defaults — retry
          // immediately, or back off for minutes — are both wrong for a 30 s rolling restart.
          { extra: { retryAfter: deps.shutdownGraceS ?? DRAINING_RETRY_AFTER_S } },
        ),
      );
    }
    // Recovery mode is 503 **whatever the checks say**, and `09` §3.8 is explicit about the pair:
    // "restarting would not help, so liveness stays 200 while `/readyz` is 503". The checks can
    // all pass in recovery mode — the database opens, the migrations are at head — so a readiness
    // answer derived from them alone would route traffic to an instance running on a damaged
    // database. Found by the test for `09` §3.8's own sentence.
    if (snapshot.phase === 'recovery') {
      return problemResponse(
        c,
        toProblem(
          'not_ready',
          'This instance is in recovery mode. A host has to repair or restore it.',
          { path: c.req.path, requestId: requestIdOf(c) },
          { extra: { phase: 'recovery' } },
        ),
      );
    }
    const result = await runReadiness(deps.checks, snapshot);
    if (result.ready) {
      return c.json({ status: 'ready', degraded: result.degraded }, 200);
    }
    // `09` §3.8: "a problem with failing check IDs only". Ids, not messages — a check's message
    // would be the one place a path or a SQL fragment reached an unauthenticated caller.
    return problemResponse(
      c,
      toProblem(
        'not_ready',
        result.failing.length === 1
          ? 'One check has not passed yet.'
          : `${String(result.failing.length)} checks have not passed yet.`,
        { path: c.req.path, requestId: requestIdOf(c) },
        { extra: { failing: result.failing, degraded: result.degraded } },
      ),
    );
  });
}

/**
 * The caller's address, as `@hono/node-server` exposes it.
 *
 * Read off `c.env.incoming.socket`, which is the Node adapter's request object. Typed as `unknown`
 * and narrowed rather than imported from `@hono/node-server`: a request built by `app.request()`
 * in a test has no `env` at all, and that is **correct** behaviour rather than a gap — a test
 * caller is not loopback unless it says so through `detailFrom`.
 */
function remoteOf(env: unknown): string | undefined {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: unknown } } } | undefined)
    ?.incoming;
  const address = incoming?.socket?.remoteAddress;
  return typeof address === 'string' ? address : undefined;
}

/** The media type a `/readyz` failure uses, re-exported so a test need not import two modules. */
export { PROBLEM_MEDIA_TYPE };

/** `COMVIVO_METRICS_TOKEN` (`12` §4.4). */
export const METRICS_TOKEN_VAR = envVar('METRICS_TOKEN');
