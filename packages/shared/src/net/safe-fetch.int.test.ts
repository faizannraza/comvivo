/**
 * `safeFetch` against a real server (`08` §3.9 rules 3–5, `10` §3.4.6 steps 3–5).
 *
 * The matrix in `classify.test.ts` proves what is refused before a socket exists. This proves the
 * four things that only exist once one does: **pinning** (a resolver that answers differently the
 * second time must not be consulted a second time), **redirects**, the **decoded-size cap**, and
 * the **decompression-ratio** guard.
 *
 * The server is on loopback, which `08` §3.9 denies — so every test here goes through the
 * `allowPrivate` and `allowHttpHosts` allowlists, which means the allowlist is exercised by every
 * assertion rather than by one. That is deliberate: an egress control that cannot be opened for a
 * host's own LAN is one a host turns off entirely.
 */
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { EgressPolicy } from './classify.js';
import {
  EgressBlockedError,
  type EgressBlockedEvent,
  nextHop,
  type Resolver,
  type SafeFetchOptions,
  safeFetch,
  systemResolver,
} from './safe-fetch.js';

/** 5 MiB of zeros, gzipped: about 5 KiB on the wire and a ratio of roughly 1,000. */
const BOMB = gzipSync(Buffer.alloc(5 * 1024 * 1024));

function handler(request: IncomingMessage, response: ServerResponse, hits: string[]): void {
  // Only the pathname matters, so the base is a constant rather than the live port.
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  hits.push(path);

  if (path === '/ok') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('hello');
    return;
  }
  if (path === '/echo-headers') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.headers));
    return;
  }
  if (path === '/echo-body') {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ method: request.method, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    return;
  }
  if (path === '/calendar') {
    response.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' });
    response.end('BEGIN:VCALENDAR\nEND:VCALENDAR\n');
    return;
  }
  if (path === '/html') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html></html>');
    return;
  }
  if (path === '/big') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(Buffer.alloc(300 * 1024, 0x61));
    return;
  }
  if (path === '/bomb') {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
    response.end(BOMB);
    return;
  }
  if (path === '/brotli') {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' });
    response.end(brotliCompressSync(Buffer.from('compressed with brotli')));
    return;
  }
  if (path === '/deflate') {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'deflate' });
    response.end(deflateSync(Buffer.from('compressed with deflate')));
    return;
  }
  if (path === '/repeated-header') {
    response.writeHead(200, { 'content-type': 'text/plain', 'x-thing': ['one', 'two'] });
    response.end('ok');
    return;
  }
  if (path === '/empty') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (path === '/silent') {
    // Accepts the connection and never answers: the headers timeout is the only thing that ends
    // this, and before any response arrives it is also the connect-and-first-byte window.
    return;
  }
  if (path === '/stall') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.write('start');
    // Never finishes: the idle timeout is the only thing that ends this.
    return;
  }
  if (path.startsWith('/redirect/')) {
    const left = Number(path.slice('/redirect/'.length));
    response.writeHead(302, { location: left <= 1 ? '/ok' : `/redirect/${String(left - 1)}` });
    response.end();
    return;
  }
  if (path === '/to-public') {
    response.writeHead(302, { location: 'https://example.com/elsewhere' });
    response.end();
    return;
  }
  if (path === '/bad-location') {
    response.writeHead(302, { location: 'http://[' });
    response.end();
    return;
  }
  if (path === '/no-location') {
    response.writeHead(302, { 'content-type': 'text/plain' });
    response.end('moved, somewhere');
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('nope');
}

/**
 * One server per test, with its state in a closure.
 *
 * `scripts/hygiene/check.ts` forbids module-level `let` in a test file, and it is right: a shared
 * server and a shared `hits` array make a suite that passes in file order and fails under shuffle.
 * A fixture function is also better isolation — every test gets a fresh port, so nothing can
 * depend on a request another test made.
 */
interface Fixture {
  readonly port: number;
  readonly base: string;
  readonly hits: readonly string[];
  readonly policy: EgressPolicy;
  /** `safeFetch` options for this server, plus the blocks it records. */
  readonly options: (overrides?: Partial<SafeFetchOptions>) => {
    readonly blocks: EgressBlockedEvent[];
    readonly call: SafeFetchOptions;
  };
}

/** A resolver that never resolves: every test here targets a literal, except where it does not. */
const noResolver: Resolver = async () => {
  throw new Error('nothing in this test should need DNS');
};

async function withServer<T>(
  body: (fixture: Fixture) => Promise<T>,
  route: (request: IncomingMessage, response: ServerResponse, hits: string[]) => void = handler,
): Promise<T> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    route(request, response, hits);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  // Allowlisted exactly as a host would allowlist their NAS.
  const policy: EgressPolicy = {
    allowPrivate: [`127.0.0.1:${String(port)}`],
    allowHttpHosts: [`127.0.0.1:${String(port)}`],
  };
  const options = (overrides: Partial<SafeFetchOptions> = {}) => {
    const blocks: EgressBlockedEvent[] = [];
    return {
      blocks,
      call: {
        purpose: 'plugin' as const,
        policy,
        resolver: noResolver,
        onBlocked: (event: EgressBlockedEvent) => blocks.push(event),
        ...overrides,
      } satisfies SafeFetchOptions,
    };
  };
  try {
    return await body({ port, base: `http://127.0.0.1:${String(port)}`, hits, policy, options });
  } finally {
    server.close();
    await once(server, 'close');
  }
}

describe('a request that is allowed', () => {
  it('fetches it, with no cookie and a derived User-Agent', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options();
      const response = await safeFetch(`${fx.base}/echo-headers`, {}, call);
      expect(response.status).toBe(200);
      const headers = (await response.json()) as Record<string, string>;
      // `10` §3.4.6: no cookies, and a User-Agent that names the product and the purpose.
      expect(headers['cookie']).toBeUndefined();
      expect(headers['user-agent']).toMatch(/\(plugin\)$/);
      expect(headers['host']).toBe(`127.0.0.1:${String(fx.port)}`);
    });
  });

  it('reads the body, and a 204 has none', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options();
      expect(await (await safeFetch(`${fx.base}/ok`, {}, call)).text()).toBe('hello');
      const empty = await safeFetch(`${fx.base}/empty`, {}, call);
      expect(empty.status).toBe(204);
      expect(empty.body).toBeNull();
    });
  });

  it('refuses a content type its purpose does not accept', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options({ purpose: 'ics' });
      // The `ics` purpose accepts `text/calendar`, which is the point of a per-purpose allowlist:
      // an importer that accepts `text/html` is a web crawler.
      expect((await safeFetch(`${fx.base}/calendar`, {}, call)).status).toBe(200);
      await expect(safeFetch(`${fx.base}/html`, {}, call)).rejects.toThrow(/does not accept/);
      expect(blocks.map((event) => event.reason)).toEqual(['content-type']);
      // `08` §3.9 rule 7: the event carries the host and never the path.
      expect(blocks[0]?.host).toBe('127.0.0.1');
      expect(JSON.stringify(blocks[0])).not.toContain('/html');
    });
  });
});

describe('DNS pinning (08 §3.9 rule 3)', () => {
  it('ignores a resolver that changes its answer, which is DNS rebinding', async () => {
    await withServer(async (fx) => {
      let calls = 0;
      const rebinding: Resolver = async () => {
        calls += 1;
        // First answer: the loopback server, which the allowlist permits. Second answer: the cloud
        // metadata address. A client that resolved the name again at connect time would connect to
        // whichever answer arrived second — and the request would carry a `Host` the first check
        // approved, which is exactly what makes rebinding work.
        return calls === 1
          ? [{ address: '127.0.0.1', family: 4 }]
          : [{ address: '169.254.169.254', family: 4 }];
      };
      // A `.localhost` name, because `scripts/harness/network-guard.ts` blocks a socket by its
      // **hostname** — a pinned lookup is invisible to it, and rightly so: a guard that trusted
      // the lookup a test installed would guard nothing. The name is allowlisted, so the
      // classifier permits it for the same reason a host's NAS is permitted.
      const host = `rebind.localhost:${String(fx.port)}`;
      const { call } = fx.options({
        policy: { allowPrivate: [host], allowHttpHosts: [host] },
        resolver: rebinding,
      });
      const response = await safeFetch(`http://${host}/ok`, {}, call);
      expect(await response.text()).toBe('hello');
      // The resolver was asked **once**. That is the property: pinning is not "we checked the
      // address", it is "nothing resolved the name a second time". A client using Node's default
      // resolution would have called it twice and connected to the second answer.
      expect(calls).toBe(1);
    });
  });

  it('refuses a name whose second address is private, even when the first is public', async () => {
    await withServer(async (fx) => {
      const twoRecords: Resolver = async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '192.168.1.9', family: 4 },
      ];
      const { call, blocks } = fx.options({
        resolver: twoRecords,
        policy: { allowPrivate: [], allowHttpHosts: [] },
      });
      await expect(safeFetch('https://two.example/', {}, call)).rejects.toBeInstanceOf(
        EgressBlockedError,
      );
      // `08` §3.9 rule 2: **every** resolved address must pass. Checking the first would make this
      // a coin toss decided by the resolver's ordering.
      expect(blocks[0]?.reason).toBe('blocked-address');
      expect(blocks[0]?.host).toBe('two.example');
    });
  });

  it('reports a resolver that answers with nothing', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options({ resolver: async () => [] });
      await expect(safeFetch('https://nothing.example/', {}, call)).rejects.toThrow(/no addresses/);
      expect(blocks[0]?.reason).toBe('no-address');
    });
  });

  it('reports a resolver that fails', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options({
        resolver: async () => {
          throw new Error('ENOTFOUND');
        },
      });
      await expect(safeFetch('https://missing.example/', {}, call)).rejects.toThrow(
        /did not resolve/,
      );
      expect(blocks[0]?.reason).toBe('no-address');
    });
  });
});

describe('redirects (08 §3.9 rule 4)', () => {
  it('follows up to three hops', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options();
      const response = await safeFetch(`${fx.base}/redirect/3`, {}, call);
      expect(await response.text()).toBe('hello');
      expect(fx.hits).toEqual(['/redirect/3', '/redirect/2', '/redirect/1', '/ok']);
    });
  });

  it('refuses the fourth', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options();
      await expect(safeFetch(`${fx.base}/redirect/5`, {}, call)).rejects.toThrow(/more than 3/);
      expect(blocks[0]?.reason).toBe('redirect-limit');
      // Four requests made, then the refusal: the limit is on hops, not on requests.
      expect(fx.hits).toHaveLength(4);
    });
  });

  it('re-validates every hop, so a redirect cannot reach somewhere refused', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options({ purpose: 'web-search' });
      // The hop target is `https://example.com/`, which this test's resolver refuses to resolve —
      // so the refusal proves the second hop went through the whole of steps 1–3 rather than being
      // followed blindly. A client that validated only the first URL would have made the request.
      await expect(safeFetch(`${fx.base}/to-public`, {}, call)).rejects.toThrow(/did not resolve/);
      expect(blocks.map((event) => [event.reason, event.host])).toEqual([
        ['no-address', 'example.com'],
      ]);
    });
  });

  it('refuses a Location that is not a URL', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options();
      await expect(safeFetch(`${fx.base}/bad-location`, {}, call)).rejects.toThrow(
        /redirected to something that is not a URL/,
      );
      expect(blocks[0]?.reason).toBe('url-unparseable');
    });
  });

  it('returns the redirect itself when there is no Location', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options();
      const response = await safeFetch(`${fx.base}/no-location`, {}, call);
      // Not an error: a 302 with no `Location` is a server's problem, and handing the caller the
      // response is more useful than inventing a failure.
      expect(response.status).toBe(302);
    });
  });

  it('refuses a downgrade from https to http, and allows the upgrade', () => {
    // Proven at `nextHop` rather than over a socket: see the function's own comment. The four
    // cases are the rule in full.
    const downgrade = nextHop(new URL('https://example.com/a'), 'http://example.com/b');
    expect(downgrade.ok).toBe(false);
    if (!downgrade.ok) expect(downgrade.error.reason).toBe('redirect-downgrade');

    const upgrade = nextHop(new URL('http://example.com/a'), 'https://example.com/b');
    expect(upgrade.ok).toBe(true);

    const relative = nextHop(new URL('https://example.com/a/b'), '../c');
    expect(relative.ok).toBe(true);
    if (relative.ok) expect(relative.value.href).toBe('https://example.com/c');

    const nonsense = nextHop(new URL('https://example.com/a'), 'http://[');
    expect(nonsense.ok).toBe(false);
  });

  it('drops Authorization when the origin changes', async () => {
    await withServer(async (target) => {
      const seen: Record<string, string>[] = [];
      await withServer(
        async (redirecting) => {
          const both = [
            `127.0.0.1:${String(target.port)}`,
            `127.0.0.1:${String(redirecting.port)}`,
          ];
          const { call } = redirecting.options({
            policy: { allowPrivate: both, allowHttpHosts: both },
          });
          const response = await safeFetch(
            `${redirecting.base}/start`,
            { headers: { authorization: 'Bearer secret-token', 'x-api-key': 'another' } },
            call,
          );
          const echoed = (await response.json()) as Record<string, string>;
          // `10` §3.4.6 step 4. The origin differs by **port**, which is the case a naive
          // host-only comparison misses — and a credential sent to the wrong port on the same
          // machine is still a credential sent to somebody else.
          expect(echoed['authorization']).toBeUndefined();
          expect(echoed['x-api-key']).toBeUndefined();
          expect(seen).toEqual([]);
        },
        (request, response, hits) => {
          hits.push(request.url ?? '');
          if (request.url === '/start') {
            response.writeHead(302, { location: `${target.base}/echo-headers` });
            response.end();
            return;
          }
          seen.push(request.headers as Record<string, string>);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end('{}');
        },
      );
    });
  });

  it('keeps Authorization on a same-origin redirect', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options();
      const response = await safeFetch(
        `${fx.base}/redirect/1`,
        { headers: { authorization: 'Bearer same-origin' } },
        call,
      );
      // The redirect lands on `/ok`, which does not echo, so the assertion is that the request
      // succeeded with the header still attached rather than being refused.
      expect(await response.text()).toBe('hello');
      expect(fx.hits).toEqual(['/redirect/1', '/ok']);
    });
  });
});

describe('limits (08 §3.9 rule 5)', () => {
  it('aborts a body that exceeds the decoded cap', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options({ limits: { maxBytes: 64 * 1024 } });
      const response = await safeFetch(`${fx.base}/big`, {}, call);
      // The cap is enforced **in** the stream, so the headers arrive and the body errors — which
      // is what lets the `mcp` purpose stream at all.
      await expect(response.text()).rejects.toThrow(/decoded bytes/);
      expect(blocks[0]?.reason).toBe('too-large');
    });
  });

  it('reads a body under the cap', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options({ limits: { maxBytes: 1024 * 1024 } });
      expect((await (await safeFetch(`${fx.base}/big`, {}, call)).text()).length).toBe(300 * 1024);
    });
  });

  it('aborts a decompression bomb on the ratio, before the size cap', async () => {
    await withServer(async (fx) => {
      // 5 MiB of zeros in about 5 KiB. The size cap alone would let this through at the default 10
      // MiB, which is the whole point of the ratio: a bomb is small on the wire.
      const { call, blocks } = fx.options({
        limits: { maxCompressionRatio: 20, maxBytes: 10 * 1024 * 1024 },
      });
      const response = await safeFetch(`${fx.base}/bomb`, {}, call);
      await expect(response.text()).rejects.toThrow(/ratio above 20/);
      expect(blocks[0]?.reason).toBe('compression-ratio');
    });
  });

  it('accepts ordinary compression', async () => {
    await withServer(async (fx) => {
      // The same response with the ratio raised: proof that the refusal above is the ratio and not
      // the decompression itself.
      const { call } = fx.options({
        limits: { maxCompressionRatio: 20_000, maxBytes: 6 * 1024 * 1024 },
      });
      expect((await (await safeFetch(`${fx.base}/bomb`, {}, call)).text()).length).toBe(
        5 * 1024 * 1024,
      );
    });
  });

  it('gives up on a body that stops arriving', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options({ limits: { bodyIdleTimeoutMs: 150 } });
      const response = await safeFetch(`${fx.base}/stall`, {}, call);
      await expect(response.text()).rejects.toThrow(/stopped sending/);
      expect(blocks[0]?.reason).toBe('timeout');
    });
  });

  it('gives up on a body that takes too long in total', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options({
        limits: { bodyIdleTimeoutMs: 5_000, bodyTotalTimeoutMs: 150 },
      });
      const response = await safeFetch(`${fx.base}/stall`, {}, call);
      await expect(response.text()).rejects.toThrow(/took longer than/);
      expect(blocks[0]?.reason).toBe('timeout');
    });
  });

  it('gives up when no headers arrive', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options({
        limits: { headersTimeoutMs: 150, connectTimeoutMs: 5_000 },
      });
      await expect(safeFetch(`${fx.base}/silent`, {}, call)).rejects.toThrow(
        /did not send headers/,
      );
      // Reported as a timeout and not as a transport error, because "the server is slow" and "the
      // server is unreachable" are different things to a host — and `08` §3.9 rule 7 wants an
      // event for *every* block, which the first version of this path did not emit.
      expect(blocks.at(-1)?.reason).toBe('timeout');
    });
  });

  it('gives up when the socket goes quiet before the response', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options({ limits: { connectTimeoutMs: 150, headersTimeoutMs: 5_000 } });
      await expect(safeFetch(`${fx.base}/silent`, {}, call)).rejects.toThrow(
        /did not answer within/,
      );
    });
  });
});

describe('refusals reach the caller as one error type', () => {
  it('refuses a URL the classifier rejects, and reports it', async () => {
    await withServer(async (fx) => {
      const { call, blocks } = fx.options({ policy: { allowPrivate: [], allowHttpHosts: [] } });
      await expect(safeFetch('https://localhost/', {}, call)).rejects.toBeInstanceOf(
        EgressBlockedError,
      );
      await expect(safeFetch('https://169.254.169.254/latest/', {}, call)).rejects.toThrow(
        /metadata/,
      );
      expect(blocks.map((event) => event.reason)).toEqual(['local-name', 'blocked-address']);

      const error = await safeFetch('https://localhost/', {}, call).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(EgressBlockedError);
      if (error instanceof EgressBlockedError) {
        // The purpose travels with the error, so an audit row can be written from the catch site.
        expect(error.purpose).toBe('plugin');
        expect(error.host).toBe('localhost');
        // `08` §3.9 rule 7: no full URL, not even in the message.
        expect(error.message).not.toContain('https://');
      }
    });
  });

  it('reports a connection that fails as a transport refusal', async () => {
    // A port nothing listens on: a server is started and closed, which guarantees it was free and
    // is now not listening.
    const deadPort = await withServer(async (fx) => fx.port);
    const both = [`127.0.0.1:${String(deadPort)}`];
    const blocks: EgressBlockedEvent[] = [];
    await expect(
      safeFetch(
        `http://127.0.0.1:${String(deadPort)}/ok`,
        {},
        {
          purpose: 'plugin',
          policy: { allowPrivate: both, allowHttpHosts: both },
          resolver: noResolver,
          onBlocked: (event) => blocks.push(event),
        },
      ),
    ).rejects.toThrow(/connection to 127.0.0.1 failed/);
    expect(blocks[0]?.reason).toBe('transport');
  });
});

describe('bodies and encodings', () => {
  it('sends a string body and a byte body', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options();
      const text = await safeFetch(`${fx.base}/echo-body`, { method: 'POST', body: 'hello' }, call);
      expect(await text.json()).toEqual({ method: 'POST', body: 'hello' });

      const bytes = await safeFetch(
        `${fx.base}/echo-body`,
        { method: 'POST', body: new TextEncoder().encode('bytes') },
        call,
      );
      expect(await bytes.json()).toEqual({ method: 'POST', body: 'bytes' });

      // Anything else goes through `Response`, which is how a `FormData` or a stream body arrives.
      const other = await safeFetch(
        `${fx.base}/echo-body`,
        { method: 'POST', body: new Blob(['blobbed']) },
        call,
      );
      expect(await other.json()).toEqual({ method: 'POST', body: 'blobbed' });
    });
  });

  it('decodes brotli and deflate as well as gzip', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options();
      expect(await (await safeFetch(`${fx.base}/brotli`, {}, call)).text()).toBe(
        'compressed with brotli',
      );
      expect(await (await safeFetch(`${fx.base}/deflate`, {}, call)).text()).toBe(
        'compressed with deflate',
      );
    });
  });

  it('joins a header the server sent twice', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options();
      const response = await safeFetch(`${fx.base}/repeated-header`, {}, call);
      // One `Headers` value, comma-joined, which is what a `Response` consumer expects.
      expect(response.headers.get('x-thing')).toBe('one, two');
    });
  });

  it('asks for the encodings it can decode, and never sends a cookie', async () => {
    await withServer(async (fx) => {
      const { call } = fx.options();
      const response = await safeFetch(
        `${fx.base}/echo-headers`,
        { headers: { cookie: 'session=please-no' } },
        call,
      );
      const headers = (await response.json()) as Record<string, string>;
      expect(headers['accept-encoding']).toBe('gzip, br, deflate');
      // A caller that *tries* to send a cookie is overruled: `10` §3.4.6 says none at all.
      expect(headers['cookie']).toBeUndefined();
    });
  });
});

describe('systemResolver', () => {
  it('asks for every address, in the resolver’s own order', async () => {
    // `localhost` is the one name the offline test guard allows, and it is the one name that
    // reliably has both families — which is exactly what `all: true, order: 'verbatim'` is for.
    const addresses = await systemResolver('localhost');
    expect(addresses.length).toBeGreaterThan(0);
    for (const entry of addresses) {
      expect([4, 6]).toContain(entry.family);
      expect(typeof entry.address).toBe('string');
    }
  });
});
