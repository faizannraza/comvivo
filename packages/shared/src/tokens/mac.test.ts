/**
 * The derived tokens, and the two properties that make them safe (`08` §3.7.12).
 *
 * **Epoch invalidation** is the headline: every CSRF token and magic link is a MAC under
 * `HKDF(RDK, …, "token-mac/epoch=<e>")`, so bumping the epoch invalidates all of them at once with
 * nothing to delete. The tests derive the keys for two epochs through the **real** HKDF, because
 * the claim is about the key schedule and a hand-made pair of keys would prove only that two
 * different keys produce two different MACs.
 *
 * **The order of checks**: a tampered payload must be refused by the MAC, before anything reads a
 * field out of it.
 */

import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { derivePurposeKey } from '../crypto/hkdf.js';
import { hmacSha256Base64Url, sha256 } from '../crypto/hmac.js';
import { tokenMacPurpose } from '../crypto/labels.js';
import type { InstanceId, PersonId } from '../ids.js';
import { CLOCK_SKEW_SECONDS, MAGIC_LINK_TAG, tokenMac } from './mac.js';

const ROOT = Buffer.alloc(32, 7);
const INSTANCE = 'inst_01jxpf00000000000000000000' as InstanceId;
const OTHER_INSTANCE = 'inst_01jxpg00000000000000000000' as InstanceId;
const PERSON = 'prs_01jxpf00000000000000000000' as PersonId;
const NOW = Temporal.Instant.from('2026-11-11T12:00:00Z');
const SESSION_DIGEST = sha256('vs1_a-session-token');

/** The key for one epoch, derived the way `KeyService.tokenMacKey` derives it. */
const macFor = (epoch: number) =>
  tokenMac(derivePurposeKey(ROOT, INSTANCE, tokenMacPurpose(epoch)), INSTANCE, epoch);

describe('the CSRF token (08 §3.7.12, §3.8.6)', () => {
  it('derives from the session digest and verifies in constant time', () => {
    const mac = macFor(0);
    const token = mac.csrf(SESSION_DIGEST);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mac.verifyCsrf(SESSION_DIGEST, token)).toBe(true);
    // A different session gets a different token, which is the whole point of a synchroniser: a
    // token lifted from one session must not work in another.
    expect(mac.verifyCsrf(sha256('vs1_another-session'), token)).toBe(false);
    expect(mac.verifyCsrf(SESSION_DIGEST, '')).toBe(false);
    // The replacement character is chosen *against* the token's own last character: a fixed `A`
    // would be a no-op whenever the MAC happens to end in `A`, and the key here is fixed, so that
    // is a coin flip decided at authoring time. It came up heads.
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(mac.verifyCsrf(SESSION_DIGEST, flipped)).toBe(false);
  });

  it('refuses anything but a 32-byte session digest', () => {
    // A caller passing the session *token* instead of its digest would otherwise get a CSRF token
    // that verifies — against the wrong input, in a way no test downstream would notice.
    expect(() => macFor(0).csrf(Buffer.alloc(16))).toThrow(/32-byte SHA-256/);
  });

  it('stops verifying when the epoch is bumped', () => {
    const before = macFor(0).csrf(SESSION_DIGEST);
    expect(macFor(1).verifyCsrf(SESSION_DIGEST, before)).toBe(false);
    // And the new epoch's own token verifies, so the invalidation is the key schedule rather than
    // a broken derivation.
    const after = macFor(1).csrf(SESSION_DIGEST);
    expect(macFor(1).verifyCsrf(SESSION_DIGEST, after)).toBe(true);
    expect(before).not.toBe(after);
  });
});

describe('the magic link (08 §3.7.12)', () => {
  it('mints `vml1.<payload>.<mac>` and verifies it', () => {
    const mac = macFor(0);
    const token = mac.mintMagicLink(PERSON, NOW, 600).expose();
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(MAGIC_LINK_TAG);
    const verified = mac.verifyMagicLink(token, NOW);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.sub).toBe(PERSON);
    expect(verified.value.aud).toBe(INSTANCE);
    expect(verified.value.purpose).toBe('login');
    expect(verified.value.exp).toBe(Math.floor(NOW.epochMilliseconds / 1000) + 600);
    // 128 bits of `jti`, which is the row that records single use — so two links minted in the
    // same millisecond must not share one. A fixed `jti` would make the second link consume the
    // first link's row, and the symptom would be "my login link says it was already used".
    expect(verified.value.jti).toHaveLength(22);
    const second = mac.mintMagicLink(PERSON, NOW, 600).expose();
    expect(second).not.toBe(token);
  });

  it('refuses a tampered payload at the MAC, before reading a field', () => {
    const mac = macFor(0);
    const token = mac.mintMagicLink(PERSON, NOW, 600).expose();
    const [, payload, signature] = token.split('.');
    // A payload that says what an attacker wants — a different subject, an expiry far away — and
    // is otherwise perfectly well-formed. The verdict has to be `bad-mac`: any other answer means
    // the verifier decoded it first, and a verifier that reads `sub` before checking the MAC has
    // already trusted it.
    const forged = Buffer.from(
      JSON.stringify({
        jti: 'AAAAAAAAAAAAAAAAAAAAAA',
        sub: 'prs_01jxpz00000000000000000000',
        aud: INSTANCE,
        purpose: 'login',
        exp: 99_999_999_999,
      }),
      'utf8',
    ).toString('base64url');
    const rejected = mac.verifyMagicLink(`${MAGIC_LINK_TAG}.${forged}.${signature ?? ''}`, NOW);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.reason).toBe('bad-mac');
    // **The ordering, pinned by an input where the two verdicts differ.** A garbage payload *and*
    // a garbage MAC must be reported as `bad-mac`: with the checks in the other order the answer is
    // `bad-payload`, which means the verifier read and described attacker bytes it had not
    // authenticated. A mutation that moved `decodePayload` above the comparison passed every other
    // assertion in this file, including the forged-payload case above — because a *well-formed*
    // forgery decodes cleanly either way.
    const bothWrong = mac.verifyMagicLink(`${MAGIC_LINK_TAG}.!!!!.AAAA`, NOW);
    expect(bothWrong.ok).toBe(false);
    if (!bothWrong.ok) expect(bothWrong.error.reason).toBe('bad-mac');

    // And the untouched payload with a flipped signature is refused the same way. The replacement
    // character is chosen against the signature's own last character — **again**, after the same
    // mistake in the CSRF test above. There it was deterministic (a fixed key, so the signature is
    // always the same) and here the `jti` is random, which made it a one-in-sixty-four flake that
    // passed locally and failed in the coverage run.
    const signed = signature ?? '';
    const flipped = mac.verifyMagicLink(
      `${MAGIC_LINK_TAG}.${payload ?? ''}.${signed.slice(0, -1)}${signed.endsWith('A') ? 'B' : 'A'}`,
      NOW,
    );
    expect(flipped.ok).toBe(false);
  });

  it('refuses a token from another instance, and one from another epoch', () => {
    const minted = macFor(0).mintMagicLink(PERSON, NOW, 600).expose();
    // Another epoch: a different key, so the MAC fails.
    const nextEpoch = macFor(1).verifyMagicLink(minted, NOW);
    expect(nextEpoch.ok).toBe(false);
    if (!nextEpoch.ok) expect(nextEpoch.error.reason).toBe('bad-mac');

    // Another instance **with the same key**, which is the case `aud` exists for: HKDF salts on the
    // instance id, so this cannot happen through the key schedule — only through a restore or a
    // copied data directory, which is exactly when a replayed login link would be dangerous.
    const sameKeyOtherInstance = tokenMac(
      derivePurposeKey(ROOT, INSTANCE, tokenMacPurpose(0)),
      OTHER_INSTANCE,
      0,
    );
    const wrongAudience = sameKeyOtherInstance.verifyMagicLink(minted, NOW);
    expect(wrongAudience.ok).toBe(false);
    if (!wrongAudience.ok) expect(wrongAudience.error.reason).toBe('wrong-audience');
  });

  it('expires, with the 60-second skew §3.7.13 allows', () => {
    const mac = macFor(0);
    const token = mac.mintMagicLink(PERSON, NOW, 600).expose();
    const justInside = NOW.add({ seconds: 600 + CLOCK_SKEW_SECONDS });
    const justOutside = NOW.add({ seconds: 600 + CLOCK_SKEW_SECONDS + 1 });
    expect(mac.verifyMagicLink(token, justInside).ok).toBe(true);
    const expired = mac.verifyMagicLink(token, justOutside);
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.error.reason).toBe('expired');
      // The verdict carries the expiry so a "your link has expired" message can say when, which is
      // the difference between a dead end and "ask for another one".
      if (expired.error.reason === 'expired') {
        expect(expired.error.expSeconds).toBe(Math.floor(NOW.epochMilliseconds / 1000) + 600);
      }
    }
  });

  it('refuses every malformed shape, and never throws', () => {
    const mac = macFor(0);
    const token = mac.mintMagicLink(PERSON, NOW, 600).expose();
    const [, payload, signature] = token.split('.');
    const cases: readonly string[] = [
      '',
      'vml1',
      'vml1.',
      `${MAGIC_LINK_TAG}.${payload ?? ''}`,
      `vml2.${payload ?? ''}.${signature ?? ''}`,
      // A dot inside the payload: the split must not shift, or the MAC would cover a different
      // structure than the one the reader believes it checked.
      `${MAGIC_LINK_TAG}.${payload ?? ''}.extra.${signature ?? ''}`,
      `.${payload ?? ''}.${signature ?? ''}`,
    ];
    for (const candidate of cases) {
      const result = mac.verifyMagicLink(candidate, NOW);
      expect(result.ok, JSON.stringify(candidate)).toBe(false);
    }
  });

  it('refuses a payload that is signed but not a login payload', () => {
    // Signed by the real key — so this is the case where the MAC passes and the *schema* is the
    // only thing standing between a forged shape and a session. Produced by signing by hand with
    // the same key the service uses.
    const mac = macFor(0);
    const sign = (json: unknown): string => {
      const encoded = Buffer.from(JSON.stringify(json), 'utf8').toString('base64url');
      // Re-derive the MAC the way `mintMagicLink` does, through the public surface: mint a token
      // for the same key and swap the payload in is not possible, so the signature comes from the
      // same primitive the module uses.
      const signed = `${MAGIC_LINK_TAG}.${encoded}`;
      return `${signed}.${csrfLikeMac(signed)}`;
    };
    const csrfLikeMac = (input: string): string => {
      // `hmacSha256Base64Url` with the epoch key — the same computation `mac.ts` performs.
      const key = derivePurposeKey(ROOT, INSTANCE, tokenMacPurpose(0));
      return hmacSha256Base64Url(key, input);
    };
    const notLogin = mac.verifyMagicLink(
      sign({
        jti: 'AAAAAAAAAAAAAAAAAAAAAA',
        sub: PERSON,
        aud: INSTANCE,
        purpose: 'reset',
        exp: 99,
      }),
      NOW,
    );
    expect(notLogin.ok).toBe(false);
    if (!notLogin.ok) expect(notLogin.error.reason).toBe('bad-payload');

    const notJson = mac.verifyMagicLink(
      `${MAGIC_LINK_TAG}.${Buffer.from('not json', 'utf8').toString('base64url')}.${csrfLikeMac(
        `${MAGIC_LINK_TAG}.${Buffer.from('not json', 'utf8').toString('base64url')}`,
      )}`,
      NOW,
    );
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.error.reason).toBe('bad-payload');

    // Signed, and not base64url at all. Without the round-trip check in `decodePayload` this
    // would decode to nothing and be reported as bad JSON — a misleading verdict for a token whose
    // *encoding* is wrong.
    const badEncoding = mac.verifyMagicLink(
      `${MAGIC_LINK_TAG}.!!!!.${csrfLikeMac(`${MAGIC_LINK_TAG}.!!!!`)}`,
      NOW,
    );
    expect(badEncoding.ok).toBe(false);
    if (!badEncoding.ok && badEncoding.error.reason === 'bad-payload') {
      expect(badEncoding.error.detail).toBe('encoding');
    }

    const extraField = mac.verifyMagicLink(
      sign({
        jti: 'AAAAAAAAAAAAAAAAAAAAAA',
        sub: PERSON,
        aud: INSTANCE,
        purpose: 'login',
        exp: 99_999_999_999,
        admin: true,
      }),
      NOW,
    );
    // `strictObject`: a field nobody validates is a field somebody will later read.
    expect(extraField.ok).toBe(false);
  });
});

describe('construction', () => {
  it('refuses a key that is not a MAC key', () => {
    expect(() => tokenMac(Buffer.alloc(16), INSTANCE, 0)).toThrow(/32 bytes/);
    expect(() => tokenMac(Buffer.alloc(32), INSTANCE, -1)).toThrow(/non-negative/);
    expect(() => tokenMac(Buffer.alloc(32), INSTANCE, 1.5)).toThrow(/non-negative/);
  });

  it('refuses a TTL that is not a positive number of seconds', () => {
    expect(() => macFor(0).mintMagicLink(PERSON, NOW, 0)).toThrow(/positive TTL/);
  });
});
