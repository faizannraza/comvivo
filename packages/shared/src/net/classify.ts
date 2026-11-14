/**
 * The SSRF classifier (`08` §3.9 rules 1–2, `10` §3.4.6 steps 1–3).
 *
 * Two decisions, both pure, both made before a socket exists:
 *
 *  - {@link classifyUrl} — is this URL one we are willing to ask DNS about?
 *  - {@link classifyAddress} — is this resolved address one we are willing to connect to?
 *
 * Keeping them pure is what makes `fuzz.ssrf.classify` possible: the interesting inputs are the
 * ones nobody thinks to write, and a fuzzer can only reach them if the decision needs no network.
 *
 * ## What the URL parser already does, and what it does not
 *
 * Measured on Node 26.13.0, because the answer decides how much of this file has to exist:
 *
 * | Input | `new URL(...).hostname` |
 * |---|---|
 * | `http://0177.0.0.1` | `127.0.0.1` (octal) |
 * | `http://2130706433` | `127.0.0.1` (decimal) |
 * | `http://0x7f.1` | `127.0.0.1` (hex, two parts) |
 * | `http://127.1` | `127.0.0.1` (short form) |
 * | `http://[::ffff:127.0.0.1]` | `[::ffff:7f00:1]` (**re-spelled in hex**) |
 * | `http://ⓛocalhost` | `localhost` (IDNA) |
 * | `http://①②.com` | `12.com` (IDNA) |
 * | `http://nas.local.` | `nas.local.` (**the trailing dot survives**) |
 *
 * So the alternate IPv4 encodings `08` §3.9 rule 1 names are normalised for us, and two things are
 * not: a mapped address arrives in hex rather than dotted form, so the embedded-IPv4 extraction
 * cannot look for dots; and a trailing root dot survives, so every name check has to strip it or
 * `nas.local.` walks past a rule written for `nas.local`.
 *
 * Specification: `docs/plan/08-security-privacy.md` §3.9; `docs/plan/10-extensibility.md` §3.4.6.
 */
import { isIP, isIPv4 } from 'node:net';
import { err, ok, type Result } from '../result.js';
import { addressBytes, blockedRange, type DeniedRange } from './blocklist.js';

/**
 * Why a request was refused. Goes into `egress.blocked {purpose, reason, host}` (`08` §3.9 rule 7),
 * so it carries a host and a range but never a path, a query or a full URL.
 */
export type EgressReason =
  | 'url-unparseable'
  | 'scheme'
  | 'userinfo'
  | 'port'
  | 'local-name'
  | 'dotless-name'
  | 'blocked-address'
  | 'no-address'
  | 'redirect-limit'
  | 'redirect-downgrade'
  | 'content-type'
  | 'too-large'
  | 'compression-ratio'
  | 'timeout'
  | 'transport';

export interface EgressRefusal {
  readonly reason: EgressReason;
  /** The host, which an audit event may carry. Empty when the URL would not parse. */
  readonly host: string;
  /** One sentence a host can act on. Never contains the path or the query. */
  readonly detail: string;
}

/** The host-only egress allowlist (`08` §3.9, SD-21). */
export interface EgressPolicy {
  /**
   * Exact `host:port` entries that may resolve into a denied range — a NAS, a LAN service.
   *
   * No wildcards, by design: a wildcard allowlist is a deny list with extra steps, and the whole
   * point of this one is that a host wrote down the exact thing they meant. IPv6 literals are
   * written as a URL authority writes them, with brackets: `[fd00::1]:443`.
   */
  readonly allowPrivate: readonly string[];
  /** Exact `host:port` entries that may be reached over plain `http:`. */
  readonly allowHttpHosts: readonly string[];
}

export const EMPTY_POLICY: EgressPolicy = Object.freeze({
  allowPrivate: Object.freeze([]),
  allowHttpHosts: Object.freeze([]),
});

export interface ClassifiedUrl {
  readonly url: URL;
  /** The hostname with any trailing root dot removed, and without brackets for an IPv6 literal. */
  readonly host: string;
  readonly port: number;
  /** `host:port`, the spelling the allowlist uses (brackets kept for IPv6). */
  readonly hostPort: string;
  /** Whether this exact `host:port` is allowed to resolve into a denied range. */
  readonly privateAllowed: boolean;
  /** `undefined` unless the host is an IP literal, in which case there is nothing to resolve. */
  readonly literalAddress: string | undefined;
}

/** Names that are never fetched unless the host allowlists them exactly (`08` §3.9 rule 1). */
const LOCAL_SUFFIXES: readonly string[] = ['.localhost', '.local', '.internal', '.home.arpa'];
const LOCAL_NAMES: readonly string[] = ['localhost', 'metadata.google.internal'];

/** Strip a trailing root dot: `nas.local.` and `nas.local` are the same host. */
function withoutRootDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

/** An IPv6 literal arrives from the URL parser in brackets; the address inside is what we check. */
function unbracket(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function refuse(reason: EgressReason, host: string, detail: string): Result<never, EgressRefusal> {
  return err({ reason, host, detail });
}

/**
 * `08` §3.9 rule 1: parse, then decide whether this URL may be resolved at all.
 *
 * Order matters for the message a host reads, not for safety: every check is a refusal, so the
 * first one to fire is the one explained. Scheme before port, because "https only" is the rule
 * people forget, and the port rule reads oddly against an `http:` URL that was never allowed.
 */
export function classifyUrl(
  raw: string | URL,
  policy: EgressPolicy,
): Result<ClassifiedUrl, EgressRefusal> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('url-unparseable', '', 'that is not a URL this product can fetch.');
  }

  const host = withoutRootDot(unbracket(url.hostname)).toLowerCase();
  const isHttps = url.protocol === 'https:';
  const isHttp = url.protocol === 'http:';
  const port = url.port === '' ? (isHttps ? 443 : 80) : Number(url.port);
  const bracketed = isIP(host) === 6 ? `[${host}]` : host;
  const hostPort = `${bracketed}:${String(port)}`;
  const privateAllowed = policy.allowPrivate.includes(hostPort);

  if (!isHttps && !isHttp) {
    return refuse(
      'scheme',
      host,
      `only https (and allowlisted http) is fetched, not ${url.protocol}`,
    );
  }
  if (isHttp && !policy.allowHttpHosts.includes(hostPort)) {
    return refuse(
      'scheme',
      host,
      `plain http is refused unless ${hostPort} is in network.egress.allowHttpHosts.`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    // Credentials in a URL are a redirect away from being sent to somebody else, and they would
    // reach a log the moment anything printed the URL.
    return refuse('userinfo', host, 'a URL with a username or password in it is never fetched.');
  }
  if (port !== (isHttps ? 443 : 80) && !privateAllowed) {
    return refuse(
      'port',
      host,
      `port ${String(port)} is refused unless ${hostPort} is in network.egress.allowPrivate.`,
    );
  }

  const literal = isIP(host) === 0 ? undefined : host;
  if (literal === undefined && !privateAllowed) {
    const refusal = refuseByName(host, hostPort);
    if (refusal !== undefined) return err(refusal);
  }

  return ok({ url, host, port, hostPort, privateAllowed, literalAddress: literal });
}

/**
 * The name rules of `08` §3.9 rule 1, for a host that is not an IP literal.
 *
 * Separate from {@link classifyUrl} because the two halves answer different questions — "is this
 * URL shaped like one we fetch" and "does this name point inside the house" — and because the
 * combined function was past the complexity the linter allows, which was a fair signal.
 */
function refuseByName(host: string, hostPort: string): EgressRefusal | undefined {
  if (LOCAL_NAMES.includes(host) || LOCAL_SUFFIXES.some((end) => host.endsWith(end))) {
    return {
      reason: 'local-name',
      host,
      detail: `${host} names something on this machine or this network; add ${hostPort} to network.egress.allowPrivate to reach it.`,
    };
  }
  if (!host.includes('.')) {
    // A dotless name resolves through the host's own search domains, which is how
    // `http://intranet/` becomes a LAN request nobody wrote down.
    return {
      reason: 'dotless-name',
      host,
      detail: `${host} has no dot, so it resolves through this machine's search domains.`,
    };
  }
  return undefined;
}

/** An IPv4 address carried inside an IPv6 one, and the mechanism that carries it. */
export interface EmbeddedIpv4 {
  readonly address: string;
  readonly via: string;
}

/**
 * The IPv4 address embedded in a mapped, NAT64 or 6to4 address (`08` §3.9's † rows).
 *
 * The URL parser re-spells `::ffff:127.0.0.1` as `::ffff:7f00:1`, so this works on bytes rather
 * than on text — a version that looked for a dotted tail would have found nothing for every input
 * that actually arrives.
 */
export function embeddedIpv4(address: string): EmbeddedIpv4 | undefined {
  const bytes = addressBytes(address);
  if (bytes === undefined || bytes.length !== 16) return undefined;
  const group = (index: number): number =>
    ((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0);
  const tail = (): string => [bytes[12], bytes[13], bytes[14], bytes[15]].map(String).join('.');

  // `::ffff:0:0/96` — IPv4-mapped.
  if (
    group(0) === 0 &&
    group(1) === 0 &&
    group(2) === 0 &&
    group(3) === 0 &&
    group(4) === 0 &&
    group(5) === 0xffff
  ) {
    return { address: tail(), via: 'an IPv4-mapped address' };
  }
  // `64:ff9b::/96` — NAT64.
  if (
    group(0) === 0x64 &&
    group(1) === 0xff9b &&
    group(2) === 0 &&
    group(3) === 0 &&
    group(4) === 0 &&
    group(5) === 0
  ) {
    return { address: tail(), via: 'NAT64' };
  }
  // `2002::/16` — 6to4 carries the IPv4 address in bytes 2–5.
  if (group(0) === 0x2002) {
    const quad = [bytes[2], bytes[3], bytes[4], bytes[5]].map(String).join('.');
    return { address: quad, via: '6to4' };
  }
  // `::/96` — IPv4-compatible, deprecated but still representable.
  if (
    group(0) === 0 &&
    group(1) === 0 &&
    group(2) === 0 &&
    group(3) === 0 &&
    group(4) === 0 &&
    group(5) === 0
  ) {
    return { address: tail(), via: 'an IPv4-compatible address' };
  }
  return undefined;
}

/**
 * `08` §3.9 rule 2: may we connect to this resolved address?
 *
 * The embedded IPv4 is checked **first**, so a refusal names the address that actually matters: an
 * audit event saying `169.254.169.254 via NAT64` tells a host what happened, and one saying
 * `64:ff9b::/96` makes them go and look it up.
 */
/**
 * Whether a URL's host names **this machine** (added at `M2-T16`).
 *
 * Lives here rather than in its caller because the question needs `node:net`'s `isIP`, and
 * answering it with a regex is how a hole gets opened: `/^127\./` matches
 * `127.0.0.1.evil.example`, which is a name that resolves wherever its owner wants. `M2-T16`'s
 * Local-only check had exactly that bug and a test caught it — a host who turned on
 * `privacy.localOnly` would have had a route to that name accepted as loopback.
 *
 * Accepts, and nothing else:
 *
 *  - `localhost`, which every platform resolves to loopback;
 *  - a real IPv4 **literal** in `127.0.0.0/8` — the whole block, not just `127.0.0.1`;
 *  - a real IPv6 literal that is `::1`, or an IPv4-mapped one whose embedded address is loopback
 *    (`::ffff:127.0.0.1`, which the URL parser re-spells in hex as `::ffff:7f00:1`).
 *
 * A **name** other than `localhost` is never loopback here, even one that resolves to it: that is
 * a DNS answer, and a destination decided by DNS is a destination that can change between the
 * check and the connection. `safeFetch` re-checks the resolved address for exactly that reason.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return true;

  const kind = isIP(normalized);
  if (kind === 4) return LOOPBACK_V4.test(normalized);
  if (kind !== 6) return false;
  if (normalized === '::1') return true;
  const embedded = embeddedIpv4(normalized);
  return embedded !== undefined && LOOPBACK_V4.test(embedded.address);
}

/**
 * `127.0.0.0/8`, as a shape test over something already known to be an IPv4 literal.
 *
 * Safe as a regex **only** because `isIP` has already established the string is a dotted quad —
 * which is the distinction that makes the same pattern a bug one line earlier.
 */
const LOOPBACK_V4 = /^127\./;

export function classifyAddress(address: string, target: ClassifiedUrl): EgressRefusal | undefined {
  if (isIP(address) === 0) {
    // A resolver that returned something that is not an address, or a caller that passed a name.
    return {
      reason: 'blocked-address',
      host: target.host,
      detail: `${address} is not an IP address.`,
    };
  }
  if (target.privateAllowed) return undefined;

  const embedded = isIPv4(address) ? undefined : embeddedIpv4(address);
  if (embedded !== undefined) {
    const range = blockedRange(embedded.address);
    if (range !== undefined) return addressRefusal(target, embedded.address, range, embedded.via);
  }
  const range = blockedRange(address);
  if (range !== undefined) return addressRefusal(target, address, range, undefined);
  return undefined;
}

function addressRefusal(
  target: ClassifiedUrl,
  address: string,
  range: DeniedRange,
  via: string | undefined,
): EgressRefusal {
  const through = via === undefined ? '' : ` through ${via}`;
  return {
    reason: 'blocked-address',
    host: target.host,
    detail:
      `${target.host} resolves to ${address}${through}, which is ${range.why} (${range.cidr}). ` +
      `Add ${target.hostPort} to network.egress.allowPrivate if that is deliberate.`,
  };
}
