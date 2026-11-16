/**
 * Reading an answer that did not arrive as a button press (`06` §3.7; `03` §3.3.12 rule 2;
 * `M3-T6`).
 *
 * On Matrix and Signal a choice is a reaction or a typed `1`. On every platform a confirmation can
 * be answered with a reaction even where buttons exist. So an answer arrives as free-ish text or as
 * an emoji, and this module decides which option — if any — it names.
 *
 * ## Three outcomes, not two
 *
 * `matched` is obvious. The other two are the design:
 *
 * - **`none`** — this was not an answer. Say nothing. A member chatting in the conversation while a
 *   poll is open is not voting, and a bot that replied "I didn't understand" to every unrelated
 *   message would be the single most annoying thing in the group.
 * - **`ambiguous`** — this was *aimed* at the prompt and could not be read. `06` §3.7 and `03`
 *   §3.3.12 rule 2 both say "ignored with a nudge", and the nudge is only possible because this
 *   outcome exists separately. The test for "aimed at" is the platform's own reply marker: a
 *   member who used the reply affordance on the confirmation message meant to answer it.
 *
 * Collapsing `ambiguous` into `none` would make Village silent at the one moment a member is
 * waiting; collapsing it the other way would make Village chatty at every other moment.
 *
 * ## What `confirmation: true` changes, and what it does not
 *
 * `03` §3.3.12 rule 2 is normative and stricter than `06` §3.7's general choice rule. Exactly one
 * thing differs: a confirmation has **no 10-minute next-message rule**, so a text answer counts
 * only as a platform *reply* to the confirmation message. That is the whole of the AC's "a bare
 * 'yes' as the next message does not decide a confirmation" — and it is a real attack surface, not
 * a nicety: without it, a guardian who happens to type "ok" to something else in the chat within
 * ten minutes has approved a request they never read.
 *
 * Reactions are already strict in both modes, because a reaction carries the id of the message it
 * is on and an answer on some other message is not an answer.
 *
 * ## Digits are accepted for a confirmation too
 *
 * `03` §3.3.12 rule 2 lists only the per-locale yes/no lexicon for text. That is incomplete rather
 * than restrictive, and the spec is corrected in this commit: on a `buttons: false` platform the
 * confirmation is *rendered* by `renderChoiceFallback` as "Reply **1** for Approve, **2** for
 * Reject", so refusing `1` would mean printing an instruction and then ignoring it. A digit is
 * unambiguous, and it arrives through the same reply-only gate as the lexicon, so none of the three
 * protections rule 2 exists for is weakened. A confirmation with four options
 * (`approve_always`, `edit`) cannot be answered at all by yes/no.
 */
import {
  normaliseInboundEmoji,
  type ReactionKey,
  TELEGRAM_REACTIONS,
  UNICODE_REACTIONS,
} from '../reactions.js';
import type { ChoiceFallback, ChoiceOption } from './fallback.js';

/**
 * The words that mean "the affirmative option" and "the negative one".
 *
 * The union of `03` §3.3.12 rule 2's lexicon (`yes|yep|ok|sure` / `no|nope|cancel`) and `06`
 * §3.7's list (`yes`, `y`, `ok` / `no`, `n`), and nothing beyond it. Not copy — nothing here is
 * ever shown to anyone — but still `05`'s to extend per locale, which is what `lexicon` is for.
 * Widening the English set from here would be guessing at a language's answer words with no
 * speaker in the loop; `06` §3.7 says "locale-extended by 05 copy" for exactly that reason.
 */
export interface ChoiceLexicon {
  readonly yes: readonly string[];
  readonly no: readonly string[];
  /**
   * Words that join two answers without being one — "yes **or** no".
   *
   * They exist so that "yes or no?" is read as {@link ChoiceReply} `ambiguous` and earns a nudge,
   * rather than as `none` and earning silence. A member who writes that is asking a question, and
   * the answer is the prompt repeated.
   */
  readonly connectors: readonly string[];
}

/** English, per the sources above. `05` supplies the rest. */
export const EN_CHOICE_LEXICON: ChoiceLexicon = Object.freeze({
  yes: Object.freeze(['yes', 'yep', 'y', 'ok', 'sure']),
  no: Object.freeze(['no', 'nope', 'n', 'cancel']),
  connectors: Object.freeze(['or', 'and', 'vs']),
});

/** The keys whose option an affirmative answer selects. */
export const AFFIRMATIVE_KEYS: readonly ReactionKey[] = Object.freeze(['check', 'ack', 'done']);

/** The keys whose option a negative answer selects. */
export const NEGATIVE_KEYS: readonly ReactionKey[] = Object.freeze(['cross', 'no']);

/**
 * The emoji that mean yes or no, in normalised form.
 *
 * Derived from the reaction maps rather than written out, which is what keeps `06` §3.7's
 * "`✅` `\u{1F44D}` = approve, `❌` `\u{1F44E}` = reject" and §3.9's platform
 * substitutions from drifting apart. Both emoji maps contribute, so Telegram's `\u{1F44C}` for
 * `done` is understood as a yes — a member who taps it on a Telegram confirmation means "ok", and
 * the only reason it is not in §3.7's list is that §3.7 lists the unrestricted spellings.
 *
 * `SLACK_REACTIONS` is deliberately **not** a source: its values are names, not emoji, and an
 * inbound Slack reaction is converted to an emoji by the adapter (`06` §3.9, `M8`).
 */
function emojiFor(keys: readonly ReactionKey[]): ReadonlySet<string> {
  const set = new Set<string>();
  for (const map of [UNICODE_REACTIONS, TELEGRAM_REACTIONS]) {
    for (const key of keys) {
      const emoji = map[key];
      if (emoji !== null) set.add(normaliseInboundEmoji(emoji));
    }
  }
  return set;
}

const AFFIRMATIVE_EMOJI = emojiFor(AFFIRMATIVE_KEYS);
const NEGATIVE_EMOJI = emojiFor(NEGATIVE_KEYS);

/** `U+20E3`, the enclosing keycap. Stripped so a typed `1️⃣` reads as `1`. */
const COMBINING_KEYCAP = String.fromCharCode(0x20e3);
const VARIATION_SELECTOR_16 = String.fromCharCode(0xfe0f);

/**
 * Punctuation and separators, for trimming and for tokenising.
 *
 * `\p{P}` and `\p{Z}` only — deliberately **not** `\p{S}`. Every emoji this module understands is
 * `\p{So}`, so a symbol class in the trim set would reduce an answer of `\u2705` to the empty
 * string and silently drop every emoji-shaped text reply. `choice-parser.test.ts` plants that
 * exact change, because it is invisible in every other case: `yes!` and `1.` trim identically
 * either way.
 */
const EDGE_NOISE = /^[\p{P}\p{Z}\s]+|[\p{P}\p{Z}\s]+$/gu;
const SEPARATORS = /[\p{P}\p{Z}\s]+/u;

/**
 * The form an answer is compared in.
 *
 * NFC, keycap decorations removed, edge punctuation removed, lowercased. Each step answers a real
 * message: `1.` and `"yes"` and `yes!` are answers, `1\uFE0F\u20E3` is what a phone keyboard
 * produces for the keycap Village pre-reacted with, and `Yes` is the common spelling.
 */
function normaliseAnswer(text: string): string {
  return text
    .normalize('NFC')
    .replaceAll(VARIATION_SELECTOR_16, '')
    .replaceAll(COMBINING_KEYCAP, '')
    .replaceAll(EDGE_NOISE, '')
    .toLowerCase();
}

/** Text or a reaction, with the one piece of context that decides whether it can be an answer. */
export type ChoiceInput =
  | {
      readonly kind: 'text';
      readonly text: string;
      /** Whether the member used the platform's reply affordance on the prompt message. */
      readonly isReplyToPrompt: boolean;
    }
  | {
      readonly kind: 'reaction';
      readonly emoji: string;
      /** Whether the reaction is on the prompt message itself (`03` §3.3.12 rule 2). */
      readonly onPromptMessage: boolean;
    };

export interface ParseChoiceOptions {
  /** What was offered — `renderChoiceFallback`'s result, which is also the parse table. */
  readonly fallback: ChoiceFallback;
  /** `true` for a `confirm` token, which applies `03` §3.3.12 rule 2's stricter gate. */
  readonly confirmation: boolean;
  /** Defaults to {@link EN_CHOICE_LEXICON}. */
  readonly lexicon?: ChoiceLexicon;
}

export type ChoiceReply =
  | { readonly outcome: 'matched'; readonly choice: ChoiceOption }
  /** Aimed at the prompt and unreadable. `05` sends the nudge. */
  | { readonly outcome: 'ambiguous' }
  /** Not an answer. Say nothing. */
  | { readonly outcome: 'none' };

/** Every option a single term could name. More than one is what `ambiguous` is for. */
function optionsNamedBy(
  term: string,
  choices: readonly ChoiceOption[],
  lexicon: ChoiceLexicon,
): readonly ChoiceOption[] {
  const byMarker = choices.filter((choice) => normaliseAnswer(choice.marker) === term);
  if (byMarker.length > 0) return byMarker;
  const byDigit = choices.filter((choice) => String(choice.index + 1) === term);
  if (byDigit.length > 0) return byDigit;
  if (lexicon.yes.includes(term) || AFFIRMATIVE_EMOJI.has(term)) {
    return choices.filter((choice) => choice.key !== null && AFFIRMATIVE_KEYS.includes(choice.key));
  }
  if (lexicon.no.includes(term) || NEGATIVE_EMOJI.has(term)) {
    return choices.filter((choice) => choice.key !== null && NEGATIVE_KEYS.includes(choice.key));
  }
  return [];
}

/**
 * `matched` when the terms name exactly one option, `ambiguous` when they name several.
 *
 * Written as a loop rather than `const [choice] = [...named]` so that there is no
 * `choice === undefined` branch to be unreachable: `size > 1` has already returned, so the loop
 * body runs at most once and the fall-through is the empty case.
 */
function fromNamed(named: ReadonlySet<ChoiceOption>): ChoiceReply | null {
  if (named.size > 1) return { outcome: 'ambiguous' };
  for (const choice of named) return { outcome: 'matched', choice };
  return null;
}

/**
 * Read a typed answer.
 *
 * Whole string first, then every token — and the token pass requires that **every** token be
 * either an answer or a connector. "yes" matches. "yes or no" is ambiguous. "yes please" matches
 * nothing, because `please` is neither, and that is the deliberate conservative edge: a reply this
 * module cannot read in full is a reply it does not act on. The alternative — scanning a sentence
 * for the first yes-word — reads "I don't think yes is right" as an approval.
 */
function parseText(
  text: string,
  choices: readonly ChoiceOption[],
  lexicon: ChoiceLexicon,
): ChoiceReply | null {
  const normalised = normaliseAnswer(text);
  if (normalised.length === 0) return null;
  const whole = fromNamed(new Set(optionsNamedBy(normalised, choices, lexicon)));
  if (whole !== null) return whole;
  const named = new Set<ChoiceOption>();
  for (const term of normalised.split(SEPARATORS)) {
    // No empty-term guard: `normalised` has had its edges trimmed by the same character classes
    // the split uses, and `+` collapses internal runs, so `split` cannot produce one. A guard here
    // would be a branch no test could reach — and if the two regexes ever disagreed, an empty term
    // names no option, is not a connector, and makes the whole reply unreadable. Which is the safe
    // answer anyway.
    const options = optionsNamedBy(term, choices, lexicon);
    if (options.length === 0 && !lexicon.connectors.includes(term)) return null;
    for (const option of options) named.add(option);
  }
  return fromNamed(named);
}

/** Read a reaction: the offered emoji, or a yes/no emoji against a declared key. */
function parseReaction(emoji: string, choices: readonly ChoiceOption[]): ChoiceReply | null {
  const normalised = normaliseInboundEmoji(emoji);
  const offered = choices.filter(
    (choice) => choice.reaction !== null && normaliseInboundEmoji(choice.reaction) === normalised,
  );
  const matched = fromNamed(new Set(offered));
  if (matched !== null) return matched;
  const keys = AFFIRMATIVE_EMOJI.has(normalised)
    ? AFFIRMATIVE_KEYS
    : NEGATIVE_EMOJI.has(normalised)
      ? NEGATIVE_KEYS
      : null;
  if (keys === null) return null;
  return fromNamed(
    new Set(choices.filter((choice) => choice.key !== null && keys.includes(choice.key))),
  );
}

/**
 * Which option an answer names (`06` §3.7's `parseChoiceReply`).
 *
 * The gates come before the grammar, because they are what makes the grammar safe to be generous
 * with. A reaction must be on the prompt message. A confirmation's text answer must be a reply to
 * it. Only then does it matter what the words say.
 */
export function parseChoiceReply(input: ChoiceInput, options: ParseChoiceOptions): ChoiceReply {
  const choices = options.fallback.choices;
  if (choices.length === 0) return { outcome: 'none' };
  if (input.kind === 'reaction') {
    // `06` §3.9 and `03` §3.3.12 rule 2: a reaction counts only on the prompt itself, and
    // "anything else is ignored" — silently, with no nudge, because a reaction on a message is a
    // normal thing to do and most of them are not answers.
    if (!input.onPromptMessage) return { outcome: 'none' };
    return parseReaction(input.emoji, choices) ?? { outcome: 'none' };
  }
  // `03` §3.3.12 rule 2: no 10-minute next-message rule for a confirmation. The next message is
  // not an answer, however much it looks like one.
  if (options.confirmation && !input.isReplyToPrompt) return { outcome: 'none' };
  const parsed = parseText(input.text, choices, options.lexicon ?? EN_CHOICE_LEXICON);
  if (parsed !== null) return parsed;
  // A deliberate reply to the prompt that could not be read earns the nudge; an ordinary message
  // that happened to arrive inside the 10-minute window earns silence.
  return input.isReplyToPrompt ? { outcome: 'ambiguous' } : { outcome: 'none' };
}
