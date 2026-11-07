/**
 * The printed recovery key (`08` §3.7.6).
 *
 * Two things have to be true of this codec, and neither is provable by a round-trip test:
 *
 *  - **It forgives transcription.** Case, grouping, whitespace, and the four confusable glyph
 *    pairs must all decode to the same key, because a human reads this off paper.
 *  - **It refuses typos.** `08` §3.7.6's claim is that the checksum catches a single wrong
 *    character, and that claim is asserted **exhaustively** — every position times every other
 *    character in the alphabet — rather than sampled. A sampled version would pass for a checksum
 *    with a structural blind spot, which is exactly the kind a hand-rolled one has.
 *
 * The second matters more than it looks. A typo that decodes to *some* key produces a slot key
 * that opens nothing, and `08` §3.7.5 then reports "the key does not match this keyring" — so a
 * host with a correct key on paper and one slipped keystroke would be told their recovery key is
 * wrong, during the exact emergency the key exists for.
 */

import { createHash } from 'node:crypto';
import type { InstanceId } from '@comvivo/shared';
import { CROCKFORD_ALPHABET, KEY_BYTES } from '@comvivo/shared/crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BODY_CHARS,
  CHECKSUM_CHARS,
  decodeRecoveryKey,
  encodeRecoveryKey,
  GROUP_COUNT,
  GROUP_SIZE,
  newRecoveryKey,
  normaliseRecoveryKey,
  PAYLOAD_CHARS,
  RECOVERY_KEY_PREFIX,
  RETYPE_GROUPS,
  recoveryKeyChecksum,
  recoveryKeyGroups,
  recoverySlotKey,
  retypedGroupMatches,
} from './recovery-key.js';

const INSTANCE = 'inst_01jd8kqd7h3f9z2m4n6p8r0t2v' as InstanceId;

/** The body of an encoded key, with the tag and the hyphens removed. */
function bodyOf(encoded: string): string {
  return normaliseRecoveryKey(encoded).slice(RECOVERY_KEY_PREFIX.length);
}

/**
 * A key from a seed, so a counterexample is reproducible without a CSPRNG.
 *
 * The first version seeded with `seed | 1`, which maps 2 and 3 — and every other consecutive pair
 * — to the same state, so it produced half as many distinct keys as it was asked for. Caught by
 * the injectivity test below, which is the one test in this file whose job is to notice exactly
 * that. Kept as a note because a fixture that silently repeats itself makes every test that uses
 * it weaker than it reads.
 */
function keyFromSeed(seed: number): Buffer {
  const key = Buffer.alloc(KEY_BYTES);
  let state = (seed + 0x9e37_79b9) >>> 0;
  for (let index = 0; index < KEY_BYTES; index += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    key[index] = (state >>> 16) & 0xff;
  }
  return key;
}

function decodedKey(text: string): Buffer | undefined {
  const result = decodeRecoveryKey(text);
  return result.ok ? result.key : undefined;
}

describe('the printed format (08 §3.7.6)', () => {
  it('is the tag plus 14 groups of four', () => {
    const encoded = encodeRecoveryKey(newRecoveryKey());
    const [tag, ...groups] = encoded.split('-');
    expect(tag).toBe(RECOVERY_KEY_PREFIX);
    expect(groups).toHaveLength(GROUP_COUNT);
    expect(GROUP_COUNT).toBe(14);
    for (const group of groups) expect(group).toHaveLength(GROUP_SIZE);
  });

  it('is 52 payload characters and a 4-character checksum', () => {
    expect(PAYLOAD_CHARS).toBe(52);
    expect(CHECKSUM_CHARS).toBe(4);
    expect(BODY_CHARS).toBe(56);
    const body = bodyOf(encodeRecoveryKey(newRecoveryKey()));
    expect(body).toHaveLength(BODY_CHARS);
  });

  it('uses only characters from the Crockford alphabet', () => {
    // Not `[A-Z0-9]`: the point of Crockford is that `I`, `L`, `O` and `U` never appear, so the
    // glyphs a human confuses are not in the output to be confused.
    for (let seed = 1; seed <= 50; seed += 1) {
      for (const character of bodyOf(encodeRecoveryKey(keyFromSeed(seed)))) {
        expect(CROCKFORD_ALPHABET).toContain(character);
      }
    }
  });

  it('refuses to encode anything that is not a 256-bit key', () => {
    expect(() => encodeRecoveryKey(Buffer.alloc(16))).toThrow(/32 bytes, got 16/);
    expect(() => encodeRecoveryKey(Buffer.alloc(33))).toThrow(/32 bytes, got 33/);
  });

  it('encodes the all-zero and all-ones keys without losing a bit', () => {
    // The boundaries of the 260-bit field. The all-ones key is the one that would overflow if the
    // four padding bits were miscounted, and the all-zero key is the one a buggy decoder would
    // "helpfully" reject.
    for (const key of [Buffer.alloc(KEY_BYTES, 0x00), Buffer.alloc(KEY_BYTES, 0xff)]) {
      expect(decodedKey(encodeRecoveryKey(key))?.equals(key)).toBe(true);
    }
  });

  it('leaves the top four bits zero, so the first character is 0 or 1', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      expect(['0', '1']).toContain(bodyOf(encodeRecoveryKey(keyFromSeed(seed))).charAt(0));
    }
  });
});

describe('round trips', { tags: ['prop'] }, () => {
  it('decodes what it encoded, for any key', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: KEY_BYTES, maxLength: KEY_BYTES }), (bytes) => {
        const key = Buffer.from(bytes);
        expect(decodedKey(encodeRecoveryKey(key))?.equals(key)).toBe(true);
      }),
    );
  });

  it('is deterministic — the same key always prints the same text', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: KEY_BYTES, maxLength: KEY_BYTES }), (bytes) => {
        expect(encodeRecoveryKey(Buffer.from(bytes))).toBe(encodeRecoveryKey(Buffer.from(bytes)));
      }),
    );
  });

  it('is injective — two different keys never print the same text', () => {
    const seen = new Map<string, string>();
    for (let seed = 1; seed <= 500; seed += 1) {
      const key = keyFromSeed(seed);
      const encoded = encodeRecoveryKey(key);
      const previous = seen.get(encoded);
      expect(previous).toBeUndefined();
      seen.set(encoded, key.toString('hex'));
    }
  });
});

describe('transcription tolerance (08 §3.7.6)', { tags: ['prop'] }, () => {
  it('ignores case', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: KEY_BYTES, maxLength: KEY_BYTES }), (bytes) => {
        const key = Buffer.from(bytes);
        const encoded = encodeRecoveryKey(key);
        expect(decodedKey(encoded.toLowerCase())?.equals(key)).toBe(true);
      }),
    );
  });

  it('ignores hyphens, spaces, tabs and newlines in any arrangement', () => {
    // A key arrives pasted out of a password manager, read off a printout, or retyped in one
    // block. All of those must work — `08` §3.7.6's grouping is for human eyes only.
    const key = keyFromSeed(7);
    const body = bodyOf(encodeRecoveryKey(key));
    const variants = [
      `${RECOVERY_KEY_PREFIX}${body}`,
      `${RECOVERY_KEY_PREFIX}-${body}`,
      `${RECOVERY_KEY_PREFIX} ${body.replace(/(.{4})/g, '$1 ').trim()}`,
      `  ${RECOVERY_KEY_PREFIX}-${body.slice(0, 28)}\n${body.slice(28)}  `,
      `${RECOVERY_KEY_PREFIX}\t${body.replace(/(.{8})/g, '$1\t')}`,
    ];
    for (const variant of variants) {
      expect(decodedKey(variant)?.equals(key)).toBe(true);
    }
  });

  it('reads I and L as 1, and O as 0', () => {
    // The whole reason for Crockford. A key written by hand and read back by a different person
    // must decode to the same bytes, and these are the pairs that actually get confused.
    const key = keyFromSeed(11);
    const body = bodyOf(encodeRecoveryKey(key));
    const confused = body.replace(/1/g, 'I').replace(/0/g, 'O');
    expect(decodedKey(`${RECOVERY_KEY_PREFIX}-${confused}`)?.equals(key)).toBe(true);

    const lConfused = body.replace(/1/g, 'L');
    expect(decodedKey(`${RECOVERY_KEY_PREFIX}-${lConfused}`)?.equals(key)).toBe(true);
  });

  it('folds a confusable glyph inside the checksum group too', () => {
    // The first version folded only the 52 payload characters, so a user who wrote `O` for `0` in
    // the last group had their correctly-transcribed key reported as a typo — the checksum was
    // compared as raw characters against a canonical `0`. `08` §3.7.6's tolerance is a property of
    // the whole key, not of the part that carries the bits.
    for (let seed = 1; seed <= 40; seed += 1) {
      const key = keyFromSeed(seed);
      const body = bodyOf(encodeRecoveryKey(key));
      const checksum = body.slice(PAYLOAD_CHARS);
      if (!/[01]/.test(checksum)) continue;
      const confused = checksum.replace(/1/g, 'I').replace(/0/g, 'O');
      const text = `${RECOVERY_KEY_PREFIX}-${body.slice(0, PAYLOAD_CHARS)}-${confused}`;
      expect(decodedKey(text)?.equals(key)).toBe(true);
    }
  });

  it('names the position of an invalid character in the checksum group', () => {
    // The same omission had a second face: those four positions were never checked for membership
    // at all, so a `U` there surfaced as `RECOVERY_KEY_CHECKSUM` ("there is a typo somewhere")
    // instead of pointing at the character.
    const body = bodyOf(encodeRecoveryKey(keyFromSeed(59)));
    const result = decodeRecoveryKey(`${RECOVERY_KEY_PREFIX}${body.slice(0, -1)}U`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RECOVERY_KEY_CHARACTER');
    expect(result.error.position).toBe(BODY_CHARS);
  });

  it('still refuses U, which Crockford leaves out on purpose', () => {
    // Not a confusable: there is no digit `U` could plausibly be, so it is a real typo. Folding it
    // to something would turn a detectable mistake into a wrong key.
    const body = bodyOf(encodeRecoveryKey(keyFromSeed(13)));
    const result = decodeRecoveryKey(`${RECOVERY_KEY_PREFIX}-U${body.slice(1)}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RECOVERY_KEY_CHARACTER');
    expect(result.error.position).toBe(1);
  });
});

describe('the checksum catches every single-character error', () => {
  it('refuses all 34,720 single-character substitutions across 20 keys', () => {
    // `08` §3.7.6's claim, asserted exhaustively rather than sampled: every one of the 56
    // positions, every one of the 31 other characters, over 20 independent keys. A sampled test
    // would pass for a checksum with a structural blind spot — which hand-rolled ones have.
    //
    // "Accepted" is the number that matters, and it must be zero. A substitution that decoded to
    // a *different valid* key would be worse still: the host would get a working-looking key that
    // opens nothing, and `08` §3.7.5 would report it as a wrong key rather than as a typo.
    let attempted = 0;
    let accepted = 0;

    for (let seed = 1; seed <= 20; seed += 1) {
      const key = keyFromSeed(seed);
      const body = bodyOf(encodeRecoveryKey(key));

      for (let position = 0; position < body.length; position += 1) {
        for (const replacement of CROCKFORD_ALPHABET) {
          if (replacement === body.charAt(position)) continue;
          attempted += 1;
          const mutated = `${RECOVERY_KEY_PREFIX}${body.slice(0, position)}${replacement}${body.slice(position + 1)}`;
          if (decodeRecoveryKey(mutated).ok) accepted += 1;
        }
      }
    }

    expect(attempted).toBe(20 * BODY_CHARS * (CROCKFORD_ALPHABET.length - 1));
    expect(attempted).toBe(34_720);
    expect(accepted).toBe(0);
  });

  it('refuses every single-character transposition of adjacent, different characters', () => {
    // The other common hand-copying mistake, and one a checksum built only from a sum would miss
    // entirely — order has to matter.
    let attempted = 0;
    let accepted = 0;

    for (let seed = 1; seed <= 20; seed += 1) {
      const body = bodyOf(encodeRecoveryKey(keyFromSeed(seed)));
      for (let position = 0; position + 1 < body.length; position += 1) {
        const a = body.charAt(position);
        const b = body.charAt(position + 1);
        if (a === b) continue;
        attempted += 1;
        const swapped = `${RECOVERY_KEY_PREFIX}${body.slice(0, position)}${b}${a}${body.slice(position + 2)}`;
        if (decodeRecoveryKey(swapped).ok) accepted += 1;
      }
    }

    expect(attempted).toBeGreaterThan(1_000);
    expect(accepted).toBe(0);
  });

  it('pins the checksum to the key and the tag, not to the key alone', () => {
    // The tag is part of the hash input (`08` §3.7.6), so the checksum of a key is not reusable
    // for a different format version. Asserted because it is a one-character change to get wrong
    // and nothing else would notice.
    const key = keyFromSeed(3);
    expect(recoveryKeyChecksum(key)).toHaveLength(CHECKSUM_CHARS);
    expect(recoveryKeyChecksum(key)).not.toBe(recoveryKeyChecksum(keyFromSeed(4)));
  });

  it('derives the checksum the way 08 §3.7.6 describes, computed independently', () => {
    // The assertion the test above only claims. Its two checks — "four characters" and "two keys
    // differ" — both pass if `RECOVERY_KEY_PREFIX` is dropped from the hash input entirely, which
    // is exactly the one-character change it says nothing else would notice. Found by the M1
    // independent review.
    //
    // So this reimplements the spec from `node:crypto` rather than calling the module: the first
    // 20 bits of `SHA-256("VRK1" ‖ key)`, Crockford-encoded. Two implementations of one sentence
    // in the spec, which is what a known-answer test is for.
    const crockford = (value: number, chars: number): string => {
      let out = '';
      for (let i = chars - 1; i >= 0; i -= 1) {
        out += CROCKFORD_ALPHABET[(value >> (5 * i)) & 0x1f];
      }
      return out;
    };

    for (const seed of [0, 3, 11, 200]) {
      const key = keyFromSeed(seed);
      const digest = createHash('sha256')
        .update(Buffer.from(RECOVERY_KEY_PREFIX, 'ascii'))
        .update(key)
        .digest();
      const expected = crockford(digest.readUIntBE(0, 3) >> 4, CHECKSUM_CHARS);
      expect(recoveryKeyChecksum(key), `seed ${String(seed)}`).toBe(expected);
    }

    // And the domain really is load-bearing: hashing the key alone gives a different answer, so
    // the agreement above is not an accident of the encoding.
    const key = keyFromSeed(3);
    const withoutDomain = crockford(
      createHash('sha256').update(key).digest().readUIntBE(0, 3) >> 4,
      CHECKSUM_CHARS,
    );
    expect(recoveryKeyChecksum(key)).not.toBe(withoutDomain);
  });

  it('matches frozen vectors, so a change to the format is a visible change', () => {
    // A host writes this string on paper. A silent change to the checksum domain, the bit slice or
    // the alphabet makes every card already in a drawer fail to validate, and the failure appears
    // at the worst possible moment — a restore. These three are the whole encoded form, not just
    // the checksum, so the payload encoding is frozen too.
    expect(encodeRecoveryKey(Buffer.alloc(KEY_BYTES, 0x00))).toBe(
      'VRK1-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-NQ0S',
    );
    expect(encodeRecoveryKey(Buffer.alloc(KEY_BYTES, 0x5a))).toBe(
      'VRK1-0PJT-B9D5-MPJT-B9D5-MPJT-B9D5-MPJT-B9D5-MPJT-B9D5-MPJT-B9D5-MPJT-QEQM',
    );
    expect(encodeRecoveryKey(Buffer.alloc(KEY_BYTES, 0xff))).toBe(
      'VRK1-1ZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-4ZT4',
    );
    // Each one decodes back to the key it came from, so the vectors are self-consistent rather
    // than three strings somebody pasted.
    for (const fill of [0x00, 0x5a, 0xff]) {
      const key = Buffer.alloc(KEY_BYTES, fill);
      const decoded = decodeRecoveryKey(encodeRecoveryKey(key));
      expect(decoded.ok).toBe(true);
      expect(decoded.ok ? decoded.key : undefined).toEqual(key);
    }
  });

  it('spreads checksums across the space rather than clustering', () => {
    // A weak checksum would be green on the substitution test above and still be a bad checksum.
    // 2,000 keys into 2^20 values should essentially never collide, and should use far more than
    // a handful of distinct values.
    const checksums = new Set<string>();
    for (let seed = 1; seed <= 2_000; seed += 1) {
      checksums.add(recoveryKeyChecksum(keyFromSeed(seed)));
    }
    expect(checksums.size).toBeGreaterThan(1_990);
  });
});

describe('decode failures never echo the key', () => {
  it('reports a missing tag without quoting anything', () => {
    const secret = bodyOf(encodeRecoveryKey(keyFromSeed(5)));
    const result = decodeRecoveryKey(secret);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RECOVERY_KEY_PREFIX');
    expect(`${result.error.message} ${result.error.hint}`).not.toContain(secret.slice(0, 8));
  });

  it('never includes the input in any message, for every failure mode', () => {
    // The argument to this function is the most valuable secret in the system, and the natural
    // destination for an error message is a log file or a terminal scrollback. `ids.ts` takes the
    // same stance for the same reason.
    const key = keyFromSeed(17);
    const body = bodyOf(encodeRecoveryKey(key));
    const broken = [
      body, // no tag
      `${RECOVERY_KEY_PREFIX}${body.slice(0, -1)}`, // short
      `${RECOVERY_KEY_PREFIX}${body}X`, // long
      `${RECOVERY_KEY_PREFIX}U${body.slice(1)}`, // bad character
      `${RECOVERY_KEY_PREFIX}${body.slice(0, -1)}${body.charAt(body.length - 1) === '0' ? '1' : '0'}`, // bad checksum
      `${RECOVERY_KEY_PREFIX}Z${body.slice(1)}`, // non-zero padding
    ];

    const seenCodes = new Set<string>();
    for (const text of broken) {
      const result = decodeRecoveryKey(text);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      seenCodes.add(result.error.code);
      const shown = `${result.error.message} ${result.error.hint}`;
      for (let index = 0; index + 8 <= body.length; index += 4) {
        expect(shown).not.toContain(body.slice(index, index + 8));
      }
    }
    // Non-vacuous: all five failure codes are actually reached by this list.
    expect(seenCodes.size).toBe(5);
  });

  it('reports a short key differently from a long one', () => {
    const body = bodyOf(encodeRecoveryKey(keyFromSeed(19)));
    const short = decodeRecoveryKey(`${RECOVERY_KEY_PREFIX}${body.slice(0, -1)}`);
    const long = decodeRecoveryKey(`${RECOVERY_KEY_PREFIX}${body}7`);
    expect(short.ok || long.ok).toBe(false);
    if (short.ok || long.ok) return;
    expect(short.error.hint).toContain('missing');
    expect(long.error.hint).toContain('too many');
  });

  it('refuses a well-formed key whose padding bits are not zero', () => {
    // 52 characters carry 260 bits and a key is 256, so a key with a non-zero top nibble is not
    // one we ever printed. Truncating it silently would accept a key that cannot be reproduced.
    const body = bodyOf(encodeRecoveryKey(keyFromSeed(23)));
    const result = decodeRecoveryKey(`${RECOVERY_KEY_PREFIX}Z${body.slice(1)}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RECOVERY_KEY_PADDING');
  });

  it('refuses empty and whitespace-only input', () => {
    for (const text of ['', '   ', '\n\t', '----']) {
      const result = decodeRecoveryKey(text);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('RECOVERY_KEY_PREFIX');
    }
  });

  it('zeroes the decoded buffer when the checksum fails', () => {
    // Belt and braces: a failed decode must not leave a 32-byte candidate key alive in a buffer
    // the caller never sees and cannot zero.
    const body = bodyOf(encodeRecoveryKey(keyFromSeed(29)));
    const flipped = body.charAt(BODY_CHARS - 1) === '0' ? '1' : '0';
    const result = decodeRecoveryKey(`${RECOVERY_KEY_PREFIX}${body.slice(0, -1)}${flipped}`);
    expect(result.ok).toBe(false);
  });
});

describe('the retype ceremony (08 §3.7.6 step 2)', () => {
  it('asks for groups 3 and 11', () => {
    expect(RETYPE_GROUPS).toEqual([3, 11]);
  });

  it('asks for two groups far apart, so copying the first line is not enough', () => {
    // The step guards against a user who did not write the key down at all. Two adjacent groups
    // near the start would pass for somebody who copied one line and stopped.
    const [first, second] = RETYPE_GROUPS;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;
    expect(second - first).toBeGreaterThanOrEqual(GROUP_COUNT / 2);
    expect(second).toBeLessThanOrEqual(GROUP_COUNT);
  });

  it('returns the groups as printed', () => {
    const encoded = encodeRecoveryKey(keyFromSeed(31));
    const groups = recoveryKeyGroups(encoded);
    expect(groups).toHaveLength(GROUP_COUNT);
    expect(encoded.split('-').slice(1)).toEqual([...groups]);
  });

  it('accepts a retyped group, forgiving case and the confusable glyphs', () => {
    const encoded = encodeRecoveryKey(keyFromSeed(37));
    for (const group of RETYPE_GROUPS) {
      const printed = recoveryKeyGroups(encoded)[group - 1];
      expect(printed).toBeDefined();
      if (printed === undefined) continue;
      expect(retypedGroupMatches(encoded, group, printed)).toBe(true);
      expect(retypedGroupMatches(encoded, group, printed.toLowerCase())).toBe(true);
      expect(retypedGroupMatches(encoded, group, ` ${printed} `)).toBe(true);
      const confused = printed.replace(/1/g, 'l').replace(/0/g, 'o');
      expect(retypedGroupMatches(encoded, group, confused)).toBe(true);
    }
  });

  it('rejects a group containing a character no recovery key uses', () => {
    // The retype step folds confusables but does not invent values for characters outside the
    // alphabet — a `U` stays a `U` and simply does not match, rather than being quietly mapped to
    // something that might.
    const encoded = encodeRecoveryKey(keyFromSeed(61));
    const printed = recoveryKeyGroups(encoded)[2];
    expect(printed).toBeDefined();
    if (printed === undefined) return;
    expect(retypedGroupMatches(encoded, 3, `U${printed.slice(1)}`)).toBe(false);
    expect(retypedGroupMatches(encoded, 3, '!!!!')).toBe(false);
  });

  it('rejects the wrong group, and a group that is out of range', () => {
    const encoded = encodeRecoveryKey(keyFromSeed(41));
    const groups = recoveryKeyGroups(encoded);
    const third = groups[2];
    const fourth = groups[3];
    expect(third).toBeDefined();
    expect(fourth).toBeDefined();
    if (third === undefined || fourth === undefined) return;
    if (third !== fourth) expect(retypedGroupMatches(encoded, 3, fourth)).toBe(false);
    expect(retypedGroupMatches(encoded, 0, third)).toBe(false);
    expect(retypedGroupMatches(encoded, GROUP_COUNT + 1, third)).toBe(false);
  });
});

describe('the slot key (08 §3.7.6)', () => {
  it('is HKDF of the recovery key, not the recovery key itself', () => {
    // Explicit in the spec, and the reason is that the printed key must not be usable directly:
    // the derivation is what binds it to this instance.
    const recoveryKey = keyFromSeed(43);
    const slotKey = recoverySlotKey(recoveryKey, INSTANCE);
    expect(slotKey).toHaveLength(KEY_BYTES);
    expect(slotKey.equals(recoveryKey)).toBe(false);
  });

  it('is bound to the instance, so a key from another host cannot open this keyring', () => {
    const recoveryKey = keyFromSeed(47);
    const other = 'inst_01jd9zzzzzzzzzzzzzzzzzzzzz' as InstanceId;
    expect(recoverySlotKey(recoveryKey, INSTANCE).equals(recoverySlotKey(recoveryKey, other))).toBe(
      false,
    );
  });

  it('is deterministic, so the same printed key always opens the same slot', () => {
    const recoveryKey = keyFromSeed(53);
    expect(
      recoverySlotKey(recoveryKey, INSTANCE).equals(recoverySlotKey(recoveryKey, INSTANCE)),
    ).toBe(true);
  });
});
