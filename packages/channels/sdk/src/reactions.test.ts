/**
 * The reaction maps (`06` §3.9; `M3-T6`).
 *
 * One property carries this file: **every emoji the Telegram map can emit is in Telegram's own
 * allowlist.** Everything else is a detail check around it.
 *
 * That property is worth more than it looks. `setMessageReaction` with an emoji outside the list is
 * a `400`, and the failure is not uniform — it depends on which canonical key `05` happened to
 * ask for, so a reaction ack works all day and the one time a reminder fires with `done` it does
 * not. There is no way to notice that from reading the map: `✅` and `\u{1F44C}` look equally
 * plausible next to the word `done`. The allowlist is the only thing that can tell them apart, and
 * it is a third-party fact, so it is written down and checked rather than remembered.
 *
 * Emoji in this file are built from code points for the reason `reactions.ts` gives: `❤` and
 * `❤️` are visibly identical and Telegram accepts only one of them.
 */
import { describe, expect, it } from 'vitest';
import {
  COMBINING_KEYCAP,
  isReactionKey,
  normaliseInboundEmoji,
  REACTION_KEYS,
  type ReactionKey,
  reactionFor,
  reactionsFor,
  SLACK_REACTIONS,
  TELEGRAM_ALLOWED_REACTIONS,
  TELEGRAM_REACTIONS,
  UNICODE_REACTIONS,
  VARIATION_SELECTOR_16,
} from './index.js';

const cp = (...points: readonly number[]): string => String.fromCodePoint(...points);

const THUMBS_UP = cp(0x1f44d);
const THUMBS_DOWN = cp(0x1f44e);
const OK_HAND = cp(0x1f44c);
const EYES = cp(0x1f440);
const PARTY = cp(0x1f389);
const HEART = cp(0x2764);
const THINKING = cp(0x1f914);
const PEN = cp(0x270d);
const CHECK = cp(0x2705);
const CROSS = cp(0x274c);

describe('the canonical keys', () => {
  it('are exactly 06 §3.9’s list, in its order', () => {
    expect([...REACTION_KEYS]).toEqual([
      'ack',
      'done',
      'no',
      'seen',
      'celebrate',
      'heart',
      'thinking',
      'writing',
      'one',
      'two',
      'three',
      'four',
      'check',
      'cross',
    ]);
  });

  it('are each mapped by every platform map', () => {
    // A map missing a key is a `TypeError` at the call site in production, not here, because
    // `Record<ReactionKey, …>` is only checked where the literal is written.
    for (const key of REACTION_KEYS) {
      expect(Object.hasOwn(UNICODE_REACTIONS, key), `unicode/${key}`).toBe(true);
      expect(Object.hasOwn(TELEGRAM_REACTIONS, key), `telegram/${key}`).toBe(true);
      expect(Object.hasOwn(SLACK_REACTIONS, key), `slack/${key}`).toBe(true);
    }
  });

  it('are recognised by `isReactionKey`, and nothing else is', () => {
    for (const key of REACTION_KEYS) expect(isReactionKey(key), key).toBe(true);
    for (const other of ['', 'ACK', 'thumbsup', 'five', 'check ']) {
      expect(isReactionKey(other), JSON.stringify(other)).toBe(false);
    }
  });
});

describe('Telegram’s allowlist (verified against the Bot API 2026-11-15)', () => {
  it('has the 73 emoji the docs list, with no duplicates', () => {
    expect(TELEGRAM_ALLOWED_REACTIONS).toHaveLength(73);
    expect(new Set(TELEGRAM_ALLOWED_REACTIONS).size).toBe(73);
  });

  it('contains none of the emoji 06 §3.9 says it lacks', () => {
    // The premise of the whole substitution table. If any of these were in the list, the four
    // overrides below would be unnecessary complexity — and if the list silently grew to include
    // them, this test is where we would find out.
    for (const absent of [CHECK, CROSS, `1${VARIATION_SELECTOR_16}${COMBINING_KEYCAP}`]) {
      expect(
        TELEGRAM_ALLOWED_REACTIONS,
        [...absent].map((c) => c.codePointAt(0)).join(),
      ).not.toContain(absent);
    }
  });

  it('contains the four substitutes 06 §3.9 names, in the spelling Telegram publishes', () => {
    for (const present of [OK_HAND, THUMBS_UP, THUMBS_DOWN, PEN]) {
      expect(TELEGRAM_ALLOWED_REACTIONS).toContain(present);
    }
    // Unqualified: `✍` with no `️`. Sending the qualified form is a different string,
    // and this is the assertion that keeps a well-meaning "add the variation selector" from
    // breaking every `writing` reaction on Telegram.
    expect(TELEGRAM_ALLOWED_REACTIONS).not.toContain(`${PEN}${VARIATION_SELECTOR_16}`);
    expect(TELEGRAM_ALLOWED_REACTIONS).not.toContain(`${HEART}${VARIATION_SELECTOR_16}`);
  });
});

describe('the Telegram map', () => {
  it('never emits an emoji outside the allowlist', () => {
    // The headline property. A `400 REACTION_INVALID` is the only other way to learn this.
    for (const key of REACTION_KEYS) {
      const emoji = TELEGRAM_REACTIONS[key];
      if (emoji === null) continue;
      expect(
        TELEGRAM_ALLOWED_REACTIONS,
        `${key} → ${[...emoji].map((c) => c.codePointAt(0)).join()}`,
      ).toContain(emoji);
    }
  });

  it('applies 06 §3.9’s four substitutions', () => {
    expect(TELEGRAM_REACTIONS.done).toBe(OK_HAND);
    expect(TELEGRAM_REACTIONS.check).toBe(THUMBS_UP);
    expect(TELEGRAM_REACTIONS.cross).toBe(THUMBS_DOWN);
    expect(TELEGRAM_REACTIONS.writing).toBe(PEN);
  });

  it('has no keycaps, so a numbered choice there is a keyboard and not reactions', () => {
    for (const key of ['one', 'two', 'three', 'four'] as const) {
      expect(TELEGRAM_REACTIONS[key], key).toBeNull();
    }
  });

  it('uses the unqualified heart and pen', () => {
    expect(TELEGRAM_REACTIONS.heart).toBe(HEART);
    expect(TELEGRAM_REACTIONS.writing).toBe(PEN);
    expect(UNICODE_REACTIONS.heart).toBe(`${HEART}${VARIATION_SELECTOR_16}`);
    expect(UNICODE_REACTIONS.writing).toBe(`${PEN}${VARIATION_SELECTOR_16}`);
  });
});

describe('the unicode map', () => {
  it('is 06 §3.7’s confirm pair and 06 §3.9’s acknowledgments', () => {
    expect(UNICODE_REACTIONS.check).toBe(CHECK);
    expect(UNICODE_REACTIONS.cross).toBe(CROSS);
    expect(UNICODE_REACTIONS.ack).toBe(THUMBS_UP);
    expect(UNICODE_REACTIONS.no).toBe(THUMBS_DOWN);
    expect(UNICODE_REACTIONS.seen).toBe(EYES);
    expect(UNICODE_REACTIONS.celebrate).toBe(PARTY);
    expect(UNICODE_REACTIONS.thinking).toBe(THINKING);
  });

  it('numbers one to four as fully-qualified keycaps', () => {
    const keys: readonly ReactionKey[] = ['one', 'two', 'three', 'four'];
    for (const [index, key] of keys.entries()) {
      expect(UNICODE_REACTIONS[key], key).toBe(
        `${String(index + 1)}${VARIATION_SELECTOR_16}${COMBINING_KEYCAP}`,
      );
    }
  });
});

describe('the two collisions, which are deliberate', () => {
  it('maps `done` and `check` to the same emoji off Telegram, and different ones on it', () => {
    // `done` is "the task is finished", `check` is "yes". Telegram has 👌 and 👍 for those; every
    // other platform has one ✅. Collapsing the keys would lose the Telegram distinction, which is
    // the only reason `06` §3.9 lists them separately.
    expect(UNICODE_REACTIONS.done).toBe(UNICODE_REACTIONS.check);
    expect(TELEGRAM_REACTIONS.done).not.toBe(TELEGRAM_REACTIONS.check);
  });

  it('maps `ack` and `check` to the same emoji on Telegram, and different ones off it', () => {
    expect(TELEGRAM_REACTIONS.ack).toBe(TELEGRAM_REACTIONS.check);
    expect(UNICODE_REACTIONS.ack).not.toBe(UNICODE_REACTIONS.check);
  });
});

describe('the Slack map', () => {
  it('uses the six names 06 §3.9 writes out', () => {
    expect(SLACK_REACTIONS.check).toBe('white_check_mark');
    expect(SLACK_REACTIONS.done).toBe('white_check_mark');
    expect(SLACK_REACTIONS.cross).toBe('x');
    expect(SLACK_REACTIONS.seen).toBe('eyes');
    expect(SLACK_REACTIONS.celebrate).toBe('tada');
    expect(SLACK_REACTIONS.heart).toBe('heart');
    expect(SLACK_REACTIONS.one).toBe('one');
  });

  it('is names and never emoji, because `reactions.add` takes a name', () => {
    for (const key of REACTION_KEYS) {
      expect(SLACK_REACTIONS[key], key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe('reactionsFor', () => {
  it('gives each platform its own map', () => {
    expect(reactionsFor('telegram')).toBe(TELEGRAM_REACTIONS);
    expect(reactionsFor('slack')).toBe(SLACK_REACTIONS);
    for (const channel of ['discord', 'matrix', 'signal', 'web', 'simulator', 'mcp']) {
      expect(reactionsFor(channel), channel).toBe(UNICODE_REACTIONS);
    }
  });

  it('gives a plugin channel the unicode map rather than assuming a restriction', () => {
    // `10` §3 lets a plugin register a channel. Assuming it is restricted would silently drop
    // every reaction on a channel that handles them fine; the plugin ships its own map if not.
    expect(reactionsFor('bluebubbles')).toBe(UNICODE_REACTIONS);
  });

  it('agrees with `reactionFor` for every key on every known channel', () => {
    for (const channel of ['telegram', 'slack', 'discord', 'matrix', 'signal', 'web']) {
      for (const key of REACTION_KEYS) {
        expect(reactionFor(key, channel), `${channel}/${key}`).toBe(reactionsFor(channel)[key]);
      }
    }
  });
});

describe('normaliseInboundEmoji (06 §3.9)', () => {
  it('strips the variation selector', () => {
    expect(normaliseInboundEmoji(`${HEART}${VARIATION_SELECTOR_16}`)).toBe(HEART);
    expect(normaliseInboundEmoji(HEART)).toBe(HEART);
  });

  it('makes a member’s ❤️ match Village’s ❤ on Telegram', () => {
    // The reason the function exists. Telegram's allowlist is unqualified, most clients send the
    // qualified form, and an unrecognised reaction on a confirmation is an answer nobody gets.
    expect(normaliseInboundEmoji(`${HEART}${VARIATION_SELECTOR_16}`)).toBe(
      normaliseInboundEmoji(TELEGRAM_REACTIONS.heart ?? ''),
    );
  });

  it('normalises to NFC', () => {
    // Not an emoji, but the same table and the same uniqueness key in `02`'s `message_reactions`.
    const decomposed = `e${cp(0x0301)}`;
    expect(normaliseInboundEmoji(decomposed)).toBe(cp(0x00e9));
  });

  it('keeps the keycap’s combining character, so 1️⃣ stays distinguishable from a typed 1', () => {
    const keycap = `1${VARIATION_SELECTOR_16}${COMBINING_KEYCAP}`;
    expect(normaliseInboundEmoji(keycap)).toBe(`1${COMBINING_KEYCAP}`);
    expect(normaliseInboundEmoji(keycap)).not.toBe('1');
  });

  it('leaves a skin-tone modifier alone', () => {
    // 👍🏽 is a different reaction from 👍 for `07`'s feedback. The one place it would matter —
    // matching an offered choice — compares against what Village reacted with, which has none.
    const toned = `${THUMBS_UP}${cp(0x1f3fd)}`;
    expect(normaliseInboundEmoji(toned)).toBe(toned);
  });
});
