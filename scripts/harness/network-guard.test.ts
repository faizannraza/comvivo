/**
 * The test harness's own guarantees, tested. `11` §3.1.1 says tiers L1–L4 run offline; a guard
 * that is never exercised is a guard that quietly stops working after a refactor.
 *
 * The guard lives in `vitest.setup.ts` and patches `net.Socket.prototype.connect`, so it applies to
 * every HTTP client in the tree rather than only to the one we remembered to intercept.
 */
import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { isLoopback } from './network-guard.js';

describe('the network guard', () => {
  it('blocks a connection to a public host', () => {
    const socket = new net.Socket();
    expect(() => socket.connect({ host: 'example.com', port: 443 })).toThrow(
      /Network access blocked in tests/,
    );
    socket.destroy();
  });

  it('blocks a connection given host as a positional argument', () => {
    const socket = new net.Socket();
    expect(() => socket.connect(443, 'api.anthropic.com')).toThrow(
      /Network access blocked in tests/,
    );
    socket.destroy();
  });

  it('names the host in the message, so the failure is actionable', () => {
    const socket = new net.Socket();
    expect(() => socket.connect({ host: 'registry.npmjs.org', port: 443 })).toThrow(
      /registry\.npmjs\.org/,
    );
    socket.destroy();
  });

  it('points at the escape hatch rather than just refusing', () => {
    const socket = new net.Socket();
    expect(() => socket.connect({ host: 'example.com', port: 80 })).toThrow(
      /COMVIVO_ALLOW_NETWORK=1/,
    );
    socket.destroy();
  });

  it('allows a real loopback round trip, which is what integration tests need', async () => {
    // Asserting "does not throw" would also pass if the patch broke connect entirely, so this
    // actually listens and connects.
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.on('connect', () => {
          socket.end();
          resolve();
        });
        socket.on('error', reject);
      });
    } finally {
      server.close();
    }
  });

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
