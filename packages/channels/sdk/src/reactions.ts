/**
 * Canonical reaction keys and their per-platform spellings (`06` §3.9; `M3-T6`).
 *
 * The engine never names an emoji. It asks for `done` or `cross`, and this module answers with
 * what the platform in front of it will actually accept — which is not the same string on every
 * platform and, on two of them, is not an emoji at all.
 *
 * Three facts drive the whole file, and none of them is guessable from the others:
 *
 * 1. **Telegram's reaction set is a fixed allowlist of 73 emoji** and it contains no ✅, no ❌ and
 *    no keycaps. A `setMessageReaction` with anything else is a `400`. So `06` §3.9 substitutes:
 *    `done` → 👌, `check` → 👍, `cross` → 👎, `writing` → ✍, and the four keycap keys are simply
 *    **unsupported** there.
 * 2. **Slack takes a *name*, not an emoji** — `reactions.add` is documented with
 *    `name: thumbsup`. So the value this module returns is "the identifier the platform's own API
 *    wants", which is an emoji string for five platforms and a short name for Slack.
 * 3. **Telegram's allowlist is written in unqualified form** — `❤` is `U+2764` with no `U+FE0F`,
 *    `✍` is `U+270D` with no `U+FE0F`. Sending the qualified form is a different string. That is
 *    why `TELEGRAM_REACTIONS` is not `UNICODE_REACTIONS` with four entries swapped.
 *
 * ## Why the tables are code points, not literal emoji
 *
 * Every emoji here is built from its code points. That is not decoration: the difference between
 * `❤` and `❤️` is one invisible character, the difference between `🤷` and `🤷‍♂` is an invisible
 * joiner, and both differences decide whether Telegram accepts the reaction. A literal table looks
 * right in every editor and diff whether or not it *is* right, so the one property this module
 * exists to guarantee would be unreviewable. The hex is unambiguous and `reactions.test.ts` checks
 * every emitted value against the allowlist.
 *
 * `TELEGRAM_ALLOWED_REACTIONS` was read off
 * [`ReactionTypeEmoji`](https://core.telegram.org/bots/api#reactiontypeemoji) on **2026-11-15**
 * (73 entries, `CLAUDE.md` §6). Telegram adds to it occasionally; a new entry can only *widen*
 * what is accepted, so a stale copy makes this module conservative rather than wrong.
 *
 * ## What is deliberately not here
 *
 * **A reverse emoji → key map.** It cannot exist without a lie: on Telegram `ack` and `check` are
 * both 👍, and `done` and `check` are both ✅ everywhere else, so some emoji have two keys. Nothing
 * needs one either — a member's reaction is interpreted against **the choices that were offered**
 * (`interactions/fallback.ts` carries them), not against a global table. `interactions/choice-parser.ts`
 * has its own small answer lexicon for the ✅/👍/❌/👎 case, which is a different thing: an input
 * grammar, not a rendering map.
 */
import type { ChannelId } from '@comvivo/core';

/**
 * The canonical keys, in `06` §3.9's order.
 *
 * Fourteen keys for ten distinct meanings, because two pairs collide on purpose:
 *
 * - `ack` and `check` are both 👍 on Telegram. `ack` is "seen, noted" (`05` uses it instead of a
 *   text reply when it has nothing to add); `check` is "yes" in an answer. Telegram has one emoji
 *   for both, other platforms do not, and collapsing them here would lose ✅ everywhere else.
 * - `done` and `check` are both ✅ off Telegram. `done` is "the task is finished" (`07`'s
 *   reminders); `check` is "yes". Telegram has 👌 and 👍 for those, which is exactly why `06` §3.9
 *   lists them as separate substitutions.
 *
 * Both collisions are asserted in the tests so that a later reader does not "simplify" them away.
 */
export const REACTION_KEYS = [
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
] as const;

export type ReactionKey = (typeof REACTION_KEYS)[number];

/** True for one of {@link REACTION_KEYS} — the gate a zod schema and a plugin's input need. */
export function isReactionKey(value: string): value is ReactionKey {
  return (REACTION_KEYS as readonly string[]).includes(value);
}

/**
 * One emoji from space-separated hex code points.
 *
 * `String.fromCodePoint` rather than a literal, for the reason in the module header: `'2764'` and
 * `'2764 FE0F'` are visibly identical and behave differently.
 */
function fromHex(spec: string): string {
  return String.fromCodePoint(...spec.split(' ').map((hex) => Number.parseInt(hex, 16)));
}

/** `U+FE0F`, the emoji-presentation selector. Stripped from every inbound emoji (`06` §3.9). */
export const VARIATION_SELECTOR_16 = fromHex('FE0F');

/** `U+20E3`, the enclosing keycap. `1` + `U+FE0F` + this is 1️⃣. */
export const COMBINING_KEYCAP = fromHex('20E3');

const THUMBS_UP = fromHex('1F44D');
const THUMBS_DOWN = fromHex('1F44E');
const OK_HAND = fromHex('1F44C');
const EYES = fromHex('1F440');
const PARTY_POPPER = fromHex('1F389');
const RED_HEART = fromHex('2764');
const THINKING_FACE = fromHex('1F914');
const WRITING_HAND = fromHex('270D');
const WHITE_CHECK_MARK = fromHex('2705');
const CROSS_MARK = fromHex('274C');

/** The fully-qualified keycap for a digit: `1️⃣`. */
function keycap(digit: 1 | 2 | 3 | 4): string {
  return `${String(digit)}${VARIATION_SELECTOR_16}${COMBINING_KEYCAP}`;
}

/** What a key resolves to on a platform, or `null` where the platform has no equivalent. */
export type ReactionMap = Readonly<Record<ReactionKey, string | null>>;

/**
 * The emoji each key means where the reaction set is unrestricted (`reactionSet: 'any'`).
 *
 * Discord, Matrix, Signal, the web channel and the simulator — anywhere a bot may react with any
 * emoji. Written in **qualified** form (`❤️`, `✍️`, `1️⃣`), which is what a client renders as an
 * emoji rather than as a dingbat glyph.
 */
export const UNICODE_REACTIONS: Readonly<Record<ReactionKey, string>> = Object.freeze({
  ack: THUMBS_UP,
  done: WHITE_CHECK_MARK,
  no: THUMBS_DOWN,
  seen: EYES,
  celebrate: PARTY_POPPER,
  heart: `${RED_HEART}${VARIATION_SELECTOR_16}`,
  thinking: THINKING_FACE,
  writing: `${WRITING_HAND}${VARIATION_SELECTOR_16}`,
  one: keycap(1),
  two: keycap(2),
  three: keycap(3),
  four: keycap(4),
  check: WHITE_CHECK_MARK,
  cross: CROSS_MARK,
});

/**
 * Every emoji Telegram accepts in a `ReactionTypeEmoji`, verified 2026-11-15.
 *
 * Exported so that `reactions.test.ts` can assert the one property that matters —
 * *every non-null value in `TELEGRAM_REACTIONS` is in this list* — and so that `M3-T32`'s adapter
 * can reject a host-configured reaction at boot instead of at send time. The unqualified spellings
 * are Telegram's own; see the module header.
 */
export const TELEGRAM_ALLOWED_REACTIONS: readonly string[] = Object.freeze(
  [
    '2764',
    '1F44D',
    '1F44E',
    '1F525', // ❤ 👍 👎 🔥
    '1F970',
    '1F44F',
    '1F601',
    '1F914', // 🥰 👏 😁 🤔
    '1F92F',
    '1F631',
    '1F92C',
    '1F622', // 🤯 😱 🤬 😢
    '1F389',
    '1F929',
    '1F92E',
    '1F4A9', // 🎉 🤩 🤮 💩
    '1F64F',
    '1F44C',
    '1F54A',
    '1F921', // 🙏 👌 🕊 🤡
    '1F971',
    '1F974',
    '1F60D',
    '1F433', // 🥱 🥴 😍 🐳
    '2764 200D 1F525',
    '1F31A',
    '1F32D',
    '1F4AF', // ❤‍🔥 🌚 🌭 💯
    '1F923',
    '26A1',
    '1F34C',
    '1F3C6', // 🤣 ⚡ 🍌 🏆
    '1F494',
    '1F928',
    '1F610',
    '1F353', // 💔 🤨 😐 🍓
    '1F37E',
    '1F48B',
    '1F595',
    '1F608', // 🍾 💋 🖕 😈
    '1F634',
    '1F62D',
    '1F913',
    '1F47B', // 😴 😭 🤓 👻
    '1F468 200D 1F4BB',
    '1F440',
    '1F383',
    '1F648', // 👨‍💻 👀 🎃 🙈
    '1F607',
    '1F628',
    '1F91D',
    '270D', // 😇 😨 🤝 ✍
    '1F917',
    '1FAE1',
    '1F385',
    '1F384', // 🤗 🫡 🎅 🎄
    '2603',
    '1F485',
    '1F92A',
    '1F5FF', // ☃ 💅 🤪 🗿
    '1F192',
    '1F498',
    '1F649',
    '1F984', // 🆒 💘 🙉 🦄
    '1F618',
    '1F48A',
    '1F64A',
    '1F60E', // 😘 💊 🙊 😎
    '1F47E',
    '1F937 200D 2642',
    '1F937',
    '1F937 200D 2640', // 👾 🤷‍♂ 🤷 🤷‍♀
    '1F621', // 😡
  ].map(fromHex),
);

/**
 * Telegram (`06` §3.9).
 *
 * The four substitutions `06` §3.9 names, plus `null` for the keycaps. The keycap `null`s are not
 * a gap to fill later: Telegram has `buttons: true`, so a numbered choice there is an inline
 * keyboard and never a reaction. `interactions/fallback.ts` reads the `null` and falls through to
 * text choices on its own, which is what makes the fallback correct on a restricted platform
 * without knowing which platform it is.
 */
export const TELEGRAM_REACTIONS: ReactionMap = Object.freeze({
  ack: THUMBS_UP,
  done: OK_HAND,
  no: THUMBS_DOWN,
  seen: EYES,
  celebrate: PARTY_POPPER,
  heart: RED_HEART,
  thinking: THINKING_FACE,
  writing: WRITING_HAND,
  one: null,
  two: null,
  three: null,
  four: null,
  check: THUMBS_UP,
  cross: THUMBS_DOWN,
});

/**
 * Slack (`06` §3.9).
 *
 * Names, not emoji: `reactions.add` takes `name`, documented with the example `thumbsup`. The six
 * names `06` §3.9 lists verbatim — `white_check_mark`, `x`, `eyes`, `tada`, `heart`, `one` — are
 * used exactly as written there.
 */
export const SLACK_REACTIONS: Readonly<Record<ReactionKey, string>> = Object.freeze({
  ack: 'thumbsup',
  done: 'white_check_mark',
  no: 'thumbsdown',
  seen: 'eyes',
  celebrate: 'tada',
  heart: 'heart',
  thinking: 'thinking_face',
  writing: 'writing_hand',
  one: 'one',
  two: 'two',
  three: 'three',
  four: 'four',
  check: 'white_check_mark',
  cross: 'x',
});

/** The channels whose platform API wants something other than the plain emoji. */
const OVERRIDES: ReadonlyMap<string, ReactionMap> = new Map([
  ['telegram', TELEGRAM_REACTIONS],
  ['slack', SLACK_REACTIONS],
]);

/**
 * The map for a channel.
 *
 * Keyed on `ChannelId` rather than on `ChannelCapabilities`, because capabilities say *that* a
 * platform's set is restricted (`reactionSet: 'restricted'`) and not *which* emoji are in it. A
 * plugin channel (`10` §3) gets the unicode map: `ChannelId` is an open union, and a platform that
 * cannot take any emoji has to say so by shipping its own map — assuming a restriction nobody
 * declared would silently drop reactions on a channel that handles them fine.
 */
export function reactionsFor(channel: ChannelId): ReactionMap {
  // A lookup rather than a `switch`: `ChannelId` is an open union, so an exhaustive switch would
  // have to name every channel that *does* use the unicode map and then be edited again for each
  // new one — which is the opposite of what the open union is for.
  return OVERRIDES.get(channel) ?? UNICODE_REACTIONS;
}

/** One key on one channel, or `null` where that platform has no equivalent. */
export function reactionFor(key: ReactionKey, channel: ChannelId): string | null {
  return reactionsFor(channel)[key];
}

/**
 * The form an inbound reaction is compared and stored in (`06` §3.9).
 *
 * NFC plus `U+FE0F` stripped. Both halves earn their place:
 *
 * - **NFC**, because the same reaction can arrive decomposed, and `02`'s `message_reactions` has a
 *   uniqueness key over `(messageRid, memberId, emoji)` — two spellings of one reaction would be
 *   two rows, and `04`'s extraction windows would read the agreement signal twice.
 * - **`U+FE0F` stripped**, because clients disagree about it. Telegram's allowlist is unqualified,
 *   most clients send the qualified form, and a member who reacts ❤️ to Village's ❤ would
 *   otherwise not be recognised as having answered.
 *
 * Skin-tone modifiers are left alone: 👍🏽 is a different reaction from 👍 as far as `07`'s
 * feedback is concerned, and folding them would erase that on purpose-built platforms. The one
 * place it matters — matching an offered choice — compares against what Village itself reacted
 * with, which never carries a modifier.
 */
export function normaliseInboundEmoji(emoji: string): string {
  return emoji.normalize('NFC').replaceAll(VARIATION_SELECTOR_16, '');
}
