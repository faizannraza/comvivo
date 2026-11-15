/**
 * `sec.ssrf.*` — the SSRF matrix (`08` §3.9, `10` §9: "≥ 60 cases").
 *
 * Every case is a URL a real attack would use, with the verdict it must get. They are listed as
 * data rather than as prose so the count is checkable and the table reads like the threat it is
 * about: IPv4 and IPv6, every alternate literal encoding, the three IPv6 forms that smuggle an
 * IPv4 address, IDN confusables, local names, dotless names, ports, schemes, credentials, and the
 * cloud-metadata address in as many spellings as it has.
 *
 * The allowlist cases matter as much as the refusals. An egress control that cannot be opened for
 * a host's own NAS is one a host will turn off entirely, so `nas.local:443` and `192.168.1.20:8443`
 * are part of the matrix and so is the rule that an allowlist entry is **exact**.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fcConfig } from '../testing/index.js';
import {
  classifyAddress,
  classifyUrl,
  type EgressPolicy,
  type EgressReason,
  EMPTY_POLICY,
  embeddedIpv4,
  isLoopbackHost,
} from './classify.js';

/** The host's allowlist in the §3.9 example, plus a loopback port for the fetch tests. */
const ALLOWING: EgressPolicy = {
  allowPrivate: ['nas.local:443', 'nas.local:80', '192.168.1.20:8443', '[fd00::1]:443'],
  allowHttpHosts: ['nas.local:80', '192.168.1.20:8443'],
};

/**
 * The two lists are **independent**, and this is the policy that proves it: `plain.local:80` may
 * be reached over plain http as far as the scheme rule is concerned, and is still refused for
 * being a `.local` name. A host who wants an unencrypted fetch of a LAN box has to say both
 * things, which is two entries for two separate properties rather than one entry that means both.
 */
const HTTP_ONLY: EgressPolicy = {
  allowPrivate: [],
  allowHttpHosts: ['plain.local:80'],
};

/**
 * One case: the URL, the address DNS would return for it (or `literal` to use the URL's own), and
 * the expected reason — `undefined` meaning "allowed".
 */
interface Case {
  readonly url: string;
  readonly resolves?: string;
  readonly expect: EgressReason | undefined;
  readonly policy?: EgressPolicy;
}

/** `08` §3.9 rule 1: the URL itself, before DNS. */
const URL_CASES: readonly Case[] = [
  // --- scheme ---------------------------------------------------------------------------------
  { url: 'https://example.com/feed.ics', resolves: '93.184.216.34', expect: undefined },
  { url: 'http://example.com/feed.ics', expect: 'scheme' },
  { url: 'ftp://example.com/feed.ics', expect: 'scheme' },
  { url: 'file:///etc/passwd', expect: 'scheme' },
  { url: 'gopher://example.com/', expect: 'scheme' },
  { url: 'data:text/plain,hello', expect: 'scheme' },
  { url: 'jar:https://example.com/!/x', expect: 'scheme' },
  { url: 'not a url at all', expect: 'url-unparseable' },
  { url: 'https://', expect: 'url-unparseable' },
  // --- credentials ----------------------------------------------------------------------------
  { url: 'https://user:pass@example.com/', expect: 'userinfo' },
  { url: 'https://user@example.com/', expect: 'userinfo' },
  { url: 'https://admin:@example.com/', expect: 'userinfo' },
  // `@` in the path is not credentials, and is fetched.
  { url: 'https://example.com/@user/feed', resolves: '93.184.216.34', expect: undefined },
  // --- ports ----------------------------------------------------------------------------------
  { url: 'https://example.com:443/', resolves: '93.184.216.34', expect: undefined },
  { url: 'https://example.com:8443/', expect: 'port' },
  { url: 'https://example.com:22/', expect: 'port' },
  { url: 'https://example.com:11211/', expect: 'port' },
  { url: 'https://example.com:0/', expect: 'port' },
  // --- local names ----------------------------------------------------------------------------
  { url: 'https://localhost/', expect: 'local-name' },
  { url: 'https://LOCALHOST/', expect: 'local-name' },
  { url: 'https://anything.localhost/', expect: 'local-name' },
  { url: 'https://nas.local/', expect: 'local-name' },
  { url: 'https://nas.local./', expect: 'local-name' },
  { url: 'https://printer.home.arpa/', expect: 'local-name' },
  { url: 'https://db.internal/', expect: 'local-name' },
  { url: 'https://metadata.google.internal/computeMetadata/v1/', expect: 'local-name' },
  // IDNA folds the confusable to ASCII, so the name check sees `localhost`.
  { url: 'https://ⓛocalhost/', expect: 'local-name' },
  // --- dotless names --------------------------------------------------------------------------
  { url: 'https://intranet/', expect: 'dotless-name' },
  { url: 'https://wiki/', expect: 'dotless-name' },
  // --- allowlist ------------------------------------------------------------------------------
  { url: 'https://nas.local/share', resolves: '192.168.1.9', expect: undefined, policy: ALLOWING },
  { url: 'http://nas.local/share', resolves: '192.168.1.9', expect: undefined, policy: ALLOWING },
  { url: 'https://192.168.1.20:8443/', expect: undefined, policy: ALLOWING },
  { url: 'http://192.168.1.20:8443/', expect: undefined, policy: ALLOWING },
  { url: 'https://[fd00::1]/', expect: undefined, policy: ALLOWING },
  // http allowed, private not: the two lists are independent.
  { url: 'http://plain.local/', expect: 'local-name', policy: HTTP_ONLY },
  { url: 'http://plain.local:81/', expect: 'scheme', policy: HTTP_ONLY },
  // Exact, so a different port, a different host and a subdomain are all still refused.
  { url: 'https://nas.local:8443/', expect: 'port', policy: ALLOWING },
  { url: 'https://other.local/', expect: 'local-name', policy: ALLOWING },
  { url: 'https://sub.nas.local/', expect: 'local-name', policy: ALLOWING },
  { url: 'https://192.168.1.21:8443/', expect: 'port', policy: ALLOWING },
  { url: 'http://192.168.1.20/', expect: 'scheme', policy: ALLOWING },
];

/** `08` §3.9 rule 2: the resolved address, including every literal encoding of it. */
const ADDRESS_CASES: readonly Case[] = [
  // --- loopback, in every encoding the URL parser normalises --------------------------------
  { url: 'https://127.0.0.1/', expect: 'blocked-address' },
  { url: 'https://127.1/', expect: 'blocked-address' },
  { url: 'https://0177.0.0.1/', expect: 'blocked-address' },
  { url: 'https://0x7f.1/', expect: 'blocked-address' },
  { url: 'https://2130706433/', expect: 'blocked-address' },
  { url: 'https://0/', expect: 'blocked-address' },
  { url: 'https://[::1]/', expect: 'blocked-address' },
  { url: 'https://[0:0:0:0:0:0:0:1]/', expect: 'blocked-address' },
  // --- cloud metadata, which is the one an attacker actually wants --------------------------
  { url: 'https://169.254.169.254/latest/meta-data/', expect: 'blocked-address' },
  { url: 'https://169.254.170.2/v2/credentials', expect: 'blocked-address' },
  { url: 'https://2852039166/', expect: 'blocked-address' },
  { url: 'https://0251.0376.0251.0376/', expect: 'blocked-address' },
  { url: 'https://[::ffff:169.254.169.254]/', expect: 'blocked-address' },
  { url: 'https://[64:ff9b::a9fe:a9fe]/', expect: 'blocked-address' },
  { url: 'https://[2002:a9fe:a9fe::]/', expect: 'blocked-address' },
  // --- RFC 1918 and friends ------------------------------------------------------------------
  { url: 'https://10.0.0.1/', expect: 'blocked-address' },
  { url: 'https://172.16.0.1/', expect: 'blocked-address' },
  { url: 'https://172.31.255.255/', expect: 'blocked-address' },
  { url: 'https://192.168.1.1/', expect: 'blocked-address' },
  { url: 'https://100.100.100.100/', expect: 'blocked-address' },
  { url: 'https://198.18.0.1/', expect: 'blocked-address' },
  { url: 'https://224.0.0.1/', expect: 'blocked-address' },
  { url: 'https://255.255.255.255/', expect: 'blocked-address' },
  { url: 'https://0.0.0.0/', expect: 'blocked-address' },
  // --- IPv6 ranges ----------------------------------------------------------------------------
  { url: 'https://[fd00::1]/', expect: 'blocked-address' },
  { url: 'https://[fe80::1]/', expect: 'blocked-address' },
  { url: 'https://[fec0::1]/', expect: 'blocked-address' },
  { url: 'https://[ff02::1]/', expect: 'blocked-address' },
  { url: 'https://[2001:db8::1]/', expect: 'blocked-address' },
  { url: 'https://[2001::1]/', expect: 'blocked-address' },
  { url: 'https://[100::1]/', expect: 'blocked-address' },
  { url: 'https://[3fff::1]/', expect: 'blocked-address' },
  { url: 'https://[5f00::1]/', expect: 'blocked-address' },
  { url: 'https://[::]/', expect: 'blocked-address' },
  // --- the embedded-IPv4 forms, with a private target ----------------------------------------
  { url: 'https://[::ffff:10.0.0.1]/', expect: 'blocked-address' },
  { url: 'https://[::ffff:a00:1]/', expect: 'blocked-address' },
  { url: 'https://[::10.0.0.1]/', expect: 'blocked-address' },
  { url: 'https://[64:ff9b::c0a8:101]/', expect: 'blocked-address' },
  { url: 'https://[2002:c0a8:101::]/', expect: 'blocked-address' },
  // --- a name that resolves somewhere private (the rebinding target) -------------------------
  { url: 'https://evil.example/', resolves: '127.0.0.1', expect: 'blocked-address' },
  { url: 'https://evil.example/', resolves: '169.254.169.254', expect: 'blocked-address' },
  { url: 'https://evil.example/', resolves: '::1', expect: 'blocked-address' },
  { url: 'https://evil.example/', resolves: '::ffff:7f00:1', expect: 'blocked-address' },
  { url: 'https://evil.example/', resolves: '64:ff9b::7f00:1', expect: 'blocked-address' },
  { url: 'https://evil.example/', resolves: '2002:7f00:1::', expect: 'blocked-address' },
  { url: 'https://evil.example/', resolves: 'not-an-address', expect: 'blocked-address' },
  // --- public addresses, which must be reachable ---------------------------------------------
  { url: 'https://example.com/', resolves: '93.184.216.34', expect: undefined },
  { url: 'https://example.com/', resolves: '1.1.1.1', expect: undefined },
  { url: 'https://example.com/', resolves: '8.8.8.8', expect: undefined },
  { url: 'https://example.com/', resolves: '2606:4700::1111', expect: undefined },
  { url: 'https://example.com/', resolves: '2001:4860:4860::8888', expect: undefined },
  { url: 'https://93.184.216.34/', expect: undefined },
  { url: 'https://[2606:4700::1111]/', expect: undefined },
  // --- allowlisted private targets ------------------------------------------------------------
  // An allowlisted host that resolves to loopback is still allowed: the host named this host:port,
  // and `08` §3.9's allowlist is host-only config (SD-21), so this is their decision to make.
  { url: 'https://nas.local/', resolves: '127.0.0.1', expect: undefined, policy: ALLOWING },
  { url: 'https://nas.local/', resolves: '169.254.169.254', expect: undefined, policy: ALLOWING },
];

const ALL_CASES: readonly Case[] = [...URL_CASES, ...ADDRESS_CASES];

/** Run one case all the way through both classifiers. */
function verdict(testCase: Case): EgressReason | undefined {
  const classified = classifyUrl(testCase.url, testCase.policy ?? EMPTY_POLICY);
  if (!classified.ok) return classified.error.reason;
  const address = classified.value.literalAddress ?? testCase.resolves;
  if (address === undefined) return 'no-address';
  return classifyAddress(address, classified.value)?.reason;
}

describe('sec.ssrf.* — the SSRF matrix (08 §3.9, 10 §9)', () => {
  it('has at least the 60 cases 10 §9 asks for', () => {
    // Asserted, because "≥ 60 cases" is an acceptance criterion and a matrix that quietly shrinks
    // is a matrix that stopped covering something.
    expect(ALL_CASES.length).toBeGreaterThanOrEqual(60);
    // And no duplicates: two identical rows inflate the count without adding a case.
    const keys = ALL_CASES.map(
      (one) => `${one.url}|${one.resolves ?? ''}|${JSON.stringify(one.policy ?? {})}`,
    );
    expect(new Set(keys).size).toBe(ALL_CASES.length);
  });

  it.each(
    ALL_CASES.map(
      (one) =>
        [`${one.url}${one.resolves === undefined ? '' : ` → ${one.resolves}`}`, one] as const,
    ),
  )('%s', (_label, testCase) => {
    expect(verdict(testCase)).toBe(testCase.expect);
  });

  it('refuses more than it allows, and allows something', () => {
    // Non-vacuity in both directions: a classifier that refused everything would pass every
    // refusal case above, and one that allowed everything would pass every allow case.
    const refused = ALL_CASES.filter((one) => one.expect !== undefined).length;
    const allowed = ALL_CASES.filter((one) => one.expect === undefined).length;
    expect(allowed).toBeGreaterThanOrEqual(10);
    expect(refused).toBeGreaterThan(allowed);
  });
});

describe('the embedded IPv4 is named in the refusal (08 §3.9 †)', () => {
  it.each([
    ['::ffff:a9fe:a9fe', '169.254.169.254', 'an IPv4-mapped address'],
    ['64:ff9b::a9fe:a9fe', '169.254.169.254', 'NAT64'],
    ['2002:a9fe:a9fe::', '169.254.169.254', '6to4'],
    ['::a9fe:a9fe', '169.254.169.254', 'an IPv4-compatible address'],
  ])('%s carries %s', (address, expected, via) => {
    expect(embeddedIpv4(address)).toEqual({ address: expected, via });
    const classified = classifyUrl(`https://[${address}]/`, EMPTY_POLICY);
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    const refusal = classifyAddress(address, classified.value);
    // The detail names the IPv4 address and how it was carried, because an audit event saying
    // `64:ff9b::/96` sends a host to a search engine and one saying `169.254.169.254 through
    // NAT64` tells them what happened.
    expect(refusal?.detail).toContain(expected);
    expect(refusal?.detail).toContain(via);
  });

  it('leaves a plain IPv6 address alone', () => {
    expect(embeddedIpv4('2606:4700::1111')).toBeUndefined();
    expect(embeddedIpv4('fd00::1')).toBeUndefined();
    expect(embeddedIpv4('not-an-address')).toBeUndefined();
    expect(embeddedIpv4('127.0.0.1')).toBeUndefined();
  });
});

describe('fuzz.ssrf.classify (08 §3.9)', () => {
  it('never throws, whatever the string', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (raw) => {
        expect(() => classifyUrl(raw, EMPTY_POLICY)).not.toThrow();
      }),
      fcConfig({ numRuns: 500 }),
    );
  });

  it('never allows a private address, however it is spelled', () => {
    // The generator builds addresses *inside* the denied ranges and spells each in four ways. The
    // property is the invariant I5 depends on: no spelling of a private address is reachable.
    const privateIpv4 = fc.oneof(
      fc.tuple(fc.constant(127), fc.nat(255), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(10), fc.nat(255), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(192), fc.constant(168), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(169), fc.constant(254), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), fc.nat(255), fc.nat(255)),
    );
    fc.assert(
      fc.property(privateIpv4, fc.nat(3), (octets, spelling) => {
        const [a, b, c, d] = octets;
        const dotted = octets.join('.');
        const decimal = String(((a ?? 0) << 24) + ((b ?? 0) << 16) + ((c ?? 0) << 8) + (d ?? 0));
        const octal = octets.map((part) => `0${part.toString(8)}`).join('.');
        const mapped = `[::ffff:${dotted}]`;
        const host = [dotted, decimal, octal, mapped][spelling] ?? dotted;
        const classified = classifyUrl(`https://${host}/`, EMPTY_POLICY);
        if (!classified.ok) return;
        const address = classified.value.literalAddress;
        expect(address, host).toBeDefined();
        if (address === undefined) return;
        expect(classifyAddress(address, classified.value), host).toBeDefined();
      }),
      fcConfig({ numRuns: 500 }),
    );
  });

  it('never allows a resolved address inside a denied range', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.tuple(fc.constant(127), fc.nat(255), fc.nat(255), fc.nat(255)).map((o) => o.join('.')),
          fc.tuple(fc.constant(10), fc.nat(255), fc.nat(255), fc.nat(255)).map((o) => o.join('.')),
          fc.constantFrom('::1', 'fd00::1', 'fe80::1', '::ffff:7f00:1', '64:ff9b::7f00:1'),
        ),
        (address) => {
          const classified = classifyUrl('https://public.example/', EMPTY_POLICY);
          expect(classified.ok).toBe(true);
          if (!classified.ok) return;
          expect(classifyAddress(address, classified.value), address).toBeDefined();
        },
      ),
      fcConfig({ numRuns: 500 }),
    );
  });
});

describe('isLoopbackHost (M2-T16)', () => {
  it('accepts the whole 127.0.0.0/8 block and localhost', () => {
    for (const host of [
      '127.0.0.1',
      '127.0.0.2',
      '127.1.2.3',
      '127.255.255.254',
      'localhost',
      'LOCALHOST',
      'localhost.',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it('accepts IPv6 loopback in both spellings', () => {
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    // The URL parser re-spells `::ffff:127.0.0.1` in hex, which is the form that reaches here.
    expect(isLoopbackHost('::ffff:7f00:1')).toBe(true);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
  });

  it('refuses a name that merely starts with the loopback digits', () => {
    // The bug this function exists to prevent. `/^127\./` matches all of these, and every one is
    // a name whose owner decides where it resolves — so a `privacy.localOnly` check built on a
    // regex would accept a route to somebody else's server as "this machine".
    for (const host of [
      '127.0.0.1.evil.example',
      '127.0.0.1.nip.io',
      '127.0.0.1x',
      '127.0.0',
      '1270.0.0.1',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('refuses every other address and name', () => {
    for (const host of [
      '10.0.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::',
      'fd00::1',
      'example.com',
      'gpu.lan',
      '',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it('refuses a name that resolves to loopback, because DNS can change', () => {
    // A destination decided by DNS is a destination that can change between the check and the
    // connection. `safeFetch` re-checks the resolved address for exactly that reason, and this
    // function deliberately does not resolve anything.
    expect(isLoopbackHost('localtest.me')).toBe(false);
  });
});
