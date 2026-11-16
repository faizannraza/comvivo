/**
 * Choices without buttons (`06` §3.7 "Fallback when `buttons: false`"; `M3-T6`).
 *
 * Matrix and Signal have no buttons. A Village that only knew how to ask a question with a
 * keyboard would be a Village that cannot run a poll, confirm a guardian request or close a
 * reminder on either of them — so the same `ActionRow[]` the engine builds for Telegram has to
 * become something answerable there, and this decides what.
 *
 * Two shapes, in `06` §3.7's order of preference:
 *
 * - **Reactions**, when the platform has them and there are at most four options. One tap, no
 *   typing, and the answer lands on the message it belongs to — which is also what makes it
 *   unambiguous, because a reaction carries the message id and a typed `1` does not.
 * - **Numbered text**, otherwise. "Reply **1** for …".
 *
 * ## Why this returns choices and not a rendered appendix
 *
 * `06` §4.1 typed this as returning `{ appendix: RichText; reactions: string[] }`. It now returns
 * the **choices**, and `06` §3.7/§4.1 are amended in this commit to match.
 *
 * The reason is the one already written down for the splitter's truncation notice (`06` §3.5.4,
 * `M3-T5`): "Reply **1** for …" is bot copy, `CLAUDE.md` §2 keeps bot copy in versioned template
 * files, and `channel-sdk` cannot reach the engine's copy service. An `appendix` built here would
 * be an English sentence hard-coded inside the SDK, invisible to every translator and to
 * `copy:check`, on a path that exists specifically for the platforms a non-English family is most
 * likely to be using. The appendix is rendered by `05`'s copy engine from the keys in
 * `packages/engine/copy/channels/en.yaml` (`M3-T18`), which needs exactly what this returns: a
 * marker, a label and nothing else.
 *
 * What is genuinely this module's to decide — and what the engine could not work out on its own —
 * is which of the two shapes a platform can support, and which marker belongs to which token.
 */
import type { ActionButton, ActionRow, ChannelCapabilities } from '../contract.js';
import { type ReactionKey, type ReactionMap, UNICODE_REACTIONS } from '../reactions.js';

/** `06` §3.7: "used when `reactions: true` and there are ≤4 options". */
export const MAX_REACTION_CHOICES = 4;

/** The positional keys, in order. A fifth option is what makes reaction choices impossible. */
const POSITIONAL_KEYS: readonly ReactionKey[] = ['one', 'two', 'three', 'four'];

/**
 * One answerable option.
 *
 * One shape for both kinds rather than a discriminated union, because `choice-parser.ts` has to
 * accept an answer in whichever form the member reached for — a Telegram confirmation is sent as
 * buttons and may still be answered with a reaction (`03` §3.3.12 rule 2) — so a parser that could
 * only see the fields of the shape that was *rendered* would have to be given both anyway. Nullable
 * rather than optional, so `exactOptionalPropertyTypes` does not make every construction site
 * conditional.
 */
export interface ChoiceOption {
  /** 0-based position across every row. `index + 1` is the digit a member may always type. */
  readonly index: number;
  readonly token: string;
  readonly label: string;
  /**
   * The canonical reaction key the producer declared (`ActionButton.emojiFallback`), or `null`.
   *
   * This is what lets a yes/no answer find its option. `06` §3.7 maps `\u2705`/`\u{1F44D}` to
   * "approve" and `\u274C`/`\u{1F44E}` to "reject", but only the producer knows which of its
   * buttons means approve — the label is copy and the token is opaque. The key says it.
   */
  readonly key: ReactionKey | null;
  /** What to pass to `react()` — an emoji, or a Slack name. `null` for a text choice. */
  readonly reaction: string | null;
  /** What the copy tells them to type: `"1"`, or a producer's `textFallback`. */
  readonly marker: string;
}

export interface ChoiceFallback {
  /** Which shape the copy should render. Both carry the same {@link ChoiceOption} list. */
  readonly kind: 'reactions' | 'text';
  readonly choices: readonly ChoiceOption[];
  /** The reactions to pre-apply, in option order (`06` §3.7: "Village pre-reacts"). Empty for text. */
  readonly reactions: readonly string[];
}

export interface ChoiceFallbackOptions {
  /**
   * The channel's reaction map — `reactionsFor(channel)`.
   *
   * Defaults to the unicode map, which is right for every platform that reaches this function
   * today: `buttons: false` holds for Matrix and Signal, and both have `reactionSet: 'any'`. The
   * parameter exists so that a restricted platform degrades **by itself**: Telegram's map has
   * `null` for the four keycaps, the resolution below sees it and falls through to text, and
   * nothing here has to know which platform it is looking at.
   */
  readonly reactions?: ReactionMap;
  /** Defaults to `06` §3.7's four. */
  readonly maxReactionChoices?: number;
}

/** Every button, flattened in reading order. Rows are a layout concern and not an answer order. */
function flatten(rows: readonly ActionRow[]): readonly ActionButton[] {
  return rows.flat();
}

/**
 * The reactions for each option, or `null` when this platform cannot carry reaction choices.
 *
 * Four independent reasons to decline, and each one is a real platform:
 *
 * 1. **No reactions at all.** Nothing to tap.
 * 2. **More than four options.** `06` §3.7's cap. Beyond it the reactions stop reading as an
 *    ordered list, and the keycap keys run out at four anyway.
 * 3. **A key this platform has no emoji for.** Telegram's keycaps are `null` in its map, so the
 *    degradation happens without this module knowing which platform it is looking at.
 * 4. **A one-reaction-per-message platform.** `06` §3.9: "Telegram allows bots **one** reaction
 *    per message." Pre-reacting four options is impossible there, so the offer could never be
 *    made. Reading `maxReactionsPerMessage` is the difference between a feature that degrades and
 *    one that sends four calls and keeps whichever landed last. `06` §3.7 did not state this
 *    check; it is added to the spec in this commit.
 */
function reactionsOf(
  buttons: readonly ActionButton[],
  caps: ChannelCapabilities,
  map: ReactionMap,
  maxChoices: number,
): readonly string[] | null {
  if (!caps.reactions || buttons.length === 0 || buttons.length > maxChoices) return null;
  if (caps.maxReactionsPerMessage !== null && caps.maxReactionsPerMessage < buttons.length) {
    return null;
  }
  const emoji: string[] = [];
  const seen = new Set<string>();
  for (const [index, button] of buttons.entries()) {
    const key = button.emojiFallback ?? POSITIONAL_KEYS[index];
    if (key === undefined) return null;
    const reaction = map[key];
    // `null` is "this platform has no emoji for that key"; a duplicate is two options a member
    // could not tell apart, which is worse than numbering them.
    if (reaction === null || seen.has(reaction)) return null;
    seen.add(reaction);
    emoji.push(reaction);
  }
  return emoji;
}

/**
 * The markers for text choices.
 *
 * Digits unless **every** button carries a distinct `textFallback`. All-or-nothing on purpose: a
 * message that reads "Reply **yes** for Approve, **2** for Reject" has taught the member two
 * grammars in one sentence, and a repeated marker is a reply `06` §3.7 has to ignore as ambiguous.
 * The digit is always accepted as well — `choice-parser.ts` derives it from `index` — so a
 * producer's marker adds a way to answer rather than replacing one.
 */
function markersOf(buttons: readonly ActionButton[]): readonly string[] {
  const custom = buttons.map((button) => button.textFallback?.trim() ?? '');
  const usable = custom.every((marker) => marker.length > 0);
  const distinct = new Set(custom.map((marker) => marker.toLowerCase())).size;
  return usable && distinct === buttons.length
    ? custom
    : buttons.map((_, index) => String(index + 1));
}

/**
 * Turn an action row set into something answerable without buttons (`06` §3.7).
 *
 * Pure and total: it never throws and always returns a usable shape, because the alternative on a
 * `buttons: false` platform is a question nobody can answer. Callable on a platform that *has*
 * buttons too, and the engine does exactly that for a confirmation — `03` §3.3.12 rule 2 lets a
 * member answer a Telegram confirmation with a reaction, so the choice table is the parse table
 * whether or not the fallback was ever rendered.
 */
export function renderChoiceFallback(
  rows: readonly ActionRow[],
  caps: ChannelCapabilities,
  options: ChoiceFallbackOptions = {},
): ChoiceFallback {
  const buttons = flatten(rows);
  const reactions = reactionsOf(
    buttons,
    caps,
    options.reactions ?? UNICODE_REACTIONS,
    options.maxReactionChoices ?? MAX_REACTION_CHOICES,
  );
  const markers = markersOf(buttons);
  const choices = buttons.map((button, index) => ({
    index,
    token: button.token,
    label: button.label,
    key: button.emojiFallback ?? POSITIONAL_KEYS[index] ?? null,
    reaction: reactions?.[index] ?? null,
    marker: markers[index] ?? String(index + 1),
  }));
  return reactions === null
    ? { kind: 'text', choices, reactions: [] }
    : { kind: 'reactions', choices, reactions };
}
