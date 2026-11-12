/**
 * Human-typed codes: the pairing code, the host and group claim codes, the group link code
 * (`08` §3.7.12, `06` §3.18.1).
 *
 * These are read off a screen and typed into a chat, so three things have to be true at once:
 *
 *  - **The alphabet forgives the confusions people actually make.** Crockford base32 has no `I`,
 *    `L`, `O` or `U`, and *decoding* maps `I` and `L` to `1` and `O` to `0` — so a member who types
 *    what they saw gets in. `U` is absent rather than mapped: it is excluded so that generated
 *    codes cannot spell obscenities, and it is not a confusion of anything.
 *  - **Normalisation happens before hashing, on both sides.** The stored digest is of the
 *    canonical form, so `cmv-k3m9-0p2t`, `CMV K3M9 OP2T` and `K3M90P2T` are one code. Hashing the
 *    raw input instead would make the display format part of the secret, and the first person to
 *    paste a code with a trailing space would be locked out.
 *  - **Their safety is not entropy.** Forty bits is guessable; what protects them is a short TTL,
 *    single use and a hard attempt limit (`08` §3.7.12, `06` §3.20.1). Nothing here should read as
 *    a claim otherwise.
 *
 * Specification: `docs/plan/08-security-privacy.md` §3.7.12.
 */
import { BRAND } from '../brand.js';
import { sha256 } from '../crypto/hmac.js';
import { CROCKFORD_ALPHABET, randomTypedCode } from '../crypto/random.js';
import { err, ok, type Result } from '../result.js';
import { SecretString } from '../secrets/secret-string.js';
import type { TokenRejection } from './format.js';

/** `08` §3.7.12: eight Crockford characters, 40 bits. */
export const TYPED_CODE_CHARS = 8;
const GROUP_SIZE = 4;

/**
 * The claim code's human prefix (`VLG-XXXX-XXXX` in `08` §3.7.12, written for the old name).
 *
 * Derived from `BRAND`, because this one *is* a brand surface: it is printed on a console, read
 * aloud and typed by a host.
 *
 * The rule is: drop the vowels, collapse runs of the same letter, take three — which reproduces
 * the spec's own example (`village` → V, L, L, G → `VLG`) and gives `CMV` for `comvivo` (C, M, V,
 * V). The collapsing step is not decoration: without it `village` yields `VLL`, which is how this
 * comment first read before the test was written. A slug left with fewer than three characters
 * falls back to its own first three, so the rule is total for any brand — including the throwaway
 * slug the weekly rename drill picks.
 *
 * Exported as a function of the slug, not only as the constant, so that derivation is a test rather
 * than a claim in a comment.
 */
export function claimCodePrefixFor(slug: string): string {
  const upper = slug.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const collapsed = upper.replace(/[AEIOU]/g, '').replace(/(.)\1+/g, '$1');
  return (collapsed.length >= 3 ? collapsed : upper).slice(0, 3);
}

export const CLAIM_CODE_PREFIX = claimCodePrefixFor(BRAND.slug);

/** A parsed code, in the one form that is ever hashed or compared. */
export interface ParsedCode {
  /** Uppercase, no separators, no prefix: eight Crockford characters. */
  readonly canonical: string;
  /** SHA-256 of `canonical`. What `08` §3.7.12 stores. */
  readonly digest: Buffer;
}

/** `XXXX-XXXX` — the pairing code and the link code (`06` §3.18.1). */
export function mintTypedCode(): SecretString {
  return new SecretString('typedCode', randomTypedCode(TYPED_CODE_CHARS / GROUP_SIZE, GROUP_SIZE));
}

/** `CMV-XXXX-XXXX` — the host and group claim codes, printed on the console. */
export function mintClaimCode(): SecretString {
  return new SecretString(
    'claimCode',
    `${CLAIM_CODE_PREFIX}-${randomTypedCode(TYPED_CODE_CHARS / GROUP_SIZE, GROUP_SIZE)}`,
  );
}

/** Crockford's decoding substitutions, applied after uppercasing. */
const SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([
  ['I', '1'],
  ['L', '1'],
  ['O', '0'],
]);

/**
 * Canonicalise a typed code: uppercase, separators dropped, Crockford substitutions applied.
 *
 * Separators are space, hyphen, en dash and underscore — what a chat client, a PDF or a person
 * will put between the groups. Anything else is a character the code cannot contain, and is
 * refused rather than stripped: silently dropping unknown characters would accept `K3M9!!0P2T`
 * and, worse, would let an attacker pad a guess into whatever length a check expected.
 */
export function canonicalizeTypedCode(input: string): Result<string, TokenRejection> {
  if (input === '') return err({ reason: 'empty' });
  let canonical = '';
  for (const raw of input.toUpperCase()) {
    if (raw === '-' || raw === ' ' || raw === '_' || raw === '–') continue;
    const mapped = SUBSTITUTIONS.get(raw) ?? raw;
    if (!CROCKFORD_ALPHABET.includes(mapped)) return err({ reason: 'not-crockford' });
    canonical += mapped;
  }
  if (canonical.length !== TYPED_CODE_CHARS) {
    return err({
      reason: 'wrong-length',
      expected: TYPED_CODE_CHARS,
      actual: canonical.length,
    });
  }
  return ok(canonical);
}

/** A pairing or link code as typed by a member. */
export function parseTypedCode(input: string): Result<ParsedCode, TokenRejection> {
  const canonical = canonicalizeTypedCode(input);
  if (!canonical.ok) return canonical;
  return ok({ canonical: canonical.value, digest: sha256(canonical.value) });
}

/**
 * A claim code, with or without its prefix.
 *
 * Both, deliberately. The prefix carries no entropy — it is there so a host who sees two codes
 * knows which is which — so refusing a host who typed the eight characters they were asked for
 * would be a worse failure than accepting a shape the console never printed. The code is single
 * use with a 30-minute TTL and is burned after ten failed attempts, which is where its safety
 * comes from.
 */
export function parseClaimCode(input: string): Result<ParsedCode, TokenRejection> {
  const upper = input.trim().toUpperCase();
  const withoutPrefix = upper.startsWith(`${CLAIM_CODE_PREFIX}-`)
    ? upper.slice(CLAIM_CODE_PREFIX.length + 1)
    : upper;
  return parseTypedCode(withoutPrefix);
}
