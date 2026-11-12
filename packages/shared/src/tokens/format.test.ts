/**
 * The token table, the MCP token's two halves, and the names a host sees (`08` §3.7.12, §3.8.1).
 *
 * `format.prop.test.ts` holds the properties. This file pins the things a property cannot state:
 * the literal prefixes and lengths `08` §3.7.12 specifies, the digest's known answer, and the
 * cookie and header names — which are derived from `BRAND`, so a rename cannot leave one behind.
 */
import { describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import { sha256 } from '../crypto/hmac.js';
import {
  CSRF_HEADER,
  MCP_TOKEN_PREFIX,
  mintMcpToken,
  mintToken,
  parseMcpToken,
  parseToken,
  pendingCookieName,
  sessionCookieName,
  TOKEN_SHAPES,
  type TokenKind,
} from './format.js';

const MTK = `mtk_${'0123456789abcdefghjkmnpq'}rs`;

describe('08 §3.7.12’s token table', () => {
  it('is the prefixes and entropies the spec writes, not similar ones', () => {
    // Pinned as literals on purpose: these appear in cookies, URLs and member agents' configs, so
    // a change here is a change to stored credentials. A test that derived them from the code would
    // agree with whatever the code said.
    expect(TOKEN_SHAPES).toEqual({
      pendingLogin: { prefix: 'vlp_', bytes: 32, chars: 43, where: expect.any(String) },
      session: { prefix: 'vs1_', bytes: 32, chars: 43, where: expect.any(String) },
      control: { prefix: 'vctl_', bytes: 32, chars: 43, where: expect.any(String) },
      icsFeed: { prefix: 'vics_', bytes: 32, chars: 43, where: expect.any(String) },
      claimLink: { prefix: 'c_', bytes: 16, chars: 22, where: expect.any(String) },
      inviteLink: { prefix: 'lnk_', bytes: 16, chars: 22, where: expect.any(String) },
    });
  });

  it('mints a token of the shape its row describes', () => {
    for (const [kind, shape] of Object.entries(TOKEN_SHAPES)) {
      const minted = mintToken(kind as TokenKind).expose();
      expect(minted.startsWith(shape.prefix), kind).toBe(true);
      expect(minted).toHaveLength(shape.prefix.length + shape.chars);
      // A `SecretString`, so it cannot reach a log by accident (`08` §3.7.13).
      expect(String(mintToken(kind as TokenKind))).toBe('[redacted]');
    }
  });

  it('digests the whole token, prefix included', () => {
    // A known answer, because the digest is the lookup key: changing what is hashed would quietly
    // orphan every stored row. Including the prefix binds a digest to its kind.
    const parsed = parseToken('session', 'vs1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      parsed.value.digest.equals(sha256('vs1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')),
    ).toBe(true);
    expect(parsed.value.digest.equals(sha256('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))).toBe(
      false,
    );
  });

  it('explains each refusal without quoting the token', () => {
    const cases: readonly [string, string][] = [
      ['', 'empty'],
      ['vics_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'wrong-prefix'],
      ['vs1_short', 'wrong-length'],
      ['vs1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+', 'not-base64url'],
    ];
    for (const [input, reason] of cases) {
      const parsed = parseToken('session', input);
      expect(parsed.ok, input).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.reason, input).toBe(reason);
        // The reason is logged, so it must not carry the secret.
        expect(JSON.stringify(parsed.error)).not.toContain('AAAA');
      }
    }
  });
});

describe('the MCP personal access token (08 §3.7.12; 10 §3.7)', () => {
  it('carries the id of its own row', () => {
    const minted = mintMcpToken(MTK).expose();
    expect(minted.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    const parsed = parseMcpToken(minted);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.id).toBe(MTK);
    expect(parsed.value.kind).toBe('mcp');
    // The id travels in the token so a lookup is a primary-key read: a revoked row can be refused
    // by id, without a comparison whose timing depends on the secret.
    expect(parsed.value.digest.equals(sha256(minted))).toBe(true);
  });

  it('refuses to mint for anything that is not an mtk_ id', () => {
    for (const bad of [
      '',
      'mtk_short',
      'prs_01jxpf00000000000000000000',
      `mtk_${'u'.repeat(26)}`,
    ]) {
      // `u` is not in the lowercase Crockford alphabet `ids.ts` encodes with, so the last case is
      // the right length and still not an id.
      expect(() => mintMcpToken(bad), bad).toThrow(/mtk_ id/);
    }
  });

  it('refuses every malformed presentation', () => {
    // A fixed body, not the minted one: base64url includes `_`, so a random secret half makes
    // "there is no separator" a case that only *sometimes* holds — which is a flaky test and an
    // uncovered branch at the same time. Found by the branch report.
    const body = 'A'.repeat(43);
    const cases: readonly [string, string][] = [
      ['', 'empty'],
      [`vs1_${body}`, 'wrong-prefix'],
      [`${MCP_TOKEN_PREFIX}${MTK.slice(4)}_${body}`, ''],
      // No separator at all: the id and the secret run together.
      [`${MCP_TOKEN_PREFIX}${MTK.slice(4)}${body}`, 'wrong-length'],
      [`${MCP_TOKEN_PREFIX}${MTK.slice(4)}_short`, 'wrong-length'],
      // Uppercase in the id half: a typeid suffix is lowercase Crockford.
      [`${MCP_TOKEN_PREFIX}${MTK.slice(4).toUpperCase()}_${body}`, 'not-crockford'],
      [`${MCP_TOKEN_PREFIX}${MTK.slice(4)}_${body.slice(0, -1)}+`, 'not-base64url'],
    ];
    for (const [input, reason] of cases) {
      const parsed = parseMcpToken(input);
      // The one with no reason is the well-formed control: a list of refusals that never accepts
      // anything proves only that the parser says no.
      expect(parsed.ok, input).toBe(reason === '');
      if (!parsed.ok) expect(parsed.error.reason, input).toBe(reason);
    }
  });
});

describe('the names a host sees (08 §3.8.1)', () => {
  it('derives every cookie name from the brand', () => {
    expect(sessionCookieName('host')).toBe(`__Host-${BRAND.slug}_session`);
    expect(sessionCookieName('secure')).toBe(`__Secure-${BRAND.slug}_session`);
    expect(sessionCookieName('plain')).toBe(`${BRAND.slug}_session`);
    expect(pendingCookieName('host')).toBe(`__Host-${BRAND.slug}_pending`);
    expect(pendingCookieName('plain')).toBe(`${BRAND.slug}_pending`);
    // The prefixes are the browser's, not ours: `__Host-` is refused by the browser unless the
    // cookie is `Secure`, has no `Domain` and is scoped to `/`, which is why loopback gets neither.
    expect(sessionCookieName('host').startsWith('__Host-')).toBe(true);
    expect(CSRF_HEADER).toBe(`X-${BRAND.displayName}-CSRF`);
  });

  it('never hard-codes the product name', () => {
    // The guard that matters for a rename: every name here is built from `BRAND`, so the weekly
    // drill cannot leave a stale one behind. Asserted by construction rather than by grep.
    for (const name of [sessionCookieName('host'), pendingCookieName('secure'), CSRF_HEADER]) {
      expect(name.toLowerCase()).toContain(BRAND.slug.toLowerCase());
    }
  });
});
