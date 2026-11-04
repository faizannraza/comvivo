/**
 * The test harness's own guarantees, tested. `11` §3.1.1 says tiers L1–L4 run offline; a guard
 * that is never exercised is a guard that quietly stops working after a refactor.
 *
 * The guard lives in `vitest.setup.ts`. There is no single interception point: it patches the
 * socket prototype, `net.connect`, `net.createConnection` and DNS resolution, because the first
 * version patched only the prototype and `node:http`, `net.connect` and `node:dns` went straight
 * past it.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, describe, expect, it } from 'vitest';
import { isLoopback } from './network-guard.js';

/**
 * These tests go through the door a **caller** uses, not the function the guard patches.
 *
 * The first version of this file only ever called `new net.Socket().connect(...)` — the exact
 * shape the guard happened to patch — and its one "real loopback round trip" test used
 * `net.createConnection`, which was not guarded at all, so that test would have passed with the
 * guard deleted. The M0 independent review measured the consequence: `net.connect`,
 * `net.createConnection`, every `node:http` client and the whole of `node:dns` reached the real
 * internet from inside a unit test.
 *
 * So each case below is an ordinary way to make a request. If the guard regresses, one of these
 * fails rather than quietly passing.
 */
describe('the network guard blocks every way out', () => {
  const FAR = '1.1.1.1';

  /** Attempt an egress and report whether it was refused. */
  const attempt = async (fn: () => void | Promise<void>): Promise<string> => {
    try {
      await fn();
      return 'not blocked';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  it.each([
    [
      'new Socket().connect(port, host)',
      () => {
        new net.Socket().connect(443, FAR);
      },
    ],
    [
      'new Socket().connect({ host })',
      () => {
        new net.Socket().connect({ host: FAR, port: 443 });
      },
    ],
    [
      'net.connect(port, host)',
      () => {
        net.connect(443, FAR);
      },
    ],
    [
      'net.connect({ host })',
      () => {
        net.connect({ host: FAR, port: 443 });
      },
    ],
    [
      'net.createConnection(port, host)',
      () => {
        net.createConnection(443, FAR);
      },
    ],
    [
      'net.createConnection({ host })',
      () => {
        net.createConnection({ host: FAR, port: 443 });
      },
    ],
    [
      'http.get',
      () => {
        http.get(`http://${FAR}/`);
      },
    ],
    [
      'https.get',
      () => {
        https.get(`https://${FAR}/`);
      },
    ],
    [
      'tls.connect',
      () => {
        tls.connect({ host: FAR, port: 443 });
      },
    ],
  ])('refuses %s', async (_label, fn) => {
    expect(await attempt(fn)).toMatch(/Network access blocked in tests/);
  });

  it('refuses fetch, which is the one route that always worked', async () => {
    // undici builds a Socket and calls `.connect()`, so this was covered even by the broken
    // version. It is the reason the gap survived: the client everybody actually used took the
    // guarded path.
    //
    // undici reports its own `fetch failed` and carries the real reason in `cause`, so the
    // assertion follows the chain rather than being loosened to "it threw" — which would also
    // pass if the host were merely unreachable.
    let caught: unknown;
    try {
      await fetch(`https://${FAR}/`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const causes: string[] = [];
    for (let error: unknown = caught; error instanceof Error; error = error.cause) {
      causes.push(error.message);
    }
    expect(causes.join(' | ')).toMatch(/Network access blocked in tests/);
  });

  it.each([
    [
      'dns.resolve4',
      () =>
        new Promise<void>((resolve, reject) => {
          dns.resolve4('example.com', (error) => (error ? reject(error) : resolve()));
        }),
    ],
    [
      'dns.lookup',
      () =>
        new Promise<void>((resolve, reject) => {
          dns.lookup('example.com', (error) => (error ? reject(error) : resolve()));
        }),
    ],
    [
      'dns.promises.resolve4',
      async () => {
        await dns.promises.resolve4('example.com');
      },
    ],
    [
      'new dns.Resolver().resolve4',
      () =>
        new Promise<void>((resolve, reject) => {
          new dns.Resolver().resolve4('example.com', (error) =>
            error ? reject(error) : resolve(),
          );
        }),
    ],
  ])('refuses %s', async (_label, fn) => {
    // A name lookup is outbound traffic in its own right, and it leaks the hostname being looked
    // up even when the connection that would follow is blocked.
    expect(await attempt(fn)).toMatch(/Network access blocked in tests/);
  });

  it('names the host in the message, so the failure is actionable', async () => {
    expect(
      await attempt(() => {
        http.get('http://api.telegram.org/');
      }),
    ).toContain('api.telegram.org');
  });

  it('points at the escape hatch rather than just refusing', async () => {
    const message = await attempt(() => {
      net.connect(443, FAR);
    });
    expect(message).toMatch(/`live` tag/);
    expect(message).toMatch(/COMVIVO_ALLOW_NETWORK=1/);
  });
});

describe('the network guard still allows loopback', () => {
  it('allows a TCP round trip through createConnection', async () => {
    // Deliberately `createConnection` rather than `new Socket()`: this is the call integration
    // tests actually make, and it is the one that used to be unguarded.
    const server = net.createServer((socket) => socket.end('hi'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const client = net.createConnection({ host: '127.0.0.1', port });
        let buffer = '';
        client.on('data', (chunk) => {
          buffer += String(chunk);
        });
        client.on('end', () => resolve(buffer));
        client.on('error', reject);
      });
      expect(body).toBe('hi');
    } finally {
      server.close();
    }
  });

  it('allows an HTTP round trip to localhost by name', async () => {
    // `localhost` is not an IP literal, so this exercises the DNS patch as well: resolving a
    // loopback name has to keep working or every integration test that binds a server breaks.
    const server = http.createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(`http://localhost:${String(port)}/`, (response) => {
            let buffer = '';
            response.on('data', (chunk) => {
              buffer += String(chunk);
            });
            response.on('end', () => resolve(buffer));
          })
          .on('error', reject);
      });
      expect(body).toBe('ok');
    } finally {
      server.close();
    }
  });

  it('allows resolving localhost', async () => {
    await expect(dns.promises.lookup('localhost')).resolves.toBeDefined();
  });
});

describe('the network guard', () => {
  describe('the loopback predicate', () => {
    it.each([
      '127.0.0.1',
      '127.0.0.53', // systemd-resolved
      '127.1.2.3',
      'localhost',
      'db.localhost',
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '::ffff:127.0.0.1',
      '0.0.0.0',
      'LOCALHOST',
    ])('treats %s as local', (host) => {
      expect(isLoopback(host)).toBe(true);
    });

    it.each([
      'example.com',
      'api.anthropic.com',
      '8.8.8.8',
      '128.0.0.1', // one bit outside 127/8
      'localhost.evil.com', // the attack this predicate must not fall for
      '[2606:4700::1111]',
      '169.254.169.254', // cloud metadata
    ])('treats %s as remote', (host) => {
      expect(isLoopback(host)).toBe(false);
    });

    it('allows a call with no hostname at all, which is a unix socket or an fd', () => {
      expect(isLoopback(undefined)).toBe(true);
    });
  });
});

describe('environment pinning', () => {
  it('runs in UTC, so date logic cannot pass only in the author timezone', () => {
    expect(process.env['TZ']).toBe('UTC');
    expect(new Date('2026-07-01T12:00:00Z').getHours()).toBe(12);
  });

  it('sets the test-mode flag the server uses to refuse stubs outside dev and test', () => {
    expect(process.env['COMVIVO_TEST_MODE']).toBe('1');
  });

  it('does not leak a network allowance into the default run', () => {
    expect(process.env['COMVIVO_ALLOW_NETWORK']).toBeUndefined();
  });
});

describe('tags', () => {
  it('accepts a tag that is declared in the config', { tags: ['slow'] }, () => {
    // `strictTags` defaults to true in Vitest 5, so an undeclared tag here would fail the file.
    // That is the point: a mistyped tag would otherwise silently match no filter and quietly drop
    // the test out of every targeted run.
    expect(true).toBe(true);
  });

  it('gives the slow tag its longer timeout', { tags: ['slow'] }, ({ task }) => {
    expect(task.timeout).toBe(30_000);
  });
});

afterAll(() => {
  // Nothing to tear down; present so a future contributor sees where cleanup goes.
});
