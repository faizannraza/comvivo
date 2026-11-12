/**
 * The printed recovery key: `VRK1-7M4Q-…-K2PX` (`08` §3.7.6).
 *
 * This is the only piece of key material a human ever reads, writes down, and types back in — and
 * by `08` §3.7.8 it is the sole route back when the master key is gone. Both facts drive the
 * design:
 *
 *  - **It must survive being transcribed by hand.** Crockford base32 omits `I`, `L`, `O` and `U`,
 *    and decoding folds `I`/`L` → `1` and `O` → `0`, so the four confusable glyph pairs cannot
 *    produce a wrong key — they produce the right one. Case is ignored, and spaces and hyphens are
 *    ignored entirely, so a key read off paper in any grouping still decodes.
 *  - **A typo must be refused, not silently accepted.** The 20-bit checksum catches every
 *    single-character substitution in the payload — asserted exhaustively, all 52 positions times
 *    all 31 wrong characters, rather than sampled — so a mistyped key is reported as a typo
 *    instead of being used to derive a slot key that opens nothing and reported as "wrong key".
 *
 * **Nothing here ever echoes its input.** `decodeRecoveryKey` returns a `Result` whose error
 * carries a code and a position, never the text: this function's argument is the single most
 * valuable secret in the system, and the natural place for an error message to end up is a log
 * file or a terminal scrollback. `ids.ts` takes the same stance for the same reason.
 *
 * `VRK1` is kept verbatim, not derived from `BRAND`. It is a **checksum domain input** — it is
 * hashed together with the key — so changing it would invalidate every key already written on
 * paper. `STATUS.md`'s 2026-11-03 note assigns the codename-derived token prefixes to `M1-T29`;
 * this one is additionally a wire constant, like the labels in `shared/crypto/labels.ts`.
 */

import type { InstanceId } from '@comvivo/shared';
import {
  CROCKFORD_ALPHABET,
  derivePurposeKey,
  KEY_BYTES,
  KEY_PURPOSE,
  randomBytes,
  secureEqual,
  sha256,
} from '@comvivo/shared/crypto';

/** The format tag, and the first field of the checksum's input. A frozen wire constant. */
export const RECOVERY_KEY_PREFIX = 'VRK1';

/** `08` §3.7.6: 52 payload characters at 5 bits each hold 256 bits with 4 leading zero bits. */
export const PAYLOAD_CHARS = 52;

/** 4 characters, 20 bits: the first 20 bits of `SHA-256(prefix ‖ key)`. */
export const CHECKSUM_CHARS = 4;
export const CHECKSUM_BITS = CHECKSUM_CHARS * 5;

/**
 * Bits to drop from the three bytes `recoveryKeyChecksum` reads, to leave {@link CHECKSUM_BITS}.
 *
 * `CHECKSUM_BITS` was exported and read by nothing while the implementation carried a bare `>> 4`.
 * Deriving the shift means the two cannot disagree: changing `CHECKSUM_CHARS` moves the shift with
 * it, and a combination that is not a whole number of bytes fails below rather than silently
 * truncating. Found by the M1 independent review, which listed `CHECKSUM_BITS` among the exports
 * with no reader.
 */
const CHECKSUM_SHIFT = 24 - CHECKSUM_BITS;

/** The whole body, excluding the `VRK1-` tag. */
export const BODY_CHARS = PAYLOAD_CHARS + CHECKSUM_CHARS;

/** `08` §3.7.6 prints the body in groups of four: 14 of them. */
export const GROUP_SIZE = 4;
export const GROUP_COUNT = BODY_CHARS / GROUP_SIZE;

/**
 * The groups the ceremony asks the user to retype (`08` §3.7.6 step 2), 1-based.
 *
 * Two groups rather than one, and far apart rather than adjacent, because the failure this guards
 * against is a user who did not actually write the key down. Checking one group near the start
 * would pass for somebody who copied the first line and stopped.
 */
export const RETYPE_GROUPS: readonly number[] = [3, 11];

/** Why a recovery key would not decode. Never accompanied by the input. */
export type RecoveryKeyErrorCode =
  | 'RECOVERY_KEY_PREFIX'
  | 'RECOVERY_KEY_LENGTH'
  | 'RECOVERY_KEY_CHARACTER'
  | 'RECOVERY_KEY_CHECKSUM'
  | 'RECOVERY_KEY_PADDING';

export interface RecoveryKeyError {
  readonly code: RecoveryKeyErrorCode;
  /** A message safe to log: it describes the shape of the problem and never quotes the key. */
  readonly message: string;
  /** What a host should do about it. */
  readonly hint: string;
  /**
   * 1-based position in the normalised body, when the problem is at one place.
   *
   * Safe to show and genuinely useful — "character 17 is not one we use" lets somebody find their
   * own slip — and it leaks nothing, because the position of a bad character says nothing about
   * the 255 bits that were correct.
   */
  readonly position?: number;
}

/** A decode outcome. The same `Result` shape `ids.ts` uses, for the same reason. */
export type RecoveryKeyResult =
  | { readonly ok: true; readonly key: Buffer }
  | { readonly ok: false; readonly error: RecoveryKeyError };

/**
 * Crockford decode table: value per character, after folding the confusable glyphs.
 *
 * Built once from the alphabet that `randomTypedCode` also draws against, so the encoder and the
 * decoder cannot disagree about which characters exist.
 */
const DECODE = new Map<string, number>();
// Indexed rather than spread throughout this file. `no-misused-spread` is right that spreading a
// string yields code points and can split a grapheme — but every string here is ASCII by
// construction or rejected as a bad character, so UTF-16 units are exactly the unit wanted: a
// non-ASCII character becomes units that are not in this table and is refused either way, and the
// position reported to a user counting characters on paper is the one they would count.
for (let index = 0; index < CROCKFORD_ALPHABET.length; index += 1) {
  DECODE.set(CROCKFORD_ALPHABET.charAt(index), index);
}
// `08` §3.7.6's substitutions. `I` and `L` read as `1`, `O` reads as `0` — the pairs a human
// transcribing by hand actually confuses. `U` is *not* mapped: Crockford omits it deliberately and
// there is no digit it could plausibly be, so a `U` is a real typo and is reported as one.
DECODE.set('I', 1);
DECODE.set('L', 1);
DECODE.set('O', 0);

/**
 * Strip the formatting a human adds, and fold case.
 *
 * Hyphens and spaces go because `08` §3.7.6 prints the key grouped and a user may regroup it,
 * add a line break, or paste it out of a password manager with the spacing changed. Every other
 * character is kept, including invalid ones, so the position reported for a bad character is a
 * position in something the user can actually count along.
 */
export function normaliseRecoveryKey(text: string): string {
  return text.replace(/[\s-]+/g, '').toUpperCase();
}

/** The first 20 bits of `SHA-256(prefix ‖ key)`, as `CHECKSUM_CHARS` Crockford characters. */
export function recoveryKeyChecksum(key: Uint8Array): string {
  const digest = sha256(Buffer.concat([Buffer.from(RECOVERY_KEY_PREFIX, 'ascii'), key]));
  // 20 bits is three whole bytes (24) minus four, so read three bytes and drop the low nibble.
  // `readUIntBE` rather than indexing: `noUncheckedIndexedAccess` would force a `?? 0` fallback
  // that can never fire on a 32-byte digest, and a fallback that cannot run reads as a handled
  // case while sitting as missed coverage forever.
  const bits = digest.readUIntBE(0, 3);
  return toCrockford(BigInt(bits >> CHECKSUM_SHIFT), CHECKSUM_CHARS);
}

/** Big-endian Crockford, zero-padded to `length` characters. */
function toCrockford(value: bigint, length: number): string {
  let out = '';
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    out = CROCKFORD_ALPHABET.charAt(Number(remaining & 31n)) + out;
    remaining >>= 5n;
  }
  return out;
}

/**
 * Format a 32-byte recovery key for printing.
 *
 * Grouped in fours and prefixed, so what a user writes down is exactly what `decodeRecoveryKey`
 * accepts — including the grouping, which `normaliseRecoveryKey` then throws away.
 */
export function encodeRecoveryKey(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) {
    throw new RangeError(`a recovery key is ${String(KEY_BYTES)} bytes, got ${String(key.length)}`);
  }
  let bits = 0n;
  for (const byte of key) bits = (bits << 8n) | BigInt(byte);

  const body = toCrockford(bits, PAYLOAD_CHARS) + recoveryKeyChecksum(key);
  const groups: string[] = [RECOVERY_KEY_PREFIX];
  for (let index = 0; index < body.length; index += GROUP_SIZE) {
    groups.push(body.slice(index, index + GROUP_SIZE));
  }
  return groups.join('-');
}

/** A fresh recovery key. 32 bytes of CSPRNG output, nothing derived (`08` §3.7.6). */
export function newRecoveryKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/**
 * Decode a typed recovery key.
 *
 * The order of the checks is the order that produces the most useful message: a missing prefix
 * means the user pasted the wrong thing entirely, a wrong length means a dropped or doubled
 * character, a bad character means a glyph we do not use, and only once the shape is right does
 * the checksum get to say "this is the right shape but not a key we issued".
 */
export function decodeRecoveryKey(text: string): RecoveryKeyResult {
  const normalised = normaliseRecoveryKey(text);
  const tag = RECOVERY_KEY_PREFIX;

  if (!normalised.startsWith(tag)) {
    return fail(
      'RECOVERY_KEY_PREFIX',
      `a recovery key starts with ${RECOVERY_KEY_PREFIX}-`,
      'Check you pasted the recovery key and not a master key or an API token.',
    );
  }

  const body = normalised.slice(tag.length);
  if (body.length !== BODY_CHARS) {
    return fail(
      'RECOVERY_KEY_LENGTH',
      `a recovery key has ${String(BODY_CHARS)} characters after the tag, this one has ${String(body.length)}`,
      body.length < BODY_CHARS
        ? 'A character is missing — compare the groups against what you wrote down.'
        : 'There is a character too many — check for a doubled keystroke.',
    );
  }

  // Fold the **whole** body — checksum characters included — before anything is interpreted.
  //
  // Both halves need it, and the first version only did the payload. That was wrong twice over: a
  // user who wrote `O` for `0` inside the last group had their correctly-transcribed key reported
  // as a typo, because the checksum was compared as raw characters against a canonical `0`; and a
  // genuinely invalid character in those four positions was never checked for membership at all,
  // so it surfaced as `RECOVERY_KEY_CHECKSUM` ("there is a typo somewhere") instead of naming the
  // position. `08` §3.7.6's tolerance applies to the whole key, not to the part that happens to
  // carry the bits.
  const values: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const value = DECODE.get(body.charAt(index));
    if (value === undefined) {
      return fail(
        'RECOVERY_KEY_CHARACTER',
        `character ${String(index + 1)} is not one a recovery key uses`,
        'A recovery key never contains U, and I, L and O are read as 1, 1 and 0. Check that ' +
          'position against what you wrote down.',
        index + 1,
      );
    }
    values.push(value);
  }

  let bits = 0n;
  for (const value of values.slice(0, PAYLOAD_CHARS)) {
    bits = (bits << 5n) | BigInt(value);
  }

  // 52 characters carry 260 bits and a key is 256, so the top four must be zero. A non-zero value
  // there is not a key we ever printed, and saying so is better than silently truncating it.
  const padding = bits >> BigInt(KEY_BYTES * 8);
  if (padding !== 0n) {
    return fail(
      'RECOVERY_KEY_PADDING',
      'the leading bits of this key are not zero, so it is not one we issued',
      'Check the first group against what you wrote down.',
    );
  }

  const key = Buffer.alloc(KEY_BYTES);
  let remaining = bits;
  for (let index = KEY_BYTES - 1; index >= 0; index -= 1) {
    key[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  const expected = recoveryKeyChecksum(key);
  // Canonical form, so a folded glyph compares equal to the character we printed.
  const actual = values
    .slice(PAYLOAD_CHARS)
    .map((value) => CROCKFORD_ALPHABET.charAt(value))
    .join('');
  // Constant-time, because `verifyRecovery` runs this against a key an attacker may be guessing,
  // and a checksum comparison that returned early would say how many characters were right.
  if (!secureEqual(Buffer.from(expected, 'ascii'), Buffer.from(actual, 'ascii'))) {
    key.fill(0);
    return fail(
      'RECOVERY_KEY_CHECKSUM',
      'this is the right shape but the checksum does not match, so there is a typo',
      'One character is wrong. Compare each group against what you wrote down — the checksum ' +
        'catches any single wrong character, so the key itself is intact on paper.',
    );
  }

  return { ok: true, key };
}

function fail(
  code: RecoveryKeyErrorCode,
  message: string,
  hint: string,
  position?: number,
): RecoveryKeyResult {
  return {
    ok: false,
    error: position === undefined ? { code, message, hint } : { code, message, hint, position },
  };
}

/**
 * The printed groups, 1-based, for the retype step of the ceremony.
 *
 * Returns the groups of an **encoded** key rather than re-deriving them from bytes, so the
 * ceremony is asking about exactly the characters it displayed.
 */
export function recoveryKeyGroups(encoded: string): readonly string[] {
  const body = normaliseRecoveryKey(encoded).slice(RECOVERY_KEY_PREFIX.length);
  const groups: string[] = [];
  for (let index = 0; index < body.length; index += GROUP_SIZE) {
    groups.push(body.slice(index, index + GROUP_SIZE));
  }
  return groups;
}

/**
 * Check a retyped group against the printed key (`08` §3.7.6 step 2).
 *
 * Normalised the same way a whole key is, so the confusable glyphs are forgiving here too — the
 * step exists to confirm the user has the key written down, not to test their typing.
 */
export function retypedGroupMatches(encoded: string, group: number, typed: string): boolean {
  const groups = recoveryKeyGroups(encoded);
  const expected = groups[group - 1];
  if (expected === undefined) return false;
  const typedBody = normaliseRecoveryKey(typed);
  let normalised = '';
  for (let index = 0; index < typedBody.length; index += 1) {
    const character = typedBody.charAt(index);
    const value = DECODE.get(character);
    normalised += value === undefined ? character : CROCKFORD_ALPHABET.charAt(value);
  }
  return normalised === expected;
}

/**
 * The slot key a recovery key unlocks with: `HKDF(RK, salt=instanceId, info="…/rk-slot")`.
 *
 * `08` §3.7.6 is explicit that the recovery key itself is **not** the slot key. The derivation is
 * what binds a printed key to one instance, so a key from another host cannot open this keyring
 * even if the keyring file were copied.
 */
export function recoverySlotKey(recoveryKey: Uint8Array, instanceId: InstanceId): Buffer {
  return derivePurposeKey(recoveryKey, instanceId, KEY_PURPOSE.rkSlot);
}
