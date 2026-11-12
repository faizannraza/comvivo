/**
 * The egress deny list (`08` §3.9), as named ranges and as a `net.BlockList`.
 *
 * ## Why the matcher is here and not `net.BlockList`
 *
 * `08` §3.9 says the list is "built into a `net.BlockList`". **It cannot be, as written.** Node
 * checks an IPv4 address against IPv6 rules through its IPv4-mapped form, so the table's own
 * `::ffff:0:0/96` row makes `check('8.8.8.8', 'ipv4')` return `true` — a faithful load of §3.9's
 * table into one `BlockList` denies **every** IPv4 address and all egress with it. Measured on
 * Node 26.13.0, rule by rule, by adding each range and watching which probe flipped.
 *
 * So the ranges are a table, matched here, and `net.BlockList` is the **oracle in the tests**:
 * `blocklist.test.ts` builds one without the three ranges that embed an IPv4 address and asserts
 * both matchers agree on every range's first, last, one-below and one-above address, plus a
 * thousand random ones. A hand-written prefix matcher is exactly the kind of code that is right
 * for sixteen ranges and wrong for the seventeenth.
 *
 * The table also carries the *name* of the range, which a boolean cannot: the host staring at "I
 * can't reach my NAS" needs to be told which range refused them and why.
 *
 * ## One more fact about `net.BlockList`
 *
 * `check()` returns `false` for a string that is not an IP address — it does not throw. That is a
 * fail-open edge on the one input class that matters most, so every address reaching this module
 * is validated with `isIP` first and anything else is refused outright rather than handed to a
 * matcher that would call it "not blocked".
 *
 * Specification: `docs/plan/08-security-privacy.md` §3.9; `docs/plan/10-extensibility.md` §3.4.6.
 */
import { BlockList } from 'node:net';

/** A denied range, with the name an audit event and a host-facing error use. */
export interface DeniedRange {
  readonly cidr: string;
  readonly family: 'ipv4' | 'ipv6';
  /** What it is, in the words a host would recognise. */
  readonly why: string;
}

/**
 * IPv4, from the IANA special-purpose registry as `08` §3.9 lists it.
 *
 * `100.64.0.0/10` is the one worth calling out: it is CGNAT, and it is also where Tailscale puts
 * every node. A home instance behind Tailscale would otherwise be reachable from a fetch the host
 * never intended.
 */
export const DENIED_IPV4: readonly DeniedRange[] = Object.freeze([
  { cidr: '0.0.0.0/8', family: 'ipv4', why: 'this host, or an unspecified address' },
  { cidr: '10.0.0.0/8', family: 'ipv4', why: 'a private network (RFC 1918)' },
  { cidr: '100.64.0.0/10', family: 'ipv4', why: 'carrier-grade NAT, including Tailscale' },
  { cidr: '127.0.0.0/8', family: 'ipv4', why: 'loopback' },
  { cidr: '169.254.0.0/16', family: 'ipv4', why: 'link-local, including cloud metadata' },
  { cidr: '172.16.0.0/12', family: 'ipv4', why: 'a private network (RFC 1918)' },
  { cidr: '192.0.0.0/24', family: 'ipv4', why: 'IETF protocol assignments' },
  { cidr: '192.0.2.0/24', family: 'ipv4', why: 'documentation (TEST-NET-1)' },
  { cidr: '192.31.196.0/24', family: 'ipv4', why: 'AS112 anycast' },
  { cidr: '192.52.193.0/24', family: 'ipv4', why: 'AMT relay' },
  { cidr: '192.88.99.0/24', family: 'ipv4', why: 'the deprecated 6to4 relay anycast' },
  { cidr: '192.168.0.0/16', family: 'ipv4', why: 'a private network (RFC 1918)' },
  { cidr: '192.175.48.0/24', family: 'ipv4', why: 'AS112 direct delegation' },
  { cidr: '198.18.0.0/15', family: 'ipv4', why: 'benchmarking' },
  { cidr: '198.51.100.0/24', family: 'ipv4', why: 'documentation (TEST-NET-2)' },
  { cidr: '203.0.113.0/24', family: 'ipv4', why: 'documentation (TEST-NET-3)' },
  { cidr: '224.0.0.0/4', family: 'ipv4', why: 'multicast' },
  { cidr: '240.0.0.0/4', family: 'ipv4', why: 'reserved, including the broadcast address' },
]);

/** IPv6, likewise. The three ranges that embed an IPv4 address are handled in `classify.ts`. */
export const DENIED_IPV6: readonly DeniedRange[] = Object.freeze([
  { cidr: '::/128', family: 'ipv6', why: 'the unspecified IPv6 address' },
  { cidr: '::1/128', family: 'ipv6', why: 'IPv6 loopback' },
  { cidr: '::/96', family: 'ipv6', why: 'IPv4-compatible, deprecated' },
  { cidr: '::ffff:0:0/96', family: 'ipv6', why: 'an IPv4-mapped address' },
  { cidr: '64:ff9b::/96', family: 'ipv6', why: 'NAT64 translation' },
  { cidr: '64:ff9b:1::/48', family: 'ipv6', why: 'local-use NAT64' },
  { cidr: '100::/64', family: 'ipv6', why: 'the discard-only address block' },
  { cidr: '2001::/23', family: 'ipv6', why: 'IETF protocol assignments, including Teredo' },
  { cidr: '2001:db8::/32', family: 'ipv6', why: 'documentation' },
  { cidr: '2002::/16', family: 'ipv6', why: '6to4 tunnelling' },
  { cidr: '3fff::/20', family: 'ipv6', why: 'documentation' },
  { cidr: '5f00::/16', family: 'ipv6', why: 'segment routing (SRv6)' },
  { cidr: 'fc00::/7', family: 'ipv6', why: 'a unique local address' },
  { cidr: 'fe80::/10', family: 'ipv6', why: 'link-local' },
  { cidr: 'fec0::/10', family: 'ipv6', why: 'site-local (deprecated)' },
  { cidr: 'ff00::/8', family: 'ipv6', why: 'multicast' },
]);

export const DENIED_RANGES: readonly DeniedRange[] = Object.freeze([
  ...DENIED_IPV4,
  ...DENIED_IPV6,
]);

/**
 * The ranges that embed an IPv4 address (`08` §3.9's † rows).
 *
 * Excluded from the test oracle below, because `::ffff:0:0/96` in a `net.BlockList` denies every
 * IPv4 address — see the module comment. `classify.ts` extracts the embedded address from each of
 * these and checks it against the IPv4 rules, which is what the † in the spec asks for.
 */
export const EMBEDS_IPV4: readonly string[] = Object.freeze([
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '2002::/16',
]);

/**
 * `net.BlockList` over the same ranges, as the tests' oracle.
 *
 * Built once, without the three † ranges. Not used for any decision: the equivalence assertion in
 * `blocklist.test.ts` is what this exists for.
 */
const oracle = ((): BlockList => {
  const list = new BlockList();
  for (const range of DENIED_RANGES) {
    if (EMBEDS_IPV4.includes(range.cidr)) continue;
    const [address, prefix] = range.cidr.split('/');
    list.addSubnet(address ?? '', Number(prefix), range.family);
  }
  return list;
})();

/**
 * `address` as bytes — 4 for IPv4, 16 for IPv6 — or `undefined` if it cannot be read as either.
 *
 * The parser **is** the validator: the first version called `isIP` first and then parsed, which
 * made every refusal inside the parsers unreachable — a second opinion that could only agree, and
 * a set of branches that read as handled cases and could never run. The family is chosen by the
 * presence of a colon, which is the one thing the two forms never share.
 *
 * Slightly more permissive than `net.isIP` in one direction (`1.2.3.04` parses here and is not a
 * valid textual address), which is safe for a deny list: it maps to the same bytes and is checked
 * the same way. Input that comes from a resolver or from the URL parser is canonical anyway, and
 * `classify.ts` keeps `isIP` as the gate on anything a resolver hands back.
 */
export function addressBytes(address: string): Uint8Array | undefined {
  return address.includes(':') ? ipv6Bytes(address) : ipv4Bytes(address);
}

function ipv4Bytes(address: string): Uint8Array | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    if (part === '' || !/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes[index] = value;
  }
  return bytes;
}

/**
 * IPv6 → 16 bytes, including the `::` compression and a dotted-quad tail.
 *
 * Hand-written because Node exposes no parser, and needed for two things beyond prefix matching:
 * the embedded IPv4 in a mapped, NAT64 or 6to4 address (`classify.ts`), and the range *name* this
 * module exists to provide. Every refusal here is reachable from {@link addressBytes} and tested,
 * because a parser that guesses is worse than one that refuses — and an untested refusal is a
 * guess waiting to happen.
 */
function ipv6Bytes(address: string): Uint8Array | undefined {
  const zone = address.indexOf('%');
  const halves = (zone === -1 ? address : address.slice(0, zone)).split('::');
  if (halves.length > 2) return undefined;

  const head = groupsOf(halves[0]);
  const tail = groupsOf(halves[1]);
  // A dotted-quad tail (`::ffff:127.0.0.1`) is two groups' worth of bytes.
  const dotted = (tail.length > 0 ? tail : head).at(-1) ?? '';
  let embedded: Uint8Array | undefined;
  if (dotted.includes('.')) {
    embedded = ipv4Bytes(dotted);
    if (embedded === undefined) return undefined;
    (tail.length > 0 ? tail : head).pop();
  }

  const groupCount = head.length + tail.length + (embedded === undefined ? 0 : 2);
  if (groupCount > 8 || (halves.length === 1 && groupCount !== 8)) return undefined;

  const bytes = new Uint8Array(16);
  // The head writes forward from 0, the tail backward from the end, and the gap `::` stands for is
  // already zero — which is the whole of the compression rule.
  if (!writeGroups(head, bytes, 0)) return undefined;
  const tailOffset = 16 - (tail.length * 2 + (embedded === undefined ? 0 : 4));
  if (!writeGroups(tail, bytes, tailOffset)) return undefined;
  if (embedded !== undefined) bytes.set(embedded, 12);
  return bytes;
}

/** The groups of one half of an address, or none for an empty half. */
function groupsOf(half: string | undefined): string[] {
  return half === undefined || half === '' ? [] : half.split(':');
}

/** Write 16-bit groups into `bytes` at `offset`. `false` if any group is not one. */
function writeGroups(groups: readonly string[], bytes: Uint8Array, offset: number): boolean {
  let at = offset;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
    const value = Number.parseInt(group, 16);
    bytes[at] = value >> 8;
    bytes[at + 1] = value & 0xff;
    at += 2;
  }
  return true;
}

/** Does `bytes` fall inside `cidr`? */
function inRange(bytes: Uint8Array, range: DeniedRange): boolean {
  const [networkText, prefixText] = range.cidr.split('/');
  const network = addressBytes(networkText ?? '');
  const prefix = Number(prefixText);
  if (network === undefined || network.length !== bytes.length) return false;
  const whole = prefix >> 3;
  for (let index = 0; index < whole; index += 1) {
    if (bytes[index] !== network[index]) return false;
  }
  const remainder = prefix & 7;
  if (remainder === 0) return true;
  const mask = 0xff << (8 - remainder);
  return ((bytes[whole] ?? 0) & mask) === ((network[whole] ?? 0) & mask);
}

/**
 * The range that denies `address`, or `undefined` if none does.
 *
 * Anything that is not an IP address is **refused**, with that as the reason: `BlockList.check`
 * would answer `false` for it, which is the wrong answer to the wrong question. A caller holding
 * a hostname rather than an address has a bug, and a deny list is where it must surface.
 */
export function blockedRange(address: string): DeniedRange | undefined {
  const bytes = addressBytes(address);
  if (bytes === undefined) {
    return { cidr: address, family: 'ipv4', why: 'not an IP address' };
  }
  for (const range of bytes.length === 4 ? DENIED_IPV4 : DENIED_IPV6) {
    if (inRange(bytes, range)) return range;
  }
  return undefined;
}

/** Node's verdict over the same ranges, for the equivalence test and for nothing else. */
export function nodeBlockListDenies(address: string, family: 'ipv4' | 'ipv6'): boolean {
  return oracle.check(address, family);
}
