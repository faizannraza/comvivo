/**
 * Binding the HTTP app to a port (`09` §3.1, §3.9.10; `12` §3.5; `M3-T14`).
 *
 * ## Loopback is the default, and that is a security decision
 *
 * `08` SD-10 and `09` §5.1: `dashboard.bind` is `127.0.0.1`. Everything else in `08` §3.8 — the
 * Host allowlist, the Origin check, the TLS requirement for non-loopback — is defence behind that
 * one line, and a default of `0.0.0.0` would put a dashboard with admin power on every LAN. The
 * Docker image sets `COMVIVO_DASHBOARD_BIND=0.0.0.0` *inside the container*, where the container's
 * own port mapping is the boundary.
 *
 * So `listen` refuses to bind a non-loopback address unless the host has said so — through TLS, a
 * trusted proxy, or `allowInsecureLan`. The refusal is at **bind time** rather than per request,
 * because a per-request check is a check that has already accepted the connection.
 *
 * ## The second listener
 *
 * Home Assistant's Supervisor reaches the add-on on its own port with its own source address
 * (`09` §3.9.10, `12` §3.5). It is a separate listener rather than a path on the first, because
 * `08` §3.8.4 gives it a different header set and `09` §3.1 gives it different middleware — and a
 * single listener serving both would make that difference a per-request branch in security code.
 */
import { createServer, type Server } from 'node:http';
import { serve } from '@hono/node-server';
import type { Env, Hono } from 'hono';

/** `08` SD-10's loopback addresses, which need no further opt-in. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

export function isLoopback(bind: string): boolean {
  return LOOPBACK.has(bind);
}

export interface ListenOptions {
  /**
   * `Hono<Env>`, not bare `Hono`. `Hono`'s own default type parameter is `BlankEnv` while
   * `OpenAPIHono`'s is `Env`, so the plain spelling rejects the very app `createHttpApp` returns —
   * and only when a test or the boot path actually passes one, which is a typecheck that passes
   * per-package and fails on the whole tree.
   */
  readonly app: Hono<Env>;
  readonly bind: string;
  readonly port: number;
  /** `dashboard.tls`, `trustProxy` or `allowInsecureLan` — any one permits a wider bind. */
  readonly exposureAllowed: boolean;
  /** Injected so a test can listen without `node:http`. */
  readonly createListener?: typeof serve;
}

export interface Listener {
  readonly server: Server;
  /** The port actually bound, which differs from `port` when `0` was asked for. */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Why a bind was refused, as a sentence a host can act on.
 *
 * Its own error class rather than a `ProblemError`, because nothing is serving yet: this happens
 * during `12` §3.8.1's boot and the process exits **78** (configuration) — a host has to change
 * something before another start can work, and an orchestrator that retried would loop.
 */
export class ExposureRefused extends Error {
  readonly bind: string;
  constructor(bind: string) {
    super(
      `Refusing to listen on ${bind}: a dashboard reachable from the network needs TLS, a ` +
        'trusted proxy, or an explicit `dashboard.allowInsecureLan: true`.',
    );
    this.name = 'ExposureRefused';
    this.bind = bind;
  }
}

/**
 * Bind the app.
 *
 * `@hono/node-server`'s `serve` with an explicit `createServer`, so the returned handle is a real
 * `node:http` server: `12` §3.8's graceful shutdown needs `close()` and the drain that goes with
 * it, and the adapter's own return value is enough for neither.
 */
export async function listen(options: ListenOptions): Promise<Listener> {
  if (!isLoopback(options.bind) && !options.exposureAllowed) {
    throw new ExposureRefused(options.bind);
  }
  const serveFn = options.createListener ?? serve;
  const server = await new Promise<Server>((resolve, reject) => {
    const handle = serveFn(
      {
        fetch: options.app.fetch,
        hostname: options.bind,
        port: options.port,
        createServer,
      },
      () => {
        resolve(handle);
      },
    ) as Server;
    // A bind failure — the port is in use, the address is not local — arrives as an `error` event
    // rather than a throw, and without this the promise would never settle and boot would hang
    // with no message. `09` §3.11.2 gives "port in use" exit 6, which the caller maps.
    handle.once('error', reject);
  });
  const address = server.address();
  return {
    server,
    port: typeof address === 'object' && address !== null ? address.port : options.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
