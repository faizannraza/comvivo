/**
 * Human-typed codes (`08` §3.7.12).
 *
 * The interesting assertions here are all about *forgiveness in one direction only*: a member who
 * types what they saw must get in, and a member who types something else must not. Crockford's
 * substitutions are the forgiving half; the length and alphabet checks are the other.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import { sha256 } from '../crypto/hmac.js';
import { CROCKFORD_ALPHABET } from '../crypto/random.js';
import { fcConfig } from '../testing/index.js';
import {
  CLAIM_CODE_PREFIX,
  canonicalizeTypedCode,
  claimCodePrefixFor,
  mintClaimCode,
  mintTypedCode,
  parseClaimCode,
  parseTypedCode,
  TYPED_CODE_CHARS,
} from './codes.js';

describe('the claim-code prefix', () => {
  it('derives from the brand by a rule that reproduces the spec’s own example', () => {
    // `08` §3.7.12 writes `VLG-XXXX-XXXX`, from the name the spec was written with. Drop the
    // vowels, collapse runs of the same letter, take three: that reproduces it exactly. The
    // collapsing step is here because the first version of the rule did not have it and produced
    // `VLL` — the comment claimed the spec's example and this assertion disagreed.
    expect(claimCodePrefixFor('village')).toBe('VLG');
    // An arbitrary slug, to show the rule rather than one example. Not the drill's own throwaway
    // slug: during a rename drill that string *is* the brand, and the brand guard would then
    // report this file for hard-coding it.
    expect(claimCodePrefixFor('bazqux')).toBe('BZQ');
    // A slug left with fewer than three characters falls back to its own first three, so the rule
    // is total for any brand.
    expect(claimCodePrefixFor('aeiou')).toBe('AEI');
    expect(claimCodePrefixFor('a-b')).toBe('AB');
    expect(claimCodePrefixFor('bb')).toBe('BB');
  });

  it('is the prefix every claim code carries', () => {
    // Asserted against `BRAND` rather than against today's three letters: a test that spelled the
    // current brand's prefix out would be a second place a rename has to be applied, which is the
    // thing `BRAND` exists to prevent (and `brand:check` enforces).
    expect(CLAIM_CODE_PREFIX).toBe(claimCodePrefixFor(BRAND.slug));
    expect(CLAIM_CODE_PREFIX).toMatch(/^[A-Z0-9]{1,3}$/);
    expect(mintClaimCode().expose()).toMatch(
      new RegExp(`^${CLAIM_CODE_PREFIX}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$`),
    );
  });
});

describe('canonicalisation (08 §3.7.12)', () => {
  it('accepts every way a person will type the same code', () => {
    const code = mintTypedCode().expose();
    const canonical = canonicalizeTypedCode(code);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    const plain = canonical.value;
    for (const spelling of [
      plain,
      plain.toLowerCase(),
      `${plain.slice(0, 4)}-${plain.slice(4)}`,
      `${plain.slice(0, 4)} ${plain.slice(4)}`,
      `${plain.slice(0, 4)}_${plain.slice(4)}`,
      `${plain.slice(0, 4)}–${plain.slice(4)}`,
    ]) {
      const parsed = parseTypedCode(spelling);
      expect(parsed.ok, spelling).toBe(true);
      if (parsed.ok) expect(parsed.value.canonical).toBe(plain);
    }
  });

  it('maps the characters people confuse, and only those', () => {
    // Crockford *decoding*: `I` and `L` are `1`, `O` is `0`. `U` is not a confusion of anything —
    // it is excluded so generated codes cannot spell obscenities — so it stays a refusal.
    const parsed = parseTypedCode('ILO1-230O');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.canonical).toBe('11012300');
    expect(parseTypedCode('UUUU-1234').ok).toBe(false);
  });

  it('refuses rather than strips an impossible character', () => {
    // Stripping would accept `K3M9!!0P2T` as the code `K3M90P2T`, and would let a guess be padded
    // to whatever length a downstream check expected.
    for (const bad of ['K3M9!!0P', 'K3M9+0P2', '!!!!!!!!', `K3M9${String.fromCharCode(0)}P2T`]) {
      const parsed = parseTypedCode(bad);
      expect(parsed.ok, bad).toBe(false);
      if (!parsed.ok) expect(parsed.error.reason).toBe('not-crockford');
    }
  });

  it('refuses the wrong length, and the empty string', () => {
    const short = canonicalizeTypedCode('K3M9');
    expect(short.ok).toBe(false);
    if (!short.ok && short.error.reason === 'wrong-length') {
      expect(short.error.expected).toBe(TYPED_CODE_CHARS);
      expect(short.error.actual).toBe(4);
    }
    const long = canonicalizeTypedCode('K3M9-0P2T-Z');
    expect(long.ok).toBe(false);
    const empty = canonicalizeTypedCode('');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.reason).toBe('empty');
  });

  it('digests the canonical form, so the stored digest is spelling-independent', () => {
    const parsed = parseTypedCode('k3m9-0p2t');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The digest a host stores is of `K3M90P2T`. Hashing the raw input would make the display
    // format part of the secret, and the first pasted code with a trailing space would be refused.
    expect(parsed.value.digest.equals(sha256('K3M90P2T'))).toBe(true);
  });
});

describe('the claim code', () => {
  it('is accepted with or without its prefix, in any case', () => {
    const minted = mintClaimCode().expose();
    const body = minted.slice(CLAIM_CODE_PREFIX.length + 1);
    const withPrefix = parseClaimCode(minted);
    const withoutPrefix = parseClaimCode(body);
    expect(withPrefix.ok && withoutPrefix.ok).toBe(true);
    if (!withPrefix.ok || !withoutPrefix.ok) return;
    // The same digest either way, because the prefix carries no entropy — it is there so a host
    // with two codes in front of them knows which is which.
    expect(withPrefix.value.digest.equals(withoutPrefix.value.digest)).toBe(true);
    expect(parseClaimCode(minted.toLowerCase()).ok).toBe(true);
    expect(parseClaimCode(`  ${minted}  `).ok).toBe(true);
  });

  it('refuses a code carrying another brand’s prefix', () => {
    const body = mintClaimCode()
      .expose()
      .slice(CLAIM_CODE_PREFIX.length + 1);
    // `VLG-` is the old brand's prefix: eleven characters once canonicalised, so it fails on
    // length rather than being quietly accepted.
    expect(parseClaimCode(`VLG-${body}`).ok).toBe(false);
  });
});

describe('typed codes, as a property', () => {
  it('round-trips every minted code, and canonicalisation is idempotent', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const code = mintTypedCode().expose();
        const once = canonicalizeTypedCode(code);
        expect(once.ok).toBe(true);
        if (!once.ok) return;
        const twice = canonicalizeTypedCode(once.value);
        expect(twice.ok).toBe(true);
        if (twice.ok) expect(twice.value).toBe(once.value);
        for (const char of once.value) expect(CROCKFORD_ALPHABET).toContain(char);
      }),
      fcConfig(),
    );
  });

  it('never throws, whatever the string', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (input) => {
        expect(() => parseTypedCode(input)).not.toThrow();
        expect(() => parseClaimCode(input)).not.toThrow();
      }),
      fcConfig(),
    );
  });
});
