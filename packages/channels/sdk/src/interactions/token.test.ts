/**
 * The interaction token (`06` §3.7 CH-7; `M3-T6`).
 *
 * Three claims `06` §3.7 makes that only a test can hold up:
 *
 * 1. **25 bytes, and it fits every platform's callback budget.** Checked against the capability
 *    numbers in the profiles rather than against the sentence, because the sentence is what would
 *    survive a profile being edited.
 * 2. **Nothing structured ever reaches `callback_data`.** Checked at the outbound schema, which is
 *    the only place a producer can be stopped.
 * 3. **The comparison is constant-time and runs against a hash.** Checked by proving the token is
 *    not recoverable from what is stored, and that the comparison refuses a digest of the wrong
 *    length rather than quietly comparing the wrong column.
 *
 * And one claim it made that is **false**, corrected in this commit: a token does not fit a
 * Telegram deep-link start payload, because `.` is outside that parameter's charset. The test for
 * it is here so the correction cannot be lost to a later re-read of the old sentence.
 */

import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { ActionButtonSchema, PROFILE_NAMES, profiles } from '../index.js';
import {
  DEFAULT_INTERACTION_TOKEN_TTL_DAYS,
  defaultInteractionTokenExpiry,
  INTERACTION_TOKEN_BYTES,
  INTERACTION_TOKEN_ENTROPY_BYTES,
  INTERACTION_TOKEN_PATTERN,
  INTERACTION_TOKEN_VERSION,
  interactionTokenHash,
  interactionTokenMatches,
  isInteractionToken,
  mintInteractionToken,
  tokenFitsButtonLimits,
} from './token.js';

/** `A-Z a-z 0-9 _ -`, and nothing else: a Telegram deep-link `start` parameter (verified 2026-11-15). */
const TELEGRAM_START_PAYLOAD = /^[A-Za-z0-9_-]{1,64}$/;

describe('mintInteractionToken', () => {
  it('is 25 ASCII bytes matching 06 §3.7’s pattern', () => {
    const token = mintInteractionToken();
    expect(token).toMatch(INTERACTION_TOKEN_PATTERN);
    expect(token).toHaveLength(INTERACTION_TOKEN_BYTES);
    // ASCII throughout, so `length` and bytes agree — which is what lets a 64-**byte**
    // `callback_data` budget be checked against a character count.
    expect(new TextEncoder().encode(token)).toHaveLength(INTERACTION_TOKEN_BYTES);
  });

  it('carries 128 bits in base64url with no padding and no URL-unsafe character', () => {
    const payload = mintInteractionToken().slice(INTERACTION_TOKEN_VERSION.length + 1);
    // 16 bytes is 22 base64url characters; a padded or standard-alphabet encoding would be 24 and
    // would carry `=` or `+`/`/`, all three of which need escaping somewhere this token travels.
    expect(payload).toHaveLength(Math.ceil((INTERACTION_TOKEN_ENTROPY_BYTES * 8) / 6));
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('encodes exactly 16 bytes, which the final character proves', () => {
    // 128 bits do not divide into 6-bit groups: 21 characters carry 126 of them and the 22nd
    // carries the last **2**, left-aligned, with four zero bits under them. So the final character
    // can only ever be `A`, `Q`, `g` or `w` — base64url indices 0, 16, 32 and 48.
    //
    // Which makes it a free check that the payload is an *encoding* and not 22 characters drawn
    // from the alphabet. A wrong byte count is already caught by the length — 22 base64url
    // characters means 16 bytes and nothing else — but a hand-rolled "pick 22 random characters"
    // would pass the pattern, the length and every other test here while carrying 132 bits in a
    // shape no decoder produces. This is the assertion that says the bytes came from base64url.
    const finals = new Set<string>();
    for (let draw = 0; draw < 2_000; draw += 1) {
      finals.add(mintInteractionToken().slice(-1));
    }
    expect([...finals].toSorted().join('')).toBe('AQgw');
  });

  it('never repeats across ten thousand draws', () => {
    const seen = new Set<string>();
    for (let draw = 0; draw < 10_000; draw += 1) seen.add(mintInteractionToken());
    expect(seen.size).toBe(10_000);
  });
});

describe('isInteractionToken', () => {
  it('accepts what the minter produces', () => {
    for (let draw = 0; draw < 200; draw += 1) {
      expect(isInteractionToken(mintInteractionToken())).toBe(true);
    }
  });

  it('rejects the structured payloads 06 §3.7 bans', () => {
    // The named examples: "No structured strings (`cnf:…`, `poll:…`) ever go into `callback_data`".
    for (const structured of [
      'cnf:42:approve',
      'poll:7:2',
      'confirm',
      '{"kind":"confirm"}',
      'v1.cnf:42:approveeeeeeeeee',
    ]) {
      expect(isInteractionToken(structured), structured).toBe(false);
    }
  });

  it('rejects a wrong version, length or alphabet', () => {
    const good = mintInteractionToken();
    const payload = good.slice(3);
    for (const bad of [
      '',
      payload,
      `v2.${payload}`,
      `v1_${payload}`,
      `v1.${payload.slice(0, 21)}`,
      `v1.${payload}a`,
      `v1.${payload.slice(0, 21)}+`,
      `v1.${payload.slice(0, 21)}=`,
      ` ${good}`,
      `${good} `,
      `${good}\n`,
    ]) {
      expect(isInteractionToken(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('is anchored at both ends', () => {
    // An unanchored pattern would accept a token with a command glued to it, which is exactly the
    // shape an injection takes on a platform that concatenates payloads.
    expect(isInteractionToken(`prefix${mintInteractionToken()}`)).toBe(false);
    expect(isInteractionToken(`${mintInteractionToken()}:approve`)).toBe(false);
  });
});

describe('the platform budgets 06 §3.7 names', () => {
  it('holds a token on every profile that has buttons', () => {
    for (const name of PROFILE_NAMES) {
      const limits = profiles[name].buttonLimits;
      if (limits === null) continue;
      expect(tokenFitsButtonLimits(limits), name).toBe(true);
    }
  });

  it('is checked against the capability numbers, with Telegram’s 64 bytes the tightest', () => {
    // `06` §3.7: Telegram `callback_data` ≤64, Discord `custom_id` ≤100, Slack `value` ≤2000.
    expect(profiles.telegram.buttonLimits?.tokenMaxBytes).toBe(64);
    expect(profiles.discord.buttonLimits?.tokenMaxBytes).toBe(100);
    expect(profiles.slack.buttonLimits?.tokenMaxBytes).toBe(2_000);
    const tightest = Math.min(
      ...PROFILE_NAMES.map(
        (name) => profiles[name].buttonLimits?.tokenMaxBytes ?? Number.POSITIVE_INFINITY,
      ),
    );
    expect(tightest).toBeGreaterThanOrEqual(INTERACTION_TOKEN_BYTES);
  });

  it('says no when a budget is too small, rather than rounding it up', () => {
    const limits = (tokenMaxBytes: number) => ({
      maxPerMessage: 8,
      maxPerRow: 3,
      maxLabelChars: 30,
      tokenMaxBytes,
    });
    expect(tokenFitsButtonLimits(limits(INTERACTION_TOKEN_BYTES - 1))).toBe(false);
    // The boundary, which no profile exercises: every real platform has room to spare, so a `>`
    // written where `>=` belongs would be invisible until a platform turned up with exactly 25.
    expect(tokenFitsButtonLimits(limits(INTERACTION_TOKEN_BYTES))).toBe(true);
  });
});

describe('the deep-link charset (06 §3.7’s corrected claim)', () => {
  it('is not satisfied by a token, because `.` is outside it', () => {
    // `06` §3.7 claimed the token "fits … Telegram start payloads (≤64 chars of `A-Za-z0-9_-`)".
    // It does not, and the sentence is corrected in this commit. Asserted rather than deleted so
    // the next person to read the old claim finds the reason here.
    expect(mintInteractionToken()).not.toMatch(TELEGRAM_START_PAYLOAD);
    expect(TELEGRAM_START_PAYLOAD.test('lnk_AAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
  });

  it('would fit if the separator were `_`, which is why the payloads that need it use one', () => {
    // `06` §3.18.1's `lnk_` and §3.19's `onb_` both do. Nothing needs an *action* in a deep link:
    // a link opens a chat, and the buttons that carry tokens live inside it.
    expect(mintInteractionToken().replace('.', '_')).toMatch(TELEGRAM_START_PAYLOAD);
  });
});

describe('interactionTokenHash', () => {
  it('is a 32-byte SHA-256 and is deterministic', () => {
    const token = mintInteractionToken();
    const hash = interactionTokenHash(token);
    expect(hash).toHaveLength(32);
    expect([...interactionTokenHash(token)]).toEqual([...hash]);
  });

  it('does not contain the token', () => {
    // `06` §3.7: "The server stores only `sha256(token)`." A dump of `interaction_tokens` must not
    // be replayable into clicks, and the rows outlive the message by up to 7 days.
    const token = mintInteractionToken();
    const hex = [...interactionTokenHash(token)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    expect(hex).not.toContain(token.slice(3, 11));
  });

  it('differs for two tokens that differ in one character', () => {
    const token = mintInteractionToken();
    const near = `${token.slice(0, -1)}${token.endsWith('A') ? 'E' : 'A'}`;
    expect([...interactionTokenHash(near)]).not.toEqual([...interactionTokenHash(token)]);
  });
});

describe('interactionTokenMatches (03 §3.3.12 rule 3)', () => {
  it('accepts the token that produced the hash', () => {
    const token = mintInteractionToken();
    expect(interactionTokenMatches(token, interactionTokenHash(token))).toBe(true);
  });

  it('rejects a near miss, including one that shares every byte but the last', () => {
    const token = mintInteractionToken();
    const stored = interactionTokenHash(token);
    expect(interactionTokenMatches(`${token.slice(0, -1)}_`, stored)).toBe(false);
    expect(interactionTokenMatches(mintInteractionToken(), stored)).toBe(false);
    expect(interactionTokenMatches('', stored)).toBe(false);
  });

  it('refuses a digest of the wrong length rather than comparing the wrong column', () => {
    // A truncated or hex-encoded column is a mix-up that a boolean comparison would answer
    // `false` to for every token in the table — every button in the product dead, silently.
    const token = mintInteractionToken();
    expect(() => interactionTokenMatches(token, new Uint8Array(16))).toThrow(RangeError);
    expect(() => interactionTokenMatches(token, new Uint8Array(64))).toThrow(RangeError);
  });
});

describe('ActionButtonSchema (the outbound gate)', () => {
  const button = (token: string) => ({ label: 'Approve', style: 'primary' as const, token });

  it('accepts a minted token', () => {
    expect(ActionButtonSchema.safeParse(button(mintInteractionToken())).success).toBe(true);
  });

  it('refuses a structured payload, which is what makes 06 §3.7’s rule structural', () => {
    for (const bad of ['cnf:42:approve', 'poll:7:2', 'approve', '']) {
      expect(ActionButtonSchema.safeParse(button(bad)).success, bad).toBe(false);
    }
  });

  it('takes a reaction key for `emojiFallback` and refuses a literal emoji', () => {
    const base = button(mintInteractionToken());
    expect(ActionButtonSchema.safeParse({ ...base, emojiFallback: 'check' }).success).toBe(true);
    expect(
      ActionButtonSchema.safeParse({ ...base, emojiFallback: String.fromCodePoint(0x2705) })
        .success,
    ).toBe(false);
  });
});

describe('defaultInteractionTokenExpiry', () => {
  it('is 06 §3.7’s seven days', () => {
    const now = Temporal.Instant.from('2026-11-15T09:30:00Z');
    expect(DEFAULT_INTERACTION_TOKEN_TTL_DAYS).toBe(7);
    expect(defaultInteractionTokenExpiry(now).toString()).toBe('2026-11-22T09:30:00Z');
  });

  it('adds exact hours, so a clock change cannot shorten or lengthen it', () => {
    // An `Instant` has no calendar, and `Temporal` enforces that: `instant.add({ days: 7 })`
    // throws `RangeError: Largest unit cannot be a date unit`. So the hours form is not a
    // stylistic choice — the type makes the bug unwritable. Worth asserting anyway, because the
    // bug it forecloses is a real one: a 7-day TTL measured in *local* days is 167 or 169 hours
    // across a clock change, and a button that expires an hour early is a confirmation that
    // silently cannot be answered.
    const dstEve = Temporal.Instant.from('2027-03-25T12:00:00Z');
    expect(defaultInteractionTokenExpiry(dstEve).epochMilliseconds - dstEve.epochMilliseconds).toBe(
      7 * 24 * 60 * 60 * 1_000,
    );
  });
});
