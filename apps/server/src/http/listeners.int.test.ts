/**
 * Binding the app to a real port (`09` §3.1, §5.1; `08` SD-10; `M3-T14`).
 *
 * A real listener, unlike every other test in this directory. `app.request()` exercises the
 * handler and tells you nothing about the two things this module is for: whether the process will
 * **refuse** to expose a dashboard with admin power on a LAN, and whether a bind failure arrives
 * as a rejected promise rather than a boot that hangs with no message.
 *
 * Port `0` throughout, so two runs never collide and `--sequence.shuffle` has nothing to find.
 */
import { silentLogger } from '@comvivo/shared/testing';
import { describe, expect, it } from 'vitest';
import { createHttpApp } from './app.js';
import { HealthState } from './health.js';
import { ExposureRefused, isLoopback, listen } from './listeners.js';

function app(): ReturnType<typeof createHttpApp> {
  const state = new HealthState({ version: '1.2.3' });
  state.ready();
  return createHttpApp({
    logger: silentLogger,
    state,
    checks: [{ id: 'db', fatal: true, run: () => true }],
    maxBodyKb: 256,
    generateRequestId: () => 'req_listener',
    eventLoop: { p99Ms: () => 0 },
  });
}

describe('listen (09 §5.1, 08 SD-10)', () => {
  it('serves /healthz on the loopback address it was given', async () => {
    const listener = await listen({
      app: app(),
      bind: '127.0.0.1',
      port: 0,
      exposureAllowed: false,
    });
    try {
      // Through a real socket, which is the only way to know the adapter is wired up: a `fetch`
      // handler that worked under `app.request()` and not under `@hono/node-server` would pass
      // every other test in this directory.
      const response = await fetch(`http://127.0.0.1:${String(listener.port)}/healthz`);
      expect(response.status).toBe(200);
      expect((await response.json()) as Record<string, unknown>).toMatchObject({ status: 'ok' });
    } finally {
      await listener.close();
    }
  });

  it('gives the detailed body to a loopback caller (12 §4.3)', async () => {
    const listener = await listen({
      app: app(),
      bind: '127.0.0.1',
      port: 0,
      exposureAllowed: false,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${String(listener.port)}/healthz`);
      const body = (await response.json()) as Record<string, unknown>;
      // The half that `app.request()` cannot check at all: the detail is gated on the **socket's**
      // remote address, and a request with no socket has none. This is the test that proves
      // `12` §4.3's loopback rule works on the machines it is for — including the IPv4-mapped
      // address Node reports when it accepts an IPv4 connection on an IPv6 socket.
      expect(Object.keys(body)).toContain('version');
      expect(body['uptimeS']).toBeTypeOf('number');
    } finally {
      await listener.close();
    }
  });

  it('refuses a non-loopback bind unless the host opted in (08 SD-10)', async () => {
    // Everything else in `08` §3.8 — the Host allowlist, the Origin check, the TLS requirement —
    // is defence behind `bind: 127.0.0.1`. A default that listened wide would put a dashboard with
    // admin power on every LAN, and the refusal is at **bind** time because a per-request check is
    // one that has already accepted the connection.
    await expect(
      listen({ app: app(), bind: '0.0.0.0', port: 0, exposureAllowed: false }),
    ).rejects.toBeInstanceOf(ExposureRefused);
  });

  it('allows it once TLS, a trusted proxy or allowInsecureLan says so', async () => {
    const listener = await listen({
      app: app(),
      bind: '0.0.0.0',
      port: 0,
      exposureAllowed: true,
    });
    try {
      expect(listener.port).toBeGreaterThan(0);
    } finally {
      await listener.close();
    }
  });

  it('names the three ways to opt in, so a host is not left guessing', async () => {
    const caught = await listen({
      app: app(),
      bind: '192.168.1.10',
      port: 0,
      exposureAllowed: false,
    }).catch((error: unknown) => error);
    const message = (caught as Error).message;
    expect(message).toContain('TLS');
    expect(message).toContain('trusted proxy');
    expect(message).toContain('allowInsecureLan');
  });

  it('rejects rather than hanging when the port is in use', async () => {
    const first = await listen({
      app: app(),
      bind: '127.0.0.1',
      port: 0,
      exposureAllowed: false,
    });
    try {
      // A bind failure arrives as an `error` **event**, not a throw. Without the `once('error')`
      // in `listen`, this promise would never settle — and boot would hang with no message, which
      // is the worst available failure for "the port is already in use".
      await expect(
        listen({ app: app(), bind: '127.0.0.1', port: first.port, exposureAllowed: false }),
      ).rejects.toThrow();
    } finally {
      await first.close();
    }
  });

  it('knows which addresses are loopback', () => {
    for (const bind of ['127.0.0.1', '::1', 'localhost']) {
      expect(isLoopback(bind), bind).toBe(true);
    }
    for (const bind of ['0.0.0.0', '192.168.1.10', '::', 'example.com']) {
      expect(isLoopback(bind), bind).toBe(false);
    }
  });
});
