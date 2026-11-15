/**
 * The composed app: middleware order, the header set, and problem+json (`09` §3.1, §3.2.1;
 * `08` §3.8.4; `M3-T14`).
 *
 * `09` §3.1's middleware order is a **contract**, not a preference, and the three ways it breaks
 * are each a real failure rather than an untidiness:
 *
 *  - `request-id` after anything else → a problem from that middleware has no id, so the sentence
 *    a host reads cannot be joined to the line in the log that explains it;
 *  - `security-headers` after the static handler → an asset response escapes the header set;
 *  - `body-limit` after something that reads the body → the cap is applied after the allocation it
 *    exists to prevent.
 *
 * So the order is asserted by **observing the composed app**, not by reading the registration
 * code: a test that checked `MIDDLEWARE_ORDER` against itself would pass whatever `createHttpApp`
 * actually did.
 */

import { AppError, BRAND, type LogFields, StorageError } from '@comvivo/shared';
import { silentLogger } from '@comvivo/shared/testing';
import { OpenAPIHono, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import {
  createHttpApp,
  type HttpAppDeps,
  LOOPBACK_ADDRESSES,
  MIDDLEWARE_ORDER,
  middlewareOrderOf,
  normaliseBasePath,
} from './app.js';
import { HealthState } from './health.js';
import { needsNoStore } from './middleware/no-store.js';
import {
  classify,
  INTERNAL_DETAIL,
  PROBLEM_CODES,
  PROBLEM_MEDIA_TYPE,
  type ProblemCode,
  ProblemError,
  problemDefaultHook,
  problemStatus,
  problemType,
} from './middleware/problem.js';
import { isSafeRequestId, REQUEST_ID_HEADER } from './middleware/request-id.js';
import { apiCsp, htmlCsp, STATIC_SECURITY_HEADERS } from './middleware/security-headers.js';

function ready(): HealthState {
  const state = new HealthState({ version: '1.2.3' });
  state.ready();
  return state;
}

function app(overrides: Partial<HttpAppDeps> = {}): ReturnType<typeof createHttpApp> {
  return createHttpApp({
    logger: silentLogger,
    state: ready(),
    checks: [],
    maxBodyKb: 1,
    generateRequestId: () => 'req_generated',
    eventLoop: { p99Ms: () => 0 },
    nonce: () => 'nonce-for-tests',
    ...overrides,
  });
}

/** A logger that keeps what it was told, so the log half of `onError` is assertable. */
function recordingLogger(): {
  readonly logger: HttpAppDeps['logger'];
  readonly lines: { level: string; event: string; fields: LogFields | undefined }[];
} {
  const lines: { level: string; event: string; fields: LogFields | undefined }[] = [];
  const logger = {
    ...silentLogger,
    error(event: string, fields?: LogFields) {
      lines.push({ level: 'error', event, fields });
    },
    debug(event: string, fields?: LogFields) {
      lines.push({ level: 'debug', event, fields });
    },
    child() {
      return logger;
    },
  } as unknown as HttpAppDeps['logger'];
  return { logger, lines };
}

describe('classify, which decides what a thrown thing becomes (09 §3.2.1)', () => {
  it('maps every status Hono raises to the code §3.2.1 gives it', () => {
    // `hono/body-limit` raises 413 and the router raises 404, but §3.1's later middleware raise
    // 400, 401, 403, 409, 415 and 429 as `HTTPException`s too, and each arrives here. A mapping
    // table is exactly the thing that rots silently: a status added to the switch with the wrong
    // code reads correctly and is wrong for one path.
    const cases: readonly (readonly [number, ProblemCode])[] = [
      [400, 'validation_failed'],
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [413, 'payload_too_large'],
      [415, 'unsupported_media_type'],
      [429, 'rate_limited'],
    ];
    for (const [status, code] of cases) {
      const classified = classify(new HTTPException(status as 400, { message: 'because' }));
      expect(classified.code, String(status)).toBe(code);
      // A client-caused status keeps the library's message: `bodyLimit`'s "larger than 256 KB" is
      // useful and contains nothing but a number.
      expect(classified.detail, String(status)).toBe('because');
    }
  });

  it('does not pass a 5xx message through, whoever raised it', () => {
    // A 500 from inside Hono is a library's internal text, and this is the one place it would
    // reach a browser. `09` §3.2.1: `internal` gets the fixed sentence and no stack trace.
    for (const status of [500, 502, 504] as const) {
      const classified = classify(
        new HTTPException(status, { message: 'pool exhausted at :5432' }),
      );
      expect(classified.code, String(status)).toBe('internal');
      expect(classified.detail, String(status)).toBe(INTERNAL_DETAIL);
    }
  });

  it('reports an AppError, a StorageError and an unknown throw identically', () => {
    // Three arms, one answer, and deliberately so: a client can act on none of them, and the
    // difference between "the disk is full" and "this program is wrong" belongs in the log line
    // beside the request id, not in the body.
    const causes = [
      new AppError('io.failed', 'the disk is full at /var/lib/instance-data'),
      new StorageError('STORAGE_DISK_SPACE_LOW', 'database or disk is full'),
      'a bare string nobody expected',
      undefined,
    ];
    for (const cause of causes) {
      const classified = classify(cause);
      expect(classified.code).toBe('internal');
      expect(classified.detail).toBe(INTERNAL_DETAIL);
      expect(classified.detail).not.toContain('disk');
    }
  });
});

describe('09 §3.1’s middleware order', () => {
  it('registers them in the order the spec fixes', () => {
    // Read off the **composed app**, not off the constant. `createHttpApp` labels each handler as
    // it registers it, so this is Hono's own registration array — and a planted reordering (moving
    // `request-id` to last) fails here, which is the drill that found this test missing.
    expect(middlewareOrderOf(app())).toEqual([...MIDDLEWARE_ORDER]);
  });

  it('puts a request id on a problem raised by a later middleware', async () => {
    // The behavioural half, and the reason `request-id` is first rather than merely present:
    // `body-limit` throws its own 413 before any handler runs, and if it were registered ahead of
    // `request-id` that problem would carry `requestId: 'unknown'` — unquotable, on exactly the
    // request a host needs to find in the log.
    const built = app({ maxBodyKb: 1 });
    built.post('/api/v1/thing', (c) => c.json({ ok: true }));
    const response = await built.request('/api/v1/thing', {
      method: 'POST',
      body: 'x'.repeat(2 * 1024),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { requestId: string }).requestId).toBe('req_generated');
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('req_generated');
  });

  it('scopes body-limit to the two prefixes that accept a body', () => {
    // `hono/body-limit` reads the request to measure it. On `GET /assets/*` that is work on every
    // asset for a body that is never there, which is why it is not `*`.
    const paths = app()
      .routes.filter((route) => route.handler.name === 'body-limit')
      .map((route) => route.path);
    expect(paths).toEqual(['/api/*', '/control/*']);
  });
});

describe('the request id (09 §3.1)', () => {
  it('is generated and echoed when the caller sent none', async () => {
    const response = await app().request('/healthz');
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('req_generated');
  });

  it('echoes an id the caller sent, so two logs can be joined', async () => {
    const response = await app().request('/healthz', {
      headers: { [REQUEST_ID_HEADER]: 'trace-abc123' },
    });
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('trace-abc123');
  });

  it('replaces an id that is not id-shaped, rather than logging it', async () => {
    // A newline in an echoed id writes a second, forged line into a JSON log, and `11` §3.10.1's
    // whole premise is that a log line means what it says. Replaced rather than rejected: a
    // malformed trace header is not a reason to refuse a request.
    for (const hostile of ['a\nb', 'x'.repeat(65), 'has space', '"quoted"', '']) {
      expect(isSafeRequestId(hostile), hostile).toBe(false);
    }
    // End to end with the shapes a **conforming** client can actually send. The newline case
    // cannot be tested this way and that is worth recording rather than working around:
    // `Headers.append` throws on it, because header framing forbids it — so the guard's value is
    // against a non-conforming peer or a proxy that reassembles a folded header, not against
    // `fetch`.
    for (const sendable of ['x'.repeat(65), 'has space', '"quoted"']) {
      const response = await app().request('/healthz', {
        headers: { [REQUEST_ID_HEADER]: sendable },
      });
      expect(response.headers.get(REQUEST_ID_HEADER), sendable).toBe('req_generated');
    }
  });

  it('is on a problem produced by a later middleware', async () => {
    // The reason `request-id` is first. A 404 is produced by the router, well after this
    // middleware — and its body must still carry an id a host can quote.
    const body = (await (await app().request('/nope')).json()) as { requestId: string };
    expect(body.requestId).toBe('req_generated');
  });
});

describe('the security headers (08 §3.8.4)', () => {
  it('sends every non-CSP header on every response', async () => {
    const response = await app().request('/healthz');
    for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
      expect(response.headers.get(name), name).toBe(value);
    }
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('sends the API policy for a JSON response, not the script policy', async () => {
    // The HTML policy advertises a nonce. On a document that has none, `'strict-dynamic'` is
    // decoration — and `08` §3.8.4 gives API responses their own two-directive policy for exactly
    // that reason.
    const response = await app().request('/healthz');
    expect(response.headers.get('Content-Security-Policy')).toBe(apiCsp("'none'"));
  });

  it('sends the script policy, with the nonce, for an HTML response', async () => {
    const built = app();
    built.get('/page', (c) => c.html('<p>hello</p>'));
    const response = await built.request('/page');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      htmlCsp('nonce-for-tests', { frameAncestors: "'none'", upgradeInsecure: false }),
    );
  });

  it('relaxes framing on the ingress listener and nowhere else', async () => {
    const ingress = await app({ ingress: true }).request('/healthz');
    expect(ingress.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(ingress.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'");
    // And the default is the safe direction: the cost of being wrong this way is a dashboard that
    // will not frame inside Home Assistant; the other way is every install being framable.
    const main = await app().request('/healthz');
    expect(main.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });

  it('sends HSTS only over HTTPS', async () => {
    // An HSTS header from `http://127.0.0.1` pins the browser to HTTPS for localhost, which breaks
    // every other local development server on the machine and cannot be undone server-side.
    expect((await app().request('/healthz')).headers.get('Strict-Transport-Security')).toBeNull();
    const https = await app({ https: true }).request('/healthz');
    expect(https.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    // `08` §3.8.4: no `preload` by default.
    expect(https.headers.get('Strict-Transport-Security')).not.toContain('preload');
  });

  it('mints a fresh nonce per request', async () => {
    // `'strict-dynamic'` makes the nonce the only thing that can start a script, so a nonce reused
    // across two responses is one an attacker who saw the first page can use on the second.
    const built = createHttpApp({
      logger: silentLogger,
      state: ready(),
      checks: [],
      maxBodyKb: 1,
      generateRequestId: () => 'req_generated',
      eventLoop: { p99Ms: () => 0 },
    });
    built.get('/page', (c) => c.html('<p>hello</p>'));
    const first = (await built.request('/page')).headers.get('Content-Security-Policy') ?? '';
    const second = (await built.request('/page')).headers.get('Content-Security-Policy') ?? '';
    expect(first).not.toBe(second);
  });
});

describe('caching (09 §3.2)', () => {
  it('sends no-store on /api and /control and not on an asset path', async () => {
    expect(needsNoStore('/api/v1/groups')).toBe(true);
    expect(needsNoStore('/control/v1/status')).toBe(true);
    // `/assets/*` is immutable and `max-age=31536000` on it is why the dashboard loads instantly
    // on a second visit. A blanket `no-store` would be a regression nobody would attribute to a
    // security header.
    expect(needsNoStore('/assets/index-abc123.js')).toBe(false);
  });

  it('overrides a handler that set its own Cache-Control on those paths', async () => {
    const built = app();
    built.get('/api/v1/thing', (c) => {
      c.header('Cache-Control', 'public, max-age=600');
      return c.json({ ok: true });
    });
    const response = await built.request('/api/v1/thing');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('the body limit (09 §3.2)', () => {
  it('refuses a body over api.maxBodyKb with problem+json, not a bare 413', async () => {
    const built = app({ maxBodyKb: 1 });
    built.post('/api/v1/thing', (c) => c.json({ ok: true }));
    const response = await built.request('/api/v1/thing', {
      method: 'POST',
      body: 'x'.repeat(2 * 1024),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(413);
    expect(response.headers.get('Content-Type')).toBe(PROBLEM_MEDIA_TYPE);
    const body = (await response.json()) as { code: string; detail: string };
    expect(body.code).toBe('payload_too_large');
    // The number is useful and contains nothing else, which is why `HTTPException`'s own message
    // is kept for client-caused statuses and replaced for the rest.
    expect(body.detail).toContain('1 KB');
  });

  it('accepts a body under the limit', async () => {
    const built = app({ maxBodyKb: 1 });
    built.post('/api/v1/thing', (c) => c.json({ ok: true }));
    const response = await built.request('/api/v1/thing', {
      method: 'POST',
      body: JSON.stringify({ a: 'x'.repeat(100) }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(200);
  });

  it('refuses a non-integer limit at construction', () => {
    // A `maxBodyKb` of `0` or `1.5` would silently refuse every request or round to something
    // nobody chose, and it would do it at the first POST rather than at boot.
    for (const maxBodyKb of [0, -1, 1.5]) {
      expect(() => app({ maxBodyKb }), String(maxBodyKb)).toThrow(/positive integer/);
    }
  });
});

describe('problem+json (09 §3.2.1)', () => {
  it('gives every code the status the table says', () => {
    // A `switch` with a `default` is a list that silently stops matching the type it switches on,
    // which is why the mapping is a total `Record` — and why this test enumerates the union rather
    // than spot-checking it.
    expect(PROBLEM_CODES).toHaveLength(20);
    for (const code of PROBLEM_CODES) {
      expect(problemStatus(code), code).toBeGreaterThanOrEqual(400);
      // `urn:<slug>:problem:<code>`, with the slug from `BRAND` so a rename stays one command —
      // `brand:check` forbids the literal here for the same reason `problemType` does not use one.
      expect(problemType(code), code).toBe(`urn:${BRAND.slug}:problem:${code}`);
    }
    expect(problemStatus('validation_failed')).toBe(400);
    expect(problemStatus('not_found')).toBe(404);
    expect(problemStatus('etag_required')).toBe(428);
    expect(problemStatus('internal')).toBe(500);
    expect(problemStatus('server_draining')).toBe(503);
  });

  it('turns a 404 into a problem rather than Hono’s text body', async () => {
    const response = await app().request('/nope');
    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toBe(PROBLEM_MEDIA_TYPE);
    const body = (await response.json()) as { code: string; instance: string };
    // Not 500: `classify` recognises `ProblemError` and sends everything it does not recognise to
    // `internal`, so a bespoke error class for the 404 would have turned every one into a bug.
    expect(body.code).toBe('not_found');
    expect(body.instance).toBe('/nope#req_generated');
  });

  it('reports an unrecognised throw as `internal`, with no detail from the error', async () => {
    const { logger, lines } = recordingLogger();
    const built = app({ logger });
    built.get('/api/v1/boom', () => {
      throw new Error('SELECT * FROM messages WHERE group_id = grp_01j…');
    });
    const response = await built.request('/api/v1/boom');
    expect(response.status).toBe(500);
    const text = await response.text();
    // The one place a SQL fragment, a file path or a provider's response body would reach a
    // client. `09` §3.2.1: "No stack trace; the error is logged with `requestId`".
    expect(text).not.toContain('SELECT');
    expect(text).toContain(INTERNAL_DETAIL);
    // And the log has it, joined by the request id.
    const logged = lines.find((line) => line.event === 'http.request_failed');
    expect(logged?.level).toBe('error');
    expect(logged?.fields?.detail).toMatchObject({ requestId: 'req_generated' });
  });

  it('logs a refusal at debug, not error', async () => {
    // A 404 or a 412 is the API working as specified. A line per one would bury the failures that
    // are not.
    const { logger, lines } = recordingLogger();
    await app({ logger }).request('/nope');
    const logged = lines.find((line) => line.event === 'http.request_refused');
    expect(logged?.level).toBe('debug');
  });

  it('keeps a ProblemError’s own detail and extras', async () => {
    const built = app();
    built.get('/api/v1/denied', () => {
      throw new ProblemError('policy_denied', 'The constitution does not allow that here.', {
        extra: { reason: 'capability_missing' },
      });
    });
    const response = await built.request('/api/v1/denied');
    expect(response.status).toBe(403);
    const body = (await response.json()) as { detail: string; reason: string };
    expect(body.detail).toBe('The constitution does not allow that here.');
    expect(body.reason).toBe('capability_missing');
  });

  it('puts the extra members at the top level, where RFC 9457 and §3.2.1 put them', async () => {
    // Not `{ extra: { reason } }`. `09` §3.2.1's example shows `errors[]` beside `detail`, and its
    // last column names `login`, `stepUp`, `reason`, `userMessage`, `current` and `retryAfter` —
    // the names a client reads off the body. Nesting them under one key made all of them
    // unreachable at the documented name while every status code and title still looked right.
    const built = app();
    built.get('/api/v1/stale', () => {
      throw new ProblemError('precondition_failed', 'That changed while you were editing.', {
        extra: { current: { version: 7 } },
      });
    });
    const body = (await (await built.request('/api/v1/stale')).json()) as Record<string, unknown>;
    expect(body['current']).toEqual({ version: 7 });
    expect(body).not.toHaveProperty('extra');
  });

  it('cannot be made to shadow a standard member through the extras', async () => {
    // `toProblem` spreads the extensions **before** the standard members, so this is structural
    // rather than a filter that could miss a name. A 200 body with `status: 200` on a denial, or a
    // `code` a client branches on that the server did not choose, are both worse than a missing
    // extension member — which is why the extras lose rather than being rejected: a throw inside
    // the error formatter would mean no response at all.
    const built = app();
    built.get('/api/v1/sneaky', () => {
      throw new ProblemError('policy_denied', 'No.', {
        extra: { status: 200, code: 'not_found', detail: 'nope', requestId: 'req_attacker' },
      });
    });
    const response = await built.request('/api/v1/sneaky');
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['status']).toBe(403);
    expect(body['code']).toBe('policy_denied');
    expect(body['detail']).toBe('No.');
    expect(body['requestId']).toBe('req_generated');
  });

  it('never caches a problem', async () => {
    // A 401 cached by a shared proxy would be served to the next person.
    const response = await app().request('/nope');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('the defaultHook, which is the half that does not throw (09 §3.2.1)', () => {
  it('turns a zod failure into validation_failed with a pointer per issue', async () => {
    // `@hono/zod-openapi` reports a validation failure by **calling the hook**, not by throwing.
    // A route that forgot to look would answer 200 with an unvalidated body — so the hook is wired
    // at the app's construction and this test exercises it through a route that actually
    // validates, which no production route does yet.
    const built = new OpenAPIHono({ defaultHook: problemDefaultHook });
    built.openapi(
      {
        method: 'get',
        path: '/thing',
        request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200) }) },
        responses: { 200: { description: 'ok' } },
      },
      (c) => c.json({ ok: true }),
    );
    const response = await built.request('/thing?limit=nope');
    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe(PROBLEM_MEDIA_TYPE);
    const body = (await response.json()) as {
      code: string;
      detail: string;
      errors: { pointer: string; code: string; message: string }[];
    };
    expect(body.code).toBe('validation_failed');
    expect(body.detail).toBe('One field needs attention.');
    // A JSON pointer, so a form can highlight the field.
    expect(body.errors[0]?.pointer).toBe('/limit');
    expect(body.errors[0]?.message).not.toBe('');
  });

  it('counts the fields, so the sentence agrees with the list', async () => {
    const built = new OpenAPIHono({ defaultHook: problemDefaultHook });
    built.openapi(
      {
        method: 'get',
        path: '/thing',
        request: {
          query: z.object({ a: z.coerce.number().int(), b: z.coerce.number().int() }),
        },
        responses: { 200: { description: 'ok' } },
      },
      (c) => c.json({ ok: true }),
    );
    const response = await built.request('/thing?a=x&b=y');
    const body = (await response.json()) as { detail: string; errors: unknown[] };
    expect(body.errors).toHaveLength(2);
    expect(body.detail).toBe('2 fields need attention.');
  });
});

describe('basePath (09 §5.1)', () => {
  it('normalises to the spec’s shape', () => {
    expect(normaliseBasePath(undefined)).toBe('');
    expect(normaliseBasePath('/')).toBe('');
    expect(normaliseBasePath('')).toBe('');
    // An arbitrary prefix, deliberately not the brand's own slug: `09` §5.1's `basePath` is
    // whatever the host's reverse proxy mounts this instance under, and a fixture that happened to
    // match the product name would read as if the two were related.
    expect(normaliseBasePath('/hub')).toBe('/hub');
    expect(normaliseBasePath('/hub/')).toBe('/hub');
    expect(normaliseBasePath('hub')).toBe('/hub');
  });
});

describe('loopback (12 §4.3)', () => {
  it('includes the IPv4-mapped form, which is what Node actually reports', () => {
    // A host reaching `http://localhost:7777` gets `::1` on a dual-stack machine, `127.0.0.1` on
    // an IPv4-only one, and `::ffff:127.0.0.1` when Node accepts an IPv4 connection on an IPv6
    // socket — which is the default. Omitting the mapped form is the mistake that shows the plain
    // status to `curl localhost/healthz` on exactly the machines where it matters.
    expect([...LOOPBACK_ADDRESSES]).toContain('::ffff:127.0.0.1');
    expect([...LOOPBACK_ADDRESSES]).toContain('127.0.0.1');
    expect([...LOOPBACK_ADDRESSES]).toContain('::1');
  });
});
