/**
 * The deny list, against Node's own prefix matcher (`08` §3.9).
 *
 * The table in `blocklist.ts` exists to *name* the range that refused a request. Its correctness is
 * checked against `net.BlockList` rather than against itself: every range's first, last,
 * one-below and one-above address, plus a thousand random addresses, must get the same verdict
 * from both. A hand-written prefix matcher is exactly the kind of code that is right for sixteen
 * ranges and wrong for the seventeenth.
 */
import { isIPv4 } from 'node:net';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fcConfig } from '../testing/index.js';
import {
  addressBytes,
  blockedRange,
  DENIED_IPV4,
  DENIED_IPV6,
  DENIED_RANGES,
  EMBEDS_IPV4,
  nodeBlockListDenies,
} from './blocklist.js';

/** `bytes` as the canonical text form, so the two matchers can be asked the same question. */
function textOf(bytes: Uint8Array): string {
  if (bytes.length === 4) return [...bytes].join('.');
  const groups: string[] = [];
  for (let index = 0; index < 16; index += 2) {
    groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  }
  return groups.join(':');
}

/** `bytes` minus one, in place, with the borrow. */
function decrement(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let index = out.length - 1; index >= 0; index -= 1) {
    if ((out[index] ?? 0) > 0) {
      out[index] = (out[index] ?? 0) - 1;
      return out;
    }
    out[index] = 0xff;
  }
  return out;
}

/** `bytes` plus one, likewise. */
function increment(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let index = out.length - 1; index >= 0; index -= 1) {
    if ((out[index] ?? 0) < 0xff) {
      out[index] = (out[index] ?? 0) + 1;
      return out;
    }
    out[index] = 0;
  }
  return out;
}

/** The first address of a range, and the last, and their neighbours one step outside. */
function boundaries(cidr: string): readonly string[] {
  const [network, prefixText] = cidr.split('/');
  const bytes = addressBytes(network ?? '');
  if (bytes === undefined) throw new Error(`the table has an unparseable range: ${cidr}`);
  const first = new Uint8Array(bytes);
  const last = new Uint8Array(bytes);
  for (let bit = Number(prefixText); bit < bytes.length * 8; bit += 1) {
    const index = bit >> 3;
    last[index] = (last[index] ?? 0) | (0x80 >> (bit & 7));
  }
  return [textOf(first), textOf(last), textOf(decrement(first)), textOf(increment(last))];
}

describe('08 §3.9’s deny list', () => {
  it('is the ranges the spec lists, and no others', () => {
    // Pinned by count and by membership: a range quietly dropped is a network quietly reachable.
    expect(DENIED_IPV4).toHaveLength(18);
    expect(DENIED_IPV6).toHaveLength(16);
    expect(DENIED_RANGES.map((range) => range.cidr)).toContain('169.254.0.0/16');
    expect(DENIED_RANGES.map((range) => range.cidr)).toContain('100.64.0.0/10');
    expect(DENIED_RANGES.map((range) => range.cidr)).toContain('fc00::/7');
    for (const range of DENIED_RANGES) {
      // Every range carries a host-facing reason, because "blocked" alone is a dead end for
      // somebody trying to reach their own NAS.
      expect(range.why.length, range.cidr).toBeGreaterThan(4);
    }
  });

  it('cannot be loaded into one net.BlockList, which is why the matcher is ours', async () => {
    // The measurement behind the module comment: Node checks an IPv4 address against IPv6 rules
    // through its mapped form, so the table's own `::ffff:0:0/96` row denies every IPv4 address.
    // A faithful reading of `08` §3.9 — "built into a `net.BlockList`" — would block all egress.
    const { BlockList } = await import('node:net');
    const faithful = new BlockList();
    for (const range of DENIED_RANGES) {
      const [address, prefix] = range.cidr.split('/');
      faithful.addSubnet(address ?? '', Number(prefix), range.family);
    }
    expect(faithful.check('8.8.8.8', 'ipv4')).toBe(true);
    expect(faithful.check('1.1.1.1', 'ipv4')).toBe(true);
    // And ours, over the same table, does not.
    expect(blockedRange('8.8.8.8')).toBeUndefined();
    expect(blockedRange('1.1.1.1')).toBeUndefined();
    // The oracle the other tests compare against is the same table minus those three rows.
    expect(EMBEDS_IPV4).toEqual(['::ffff:0:0/96', '64:ff9b::/96', '2002::/16']);
    expect(nodeBlockListDenies('8.8.8.8', 'ipv4')).toBe(false);
  });

  it.each(
    DENIED_RANGES.filter((range) => !EMBEDS_IPV4.includes(range.cidr)).map(
      (range) => [range.cidr] as const,
    ),
  )('agrees with net.BlockList on the boundaries of %s', (cidr) => {
    const [first, last, before, after] = boundaries(cidr);
    for (const address of [first, last]) {
      expect(blockedRange(address ?? ''), `${address ?? ''} inside ${cidr}`).toBeDefined();
    }
    for (const address of [before, after]) {
      const mine = blockedRange(address ?? '') !== undefined;
      const theirs = nodeBlockListDenies(address ?? '', isIPv4(address ?? '') ? 'ipv4' : 'ipv6');
      // Outside *this* range, but possibly inside another — so the assertion is agreement, not
      // permission. `0.0.0.0/8`'s neighbour is `10.0.0.0/8`'s neighbourhood, and so on.
      expect(mine, `${address ?? ''} just outside ${cidr}`).toBe(theirs);
    }
  });

  it('denies the three ranges that embed an IPv4 address, which the oracle leaves out', () => {
    // Left out of the oracle, so they need their own assertion: these are the rows `08` §3.9
    // marks with †, and `classify.ts` extracts the embedded address from each.
    expect(blockedRange('::ffff:7f00:1')?.cidr).toBe('::ffff:0:0/96');
    expect(blockedRange('64:ff9b::a00:1')?.cidr).toBe('64:ff9b::/96');
    expect(blockedRange('2002:7f00:1::')?.cidr).toBe('2002::/16');
  });

  it('agrees with net.BlockList on random addresses', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255), fc.nat(255)).map((o) => o.join('.')),
          fc
            .array(fc.nat(0xffff), { minLength: 8, maxLength: 8 })
            .map((groups) => groups.map((group) => group.toString(16)).join(':')),
        ),
        (address) => {
          const range = blockedRange(address);
          const theirs = nodeBlockListDenies(address, isIPv4(address) ? 'ipv4' : 'ipv6');
          // The three † ranges are not in the oracle, so a hit on one of them is this matcher
          // being stricter by design rather than a disagreement.
          if (range !== undefined && EMBEDS_IPV4.includes(range.cidr)) return;
          expect(range !== undefined, address).toBe(theirs);
        },
      ),
      fcConfig({ numRuns: 1000 }),
    );
  });

  it('refuses something that is not an address rather than calling it allowed', () => {
    // `BlockList.check` answers `false` for a non-address — measured on Node 26.13.0 — which is
    // the fail-open edge on the input class that matters most.
    for (const notAnAddress of ['', 'example.com', '127.0.0.256', '::ffff::1', '12345']) {
      expect(blockedRange(notAnAddress)?.why, notAnAddress).toBe('not an IP address');
      expect(nodeBlockListDenies(notAnAddress, 'ipv4'), notAnAddress).toBe(false);
    }
  });

  it('names the range, so a host can act on the refusal', () => {
    expect(blockedRange('169.254.169.254')?.cidr).toBe('169.254.0.0/16');
    expect(blockedRange('169.254.169.254')?.why).toContain('metadata');
    expect(blockedRange('192.168.1.20')?.cidr).toBe('192.168.0.0/16');
    expect(blockedRange('100.100.1.1')?.why).toContain('Tailscale');
    expect(blockedRange('fd00::1')?.cidr).toBe('fc00::/7');
    expect(blockedRange('8.8.8.8')).toBeUndefined();
    expect(blockedRange('2001:4860:4860::8888')).toBeUndefined();
  });
});

describe('address parsing', () => {
  it('reads every IPv6 form the URL parser can produce', () => {
    expect(addressBytes('::1')?.at(15)).toBe(1);
    expect([...(addressBytes('::ffff:7f00:1') ?? [])].slice(12)).toEqual([127, 0, 0, 1]);
    // The dotted-quad tail, which is how a human writes a mapped address.
    expect([...(addressBytes('::ffff:127.0.0.1') ?? [])].slice(12)).toEqual([127, 0, 0, 1]);
    expect([...(addressBytes('64:ff9b::a00:1') ?? [])].slice(12)).toEqual([10, 0, 0, 1]);
    expect(addressBytes('2002:7f00:1::')?.at(1)).toBe(0x02);
    // A scope id is part of a link-local address as a socket reports it.
    expect(addressBytes('fe80::1%en0')?.at(0)).toBe(0xfe);
    // Every refusal the parser can give, reachable from the public function — which is why the
    // family is chosen by the colon rather than by a prior `isIP`: with that gate in place, none
    // of these could reach the parser at all.
    for (const malformed of [
      'not-an-ip',
      '',
      '1:2:3:4:5:6:7',
      '1:2:3:4:5:6:7:8:9',
      '1::2::3',
      '12345::1',
      'xyz::1',
      '::ffff:127.0.0.256',
      '1:2:3:4:5:6:7:8:',
      '127.0.0.256',
      '127.0.0',
      '127.0.0.1.1',
      '127.0.0.x',
      '127..0.1',
    ]) {
      expect(addressBytes(malformed), malformed).toBeUndefined();
    }
  });

  it('round-trips random addresses through bytes and back', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(0xffff), { minLength: 8, maxLength: 8 }), (groups) => {
        const address = groups.map((group) => group.toString(16)).join(':');
        const bytes = addressBytes(address);
        expect(bytes, address).toBeDefined();
        if (bytes === undefined) return;
        expect(bytes).toHaveLength(16);
        for (const [index, group] of groups.entries()) {
          expect(((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0)).toBe(group);
        }
      }),
      fcConfig(),
    );
  });
});
