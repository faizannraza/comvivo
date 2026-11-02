/**
 * The offline guarantee for test tiers L1–L4 (`11` §3.1.1), as an importable module so it can be
 * unit-tested rather than only trusted.
 *
 * It patches `net.Socket.prototype.connect`, which every HTTP client in the tree ultimately reaches
 * — undici, `node:https`, grammY, discord.js, Bolt, signal-cli's JSON-RPC. Intercepting at that
 * layer means a new client cannot accidentally escape the guard, which is exactly what would happen
 * with a per-library interceptor.
 *
 * Loopback stays open because integration tests bind real servers on `127.0.0.1:0` (the template
 * database, the FakeProviderServer, the HTTP API). Genuinely live tests carry the `live` tag and run
 * only in the L6 workflows, which set `COMVIVO_ALLOW_NETWORK=1`.
 */
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

/** Install the guard. Returns a function that restores the original `connect`. */
export function installNetworkGuard(): () => void {
  const original: Connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(
    this: net.Socket,
    ...args: Parameters<Connect>
  ): net.Socket {
    const host = hostFromConnectArgs(args);
    if (!isLoopback(host)) throw new Error(blockedMessage(host));
    return original.apply(this, args);
  } as Connect;
  return () => {
    net.Socket.prototype.connect = original;
  };
}
