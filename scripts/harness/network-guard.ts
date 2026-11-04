/**
 * The offline guarantee for test tiers L1–L4 (`11` §3.1.1), as an importable module so it can be
 * unit-tested rather than only trusted.
 *
 * **There is no single interception point.** The first version of this guard patched only
 * `net.Socket.prototype.connect`, on the reasoning that every client reaches it eventually. That
 * is false, and the M0 independent review measured it: `net.connect`, `net.createConnection`,
 * everything built on `node:http`, and the whole of `node:dns` went straight past. A unit test
 * could make a real outbound HTTP request and nothing said a word.
 *
 * `fetch` and `tls.connect` *were* blocked, because undici constructs a `Socket` and calls
 * `.connect()` on it — which is why the gap survived: the one client anybody actually used
 * happened to take the guarded path.
 *
 * So every public entry point is patched: the socket prototype, the two module-level connect
 * functions, and DNS resolution. DNS matters on its own account — a name lookup is an outbound
 * packet to a resolver, and it leaks the hostname being looked up even when the connection that
 * follows is blocked.
 *
 * Loopback stays open because integration tests bind real servers on `127.0.0.1:0` (the template
 * database, the FakeProviderServer, the HTTP API). Genuinely live tests carry the `live` tag and run
 * only in the L6 workflows, which set `COMVIVO_ALLOW_NETWORK=1`.
 */
import dns from 'node:dns';
import net from 'node:net';

const LOOPBACK_NAMES = new Set(['localhost', '0.0.0.0', '']);

/**
 * Is this host local to the machine running the tests?
 *
 * `undefined` means the call had no hostname at all — a unix socket or a file descriptor — which is
 * not network egress and is therefore allowed.
 */
export function isLoopback(host: string | undefined): boolean {
  if (host === undefined) return true;
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (LOOPBACK_NAMES.has(bare)) return true;
  if (bare.endsWith('.localhost')) return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1: systemd-resolved uses 127.0.0.53 and test
  // fixtures sometimes pick another address in the block to isolate ports.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) return true;
  // IPv6 loopback, in any of its spellings.
  return bare === '::1' || bare === '0:0:0:0:0:0:0:1' || bare === '::ffff:127.0.0.1';
}

/** Pull the hostname out of the several shapes `Socket.connect` accepts. */
export function hostFromConnectArgs(args: readonly unknown[]): string | undefined {
  const [first, second] = args;
  if (typeof first === 'object' && first !== null && 'host' in first) {
    return (first as { host?: string }).host;
  }
  // connect(port, host?, listener?)
  if (typeof second === 'string') return second;
  return undefined;
}

export function blockedMessage(host: string | undefined): string {
  return (
    `Network access blocked in tests: attempted to connect to "${String(host)}".\n` +
    'Tiers L1-L4 run offline (11 §3.1.1). Use a fake, a recorded fixture, or the\n' +
    'FakeProviderServer on loopback. A genuinely live test must carry the `live` tag and\n' +
    'run in an L6 workflow, which sets COMVIVO_ALLOW_NETWORK=1.'
  );
}

type Connect = typeof net.Socket.prototype.connect;

/**
 * DNS functions that take a hostname as their first argument.
 *
 * `lookup` is the one that matters most — it is how `node:net` resolves a name before connecting —
 * but the `resolve*` family is a direct egress path in its own right and is used by some SDKs for
 * service discovery.
 */
const DNS_HOSTNAME_FUNCTIONS = [
  'lookup',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
] as const;

/** Wrap a function whose first argument is a hostname, refusing non-loopback names. */
function guardHostnameFn<T extends (...args: never[]) => unknown>(original: T): T {
  // `this: unknown`, not `this: void`: these functions are genuinely called as methods —
  // `dns.resolve4(...)` on the module object and `resolver.resolve4(...)` on a `Resolver`
  // instance — so the receiver has to be forwarded, which `.apply(this, args)` below does.
  return function guarded(this: unknown, ...args: never[]): unknown {
    const host = args[0];
    if (typeof host === 'string' && !isLoopback(host)) {
      throw new Error(blockedMessage(host));
    }
    return (original as (...a: never[]) => unknown).apply(this, args);
  } as T;
}

/**
 * Install the guard. Returns a function that restores every patched entry point.
 *
 * Each patch is recorded as its own restore closure rather than reconstructing the originals at the
 * end, so a partially-applied install still tears down cleanly.
 */
export function installNetworkGuard(): () => void {
  const restores: (() => void)[] = [];

  // --- The socket prototype -------------------------------------------------------------------
  // Covers `new Socket().connect(...)`, undici (and therefore `fetch`), and `tls.connect`.
  // Reading a method off the prototype to store it is what a monkey-patch *is*; `this` is
  // forwarded by `.apply(this, args)` in the replacement, so nothing is really unbound.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalConnect: Connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(
    this: net.Socket,
    ...args: Parameters<Connect>
  ): net.Socket {
    const host = hostFromConnectArgs(args);
    if (!isLoopback(host)) throw new Error(blockedMessage(host));
    return originalConnect.apply(this, args);
  } as Connect;
  restores.push(() => {
    net.Socket.prototype.connect = originalConnect;
  });

  // --- The module-level connect functions -----------------------------------------------------
  // `net.connect` and `net.createConnection` do **not** route through the prototype patch above.
  // Measured, not assumed: before this was added, `net.connect(443, '1.1.1.1')` and
  // `http.get('http://1.1.1.1/')` both succeeded inside a unit test. `node:http`'s default agent
  // builds its sockets here, which is how every `node:http` client escaped.
  for (const name of ['connect', 'createConnection'] as const) {
    const original = net[name];
    const patched = function patchedCreate(...args: unknown[]): unknown {
      const host = hostFromConnectArgs(args);
      if (!isLoopback(host)) throw new Error(blockedMessage(host));
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    (net as unknown as Record<string, unknown>)[name] = patched;
    restores.push(() => {
      (net as unknown as Record<string, unknown>)[name] = original;
    });
  }

  // --- DNS --------------------------------------------------------------------------------------
  // A name lookup is outbound traffic to a resolver, and it leaks the hostname even when the
  // connection that would follow is blocked. Loopback names stay resolvable because `localhost`
  // is not an IP literal and `net.connect({ host: 'localhost' })` has to resolve it.
  const dnsRecord = dns as unknown as Record<string, unknown>;
  for (const name of DNS_HOSTNAME_FUNCTIONS) {
    const original = dnsRecord[name];
    if (typeof original !== 'function') continue;
    dnsRecord[name] = guardHostnameFn(original as (...a: never[]) => unknown);
    restores.push(() => {
      dnsRecord[name] = original;
    });
  }

  const promisesRecord = dns.promises as unknown as Record<string, unknown>;
  for (const name of DNS_HOSTNAME_FUNCTIONS) {
    const original = promisesRecord[name];
    if (typeof original !== 'function') continue;
    promisesRecord[name] = guardHostnameFn(original as (...a: never[]) => unknown);
    restores.push(() => {
      promisesRecord[name] = original;
    });
  }

  // `new dns.Resolver()` holds its own methods, so patching the module object is not enough.
  const resolverProto = dns.Resolver.prototype as unknown as Record<string, unknown>;
  for (const name of DNS_HOSTNAME_FUNCTIONS) {
    const original = resolverProto[name];
    if (typeof original !== 'function') continue;
    resolverProto[name] = guardHostnameFn(original as (...a: never[]) => unknown);
    restores.push(() => {
      resolverProto[name] = original;
    });
  }

  return () => {
    // Reverse order, so the socket prototype is restored last.
    for (const restore of restores.reverse()) restore();
  };
}
