/**
 * `/healthz` and `/readyz` (`09` §3.8; `12` §4.3; `01` §14 **A15**; `M3-T14`).
 *
 * `M3-T14`'s AC names three cases by hand — draining, pending migrations, a stale scheduler — and
 * they are here with the rest of `09` §3.8's table. Every case drives the app through
 * `app.request()` rather than a socket: the contract is the status code and the body, and a real
 * listener would add a port to manage without adding anything to check.
 *
 * ## The assertion that matters most
 *
 * **`/healthz` makes no database call.** That is the whole reason the state is cached, and it is
 * checked by giving the app a readiness check that throws if it is ever run from the liveness path
 * — because a probe that queried a locked database would report `fail` during the migration it
 * exists to protect, and the watchdog would kill the migration.
 */
import { silentLogger } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { createHttpApp, type HttpAppDeps } from './app.js';
import { type EventLoopProbe, HealthState, type ReadinessCheck } from './health.js';
import { PROBLEM_MEDIA_TYPE } from './middleware/problem.js';
import { DRAINING_RETRY_AFTER_S, METRICS_TOKEN_VAR } from './routes/health.js';

const VERSION = '1.2.3';

/** An event loop that is never late, unless a test says otherwise. */
function calmLoop(p99Ms = 0): EventLoopProbe {
  return { p99Ms: () => p99Ms };
}

function check(id: string, passing: boolean, fatal = true): ReadinessCheck {
  return { id, fatal, run: () => passing };
}

function app(
  overrides: Partial<HttpAppDeps> & { readonly state?: HealthState } = {},
): ReturnType<typeof createHttpApp> {
  const state = overrides.state ?? new HealthState({ version: VERSION });
  return createHttpApp({
    logger: silentLogger,
    state,
    checks: [],
    maxBodyKb: 256,
    generateRequestId: () => 'req_test',
    eventLoop: calmLoop(),
    nonce: () => 'nonce-for-tests',
    ...overrides,
  });
}

describe('GET /healthz (09 §3.8, 12 §4.3)', () => {
  it('is 200 and `starting` before boot finishes', async () => {
    const state = new HealthState({ version: VERSION });
    state.starting('migrating');
    const response = await app({ state }).request('/healthz');
    // 200, so a watchdog does not kill a long migration. `12` §3.8.1's whole reason for the
    // `phase` field.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'starting' });
  });

  it('is 200 and `ok` once ready', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    const response = await app({ state }).request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('is 503 and `draining` during shutdown (M3-T14 AC)', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    state.draining();
    const response = await app({ state }).request('/healthz');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'draining' });
  });

  it('is 503 and `fail` after an unrecoverable database error', async () => {
    const state = new HealthState({ version: VERSION });
    state.fail();
    const response = await app({ state }).request('/healthz');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'fail' });
  });

  it('stays 200 in recovery mode, because a restart would not help (M3-T14 AC)', async () => {
    const state = new HealthState({ version: VERSION });
    state.recovery();
    const live = await app({ state }).request('/healthz');
    // The pair that looks inconsistent and is the point: liveness 200, readiness 503. A 503 here
    // would restart a process whose database is still damaged, forever.
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'degraded' });
    const ready = await app({ state, checks: [check('db', true)] }).request('/readyz');
    expect(ready.status).toBe(503);
  });

  it('is `degraded` when a channel’s credentials have failed', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    state.channel('telegram', 'auth_failed');
    const response = await app({ state }).request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'degraded' });
  });

  it('is `degraded` when the newest backup is over 36 hours old, and not before', async () => {
    const now = { at: Date.parse('2026-11-14T12:00:00Z') };
    const state = new HealthState({ version: VERSION, now: () => now.at });
    state.ready();
    state.backupSucceeded(now.at - 35 * 60 * 60 * 1000);
    expect(await (await app({ state }).request('/healthz')).json()).toEqual({ status: 'ok' });
    state.backupSucceeded(now.at - 37 * 60 * 60 * 1000);
    expect(await (await app({ state }).request('/healthz')).json()).toEqual({
      status: 'degraded',
    });
  });

  it('is `ok` on a fresh install that has never been backed up', async () => {
    // Absence is not staleness. Treating it as stale would make every new instance report
    // `degraded` for its first 36 hours, which is how a status comes to be ignored.
    const state = new HealthState({ version: VERSION });
    state.ready();
    expect(await (await app({ state }).request('/healthz')).json()).toEqual({ status: 'ok' });
  });

  it('is `fail` when the event loop has stalled past 5 s', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    const response = await app({ state, eventLoop: calmLoop(6_000) }).request('/healthz');
    // The one condition a restart genuinely fixes, so it outranks `ok`.
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'fail' });
  });

  it('does not report a stall as `fail` while draining', async () => {
    // A process flushing on shutdown may legitimately block the loop, and reporting `fail` there
    // would make a clean shutdown look like a crash to whatever reads the exit.
    const state = new HealthState({ version: VERSION });
    state.draining();
    const response = await app({ state, eventLoop: calmLoop(9_000) }).request('/healthz');
    expect(await response.json()).toEqual({ status: 'draining' });
  });

  it('withholds the detail from an unauthenticated caller', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    state.channel('telegram', 'connected');
    const body = (await (await app({ state }).request('/healthz')).json()) as Record<
      string,
      unknown
    >;
    // `12` §4.3's split. The detailed body names every configured channel and whether its
    // credentials work, which is a reconnaissance report for anyone who can reach the port.
    expect(Object.keys(body)).toEqual(['status']);
  });

  it(`gives the detail to a ${METRICS_TOKEN_VAR} holder`, async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    state.channel('telegram', 'connected');
    const response = await app({ state, metricsToken: 'a'.repeat(43) }).request('/healthz', {
      headers: { Authorization: `Bearer ${'a'.repeat(43)}` },
    });
    const body = (await response.json()) as { version: string; channels: Record<string, string> };
    expect(body.version).toBe(VERSION);
    expect(body.channels).toEqual({ telegram: 'connected' });
  });

  it('withholds the detail from a wrong token, and does not 500 on a short one', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    const built = app({ state, metricsToken: 'a'.repeat(43) });
    for (const token of ['b'.repeat(43), 'short', '']) {
      const response = await built.request('/healthz', {
        headers: { Authorization: `Bearer ${token}` },
      });
      // A length mismatch must not reach `timingSafeEqual`, which throws — and a thrown error on
      // the health endpoint would be a 500 where a 200 with the plain status belongs.
      expect(response.status, token).toBe(200);
      expect(Object.keys((await response.json()) as object), token).toEqual(['status']);
    }
  });

  it('is never cached', async () => {
    // `/healthz` is not under `/api/`, so `no-store.ts` does not reach it. A proxy that cached a
    // `starting` for sixty seconds would hold a watchdog's view of the process at boot.
    const response = await app().request('/healthz');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('makes no database call, which is why the state is cached', async () => {
    // The readiness checks are where a database read would live. Liveness must not run them: a
    // probe that queried a locked database would report `fail` during the migration it exists to
    // protect, and the watchdog would kill the migration.
    const exploding: ReadinessCheck = {
      id: 'db',
      fatal: true,
      run: () => {
        throw new Error('/healthz ran a readiness check');
      },
    };
    const response = await app({ checks: [exploding] }).request('/healthz');
    expect(response.status).toBe(200);
  });
});

describe('GET /readyz (09 §3.8, 01 §14 A15)', () => {
  it('is 200 once every check passes', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    const response = await app({
      state,
      checks: [check('db', true), check('migrations', true), check('scheduler', true)],
    }).request('/readyz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', degraded: [] });
  });

  it('is 503 naming the pending migration, and nothing else (M3-T14 AC)', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    const response = await app({
      state,
      checks: [check('db', true), check('migrations', false), check('scheduler', true)],
    }).request('/readyz');
    expect(response.status).toBe(503);
    expect(response.headers.get('Content-Type')).toBe(PROBLEM_MEDIA_TYPE);
    const body = (await response.json()) as {
      code: string;
      failing: string[];
    };
    // `09` §3.8: "a problem with failing check IDs only". Ids, not messages — a check's message
    // would be the one place a path or a SQL fragment reached an unauthenticated caller.
    expect(body.code).toBe('not_ready');
    expect(body.failing).toEqual(['migrations']);
  });

  it('is 503 for a stale scheduler heartbeat (M3-T14 AC)', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    const response = await app({
      state,
      checks: [check('db', true), check('scheduler', false)],
    }).request('/readyz');
    expect(response.status).toBe(503);
    const body = (await response.json()) as { failing: string[] };
    expect(body.failing).toEqual(['scheduler']);
  });

  it('lists every failing check rather than stopping at the first', async () => {
    // A probe that stopped at the first failure would report one id per attempt, and a host
    // restarting between attempts would chase them one at a time. `09` §3.8's body is a list.
    const state = new HealthState({ version: VERSION });
    state.ready();
    const response = await app({
      state,
      checks: [check('db', false), check('migrations', false), check('scheduler', false)],
    }).request('/readyz');
    const body = (await response.json()) as { failing: string[] };
    expect(body.failing).toEqual(['db', 'migrations', 'scheduler']);
  });

  it('treats a throwing check as a failing one', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    const response = await app({
      state,
      checks: [
        {
          id: 'db',
          fatal: true,
          run: () => {
            throw new Error('database is locked');
          },
        },
      ],
    }).request('/readyz');
    // A 500 from the readiness probe tells a wait loop nothing it can act on; a 503 naming the
    // check tells it everything. And the exception's message does not reach the body.
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('locked');
  });

  it('does not fail readiness for a warning-only check', async () => {
    // `09` §3.8 makes "dashboard assets are present" a warning. A missing `dist/` is a broken UI,
    // not an unready instance — and failing readiness on it would take the API out of a reverse
    // proxy because a static build step was skipped.
    const state = new HealthState({ version: VERSION });
    state.ready();
    const response = await app({
      state,
      checks: [check('db', true), check('assets', false, false)],
    }).request('/readyz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', degraded: ['assets'] });
  });

  it('ignores a chat-platform outage entirely (01 §14 A15)', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    state.channel('telegram', 'auth_failed');
    state.channel('discord', 'connected');
    const response = await app({ state, checks: [check('db', true)] }).request('/readyz');
    // 200, with the channel listed. A readiness probe that failed here would take the whole
    // instance out of a load balancer because somebody else's API was down.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      degraded: ['channel:telegram'],
    });
  });

  it('answers `server_draining` rather than `not_ready` during shutdown', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    state.draining();
    const response = await app({ state, checks: [check('db', true)] }).request('/readyz');
    expect(response.status).toBe(503);
    // Its own code, so a load balancer can tell a rolling restart from a broken instance.
    const body = (await response.json()) as { code: string; retryAfter: number };
    expect(body.code).toBe('server_draining');
    // `09` §3.2.1 gives this code a `Retry-After`, in the body **and** the header: the dashboard
    // reads the member, a proxy reads the header, and `12` §4.4's grace is the earliest a retry
    // can succeed.
    expect(body.retryAfter).toBe(DRAINING_RETRY_AFTER_S);
    expect(response.headers.get('Retry-After')).toBe(String(DRAINING_RETRY_AFTER_S));
  });

  it('sends the host’s configured grace as `Retry-After`, not the default', async () => {
    // A host who set a 5 s grace should not have proxies holding the instance out for 30.
    const state = new HealthState({ version: VERSION });
    state.ready();
    state.draining();
    const response = await app({
      state,
      checks: [check('db', true)],
      shutdownGraceS: 5,
    }).request('/readyz');
    expect(response.headers.get('Retry-After')).toBe('5');
  });

  it('sends no `Retry-After` on a failure that retrying will not fix', async () => {
    // `not_ready` from a failing check has no `retryAfter` in `09` §3.2.1, and inventing one here
    // would tell a proxy that a broken database is a timing problem. The header is mirrored from
    // the body member, so its absence is the absence of a claim rather than a forgotten line.
    const response = await app({ checks: [check('db', false)] }).request('/readyz');
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBeNull();
  });
});

describe('the state machine (09 §3.8)', () => {
  it('will not leave `draining`, because the load balancer has already acted on it', async () => {
    const state = new HealthState({ version: VERSION });
    state.draining();
    state.ready();
    state.starting('migrating');
    state.recovery();
    expect(state.snapshot().status).toBe('draining');
  });

  it('will not leave `fail`', async () => {
    const state = new HealthState({ version: VERSION });
    state.fail();
    state.ready();
    state.draining();
    expect(state.snapshot().status).toBe('fail');
  });

  it('lets a channel clear its own degradation by reconnecting', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    state.channel('telegram', 'auth_failed');
    expect(state.snapshot().status).toBe('degraded');
    state.channel('telegram', 'connected');
    // Derived rather than set, so it cannot be set and then forgotten.
    expect(state.snapshot().status).toBe('ok');
  });
});

describe('both paths under basePath (09 §3.8)', () => {
  it('serves /healthz and /readyz at the root and under the prefix', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    const built = app({ state, basePath: '/hub', checks: [check('db', true)] });
    for (const path of ['/healthz', '/readyz', '/hub/healthz', '/hub/readyz']) {
      // A reverse proxy that does not strip its prefix would otherwise 404 the probe it was
      // configured with — which looks like the instance being down.
      expect((await built.request(path)).status, path).toBe(200);
    }
  });

  it('normalises a trailing slash and a missing leading one', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    for (const basePath of ['/hub/', 'hub']) {
      const built = app({ state, basePath, checks: [check('db', true)] });
      expect((await built.request('/hub/healthz')).status, basePath).toBe(200);
    }
  });

  it('mounts nothing extra for a basePath of `/`', async () => {
    const state = new HealthState({ version: VERSION });
    state.ready();
    const built = app({ state, basePath: '/', checks: [check('db', true)] });
    expect((await built.request('/healthz')).status).toBe(200);
    expect((await built.request('//healthz')).status).toBe(404);
  });
});
