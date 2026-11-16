/**
 * Reading an answer (`06` §3.7's `parseChoiceReply`; `03` §3.3.12 rule 2; `M3-T6`).
 *
 * The AC names one behaviour explicitly — "a bare 'yes' as the next message does not decide a
 * confirmation" — and it is the first block below, because it is the only rule here that is a
 * security control rather than a UX one. `03` §3.3.12 rule 2 drops the 10-minute next-message rule
 * for confirmations, and without it a guardian who types "ok" to something else in the chat within
 * ten minutes has approved a request they never read.
 *
 * The rest of the file is about the three-way outcome. `matched` is easy. The split between
 * `ambiguous` (nudge) and `none` (silence) is the design, and it is tested from both sides: a
 * deliberate reply that cannot be read earns the nudge, and an ordinary message that happens to
 * arrive in the window earns silence. Collapsing them either way makes Village silent at the one
 * moment a member is waiting, or chatty at every other moment.
 */
import { describe, expect, it } from 'vitest';
import type { ActionButton } from '../contract.js';
import { profiles } from '../index.js';
import { reactionsFor, UNICODE_REACTIONS, VARIATION_SELECTOR_16 } from '../reactions.js';
import {
  type ChoiceInput,
  type ChoiceLexicon,
  EN_CHOICE_LEXICON,
  parseChoiceReply,
} from './choice-parser.js';
import { type ChoiceFallback, renderChoiceFallback } from './fallback.js';
import { mintInteractionToken } from './token.js';

const button = (label: string, extra: Partial<ActionButton> = {}): ActionButton => ({
  label,
  style: 'secondary',
  token: mintInteractionToken(),
  ...extra,
});

/** A confirm pair on a platform with an open reaction set: ✅ / ❌. */
const confirmPair = (): ChoiceFallback =>
  renderChoiceFallback(
    [[button('Approve', { emojiFallback: 'check' }), button('Reject', { emojiFallback: 'cross' })]],
    profiles.signal,
  );

/** The same pair where buttons were shown instead, so no reaction was offered (`03` rule 2). */
const confirmOnButtons = (): ChoiceFallback =>
  renderChoiceFallback(
    [[button('Approve', { emojiFallback: 'check' }), button('Reject', { emojiFallback: 'cross' })]],
    profiles.telegram,
    { reactions: reactionsFor('telegram') },
  );

/** `n` numbered options with no declared keys. */
const numbered = (count: number): ChoiceFallback =>
  renderChoiceFallback(
    [Array.from({ length: count }, (_, index) => button(`Option ${String(index + 1)}`))],
    profiles.matrix,
  );

const typed = (text: string, isReplyToPrompt = false): ChoiceInput => ({
  kind: 'text',
  text,
  isReplyToPrompt,
});
const reacted = (emoji: string, onPromptMessage = true): ChoiceInput => ({
  kind: 'reaction',
  emoji,
  onPromptMessage,
});

/** The matched option's label, or the outcome name — so a failure says *what* happened. */
const labelOf = (reply: ReturnType<typeof parseChoiceReply>): string =>
  reply.outcome === 'matched' ? reply.choice.label : reply.outcome;

describe('03 §3.3.12 rule 2: a confirmation has no next-message rule', () => {
  it('ignores a bare "yes" that is not a reply to the confirmation', () => {
    const fallback = confirmPair();
    for (const text of ['yes', 'ok', 'sure', 'no', '1', '2']) {
      expect(parseChoiceReply(typed(text), { fallback, confirmation: true }).outcome, text).toBe(
        'none',
      );
    }
  });

  it('accepts the same words as a platform reply to it', () => {
    const fallback = confirmPair();
    expect(labelOf(parseChoiceReply(typed('yes', true), { fallback, confirmation: true }))).toBe(
      'Approve',
    );
    expect(labelOf(parseChoiceReply(typed('no', true), { fallback, confirmation: true }))).toBe(
      'Reject',
    );
  });

  it('still accepts a bare "yes" for an ordinary choice, which is what 06 §3.7 allows', () => {
    // Ingestion has already decided this message is a candidate — a reply, or the next message
    // from the allowed clicker inside ten minutes. The difference is entirely the `confirmation`
    // flag, which is the whole of the rule.
    const fallback = confirmPair();
    expect(labelOf(parseChoiceReply(typed('yes'), { fallback, confirmation: false }))).toBe(
      'Approve',
    );
  });

  it('gates a reaction on the message itself in both modes', () => {
    const fallback = confirmPair();
    for (const confirmation of [true, false]) {
      expect(
        parseChoiceReply(reacted(UNICODE_REACTIONS.check, false), { fallback, confirmation })
          .outcome,
        String(confirmation),
      ).toBe('none');
      expect(
        labelOf(parseChoiceReply(reacted(UNICODE_REACTIONS.check), { fallback, confirmation })),
        String(confirmation),
      ).toBe('Approve');
    }
  });
});

describe('digits', () => {
  it('select by position, one-based', () => {
    const fallback = numbered(5);
    for (const [at, text] of ['1', '2', '3', '4', '5'].entries()) {
      expect(labelOf(parseChoiceReply(typed(text), { fallback, confirmation: false }))).toBe(
        `Option ${String(at + 1)}`,
      );
    }
  });

  it('survive the punctuation and whitespace a member actually types', () => {
    const fallback = numbered(5);
    for (const text of [' 1 ', '1.', '1!', '"1"', '(1)', '1,', '#1', '\n1\n']) {
      expect(
        labelOf(parseChoiceReply(typed(text), { fallback, confirmation: false })),
        JSON.stringify(text),
      ).toBe('Option 1');
    }
  });

  it('accept a typed keycap, which is what a phone keyboard produces', () => {
    const fallback = numbered(5);
    const keycap = `2${VARIATION_SELECTOR_16}${String.fromCharCode(0x20e3)}`;
    expect(labelOf(parseChoiceReply(typed(keycap), { fallback, confirmation: false }))).toBe(
      'Option 2',
    );
  });

  it('tolerate a list marker in front of the digit', () => {
    // "- 1" and "1)" are how people answer a numbered list, and the edge trim handles both. The
    // dash is `\p{Pd}`, so "-1" lands here too; in a five-option poll that is the answer the
    // member meant and not a negative number.
    const fallback = numbered(5);
    for (const text of ['- 1', '-1', '1)', '* 1', '\u2022 1']) {
      expect(
        labelOf(parseChoiceReply(typed(text), { fallback, confirmation: false })),
        JSON.stringify(text),
      ).toBe('Option 1');
    }
  });

  it('ignore a number outside the range', () => {
    const fallback = numbered(5);
    for (const text of ['0', '6', '12', '99']) {
      expect(parseChoiceReply(typed(text), { fallback, confirmation: false }).outcome, text).toBe(
        'none',
      );
    }
  });

  it('answer a four-option confirmation that yes/no cannot', () => {
    // `03` §3.3.12's options include `approve_always` and `edit`. A lexicon of two words cannot
    // name four options, which is why `03` rule 2 is amended in this commit to admit digits.
    const fallback = renderChoiceFallback(
      [
        [
          button('Approve', { emojiFallback: 'check' }),
          button('Reject', { emojiFallback: 'cross' }),
          button('Always approve'),
          button('Edit'),
        ],
      ],
      profiles.signal,
    );
    expect(labelOf(parseChoiceReply(typed('3', true), { fallback, confirmation: true }))).toBe(
      'Always approve',
    );
    expect(labelOf(parseChoiceReply(typed('4', true), { fallback, confirmation: true }))).toBe(
      'Edit',
    );
  });
});

describe('the yes/no lexicon', () => {
  it('maps 06 §3.7’s and 03 rule 2’s words to the declared keys', () => {
    const fallback = confirmPair();
    for (const text of EN_CHOICE_LEXICON.yes) {
      expect(labelOf(parseChoiceReply(typed(text), { fallback, confirmation: false })), text).toBe(
        'Approve',
      );
    }
    for (const text of EN_CHOICE_LEXICON.no) {
      expect(labelOf(parseChoiceReply(typed(text), { fallback, confirmation: false })), text).toBe(
        'Reject',
      );
    }
  });

  it('is exactly the union of the two specs, with nothing invented', () => {
    // `03` §3.3.12 rule 2: `yes|yep|ok|sure` / `no|nope|cancel`. `06` §3.7 adds `y` and `n`.
    // Widening English from here would be guessing at answer words with no speaker in the loop.
    expect([...EN_CHOICE_LEXICON.yes]).toEqual(['yes', 'yep', 'y', 'ok', 'sure']);
    expect([...EN_CHOICE_LEXICON.no]).toEqual(['no', 'nope', 'n', 'cancel']);
  });

  it('is case-insensitive', () => {
    const fallback = confirmPair();
    for (const text of ['YES', 'Yes', 'yEs']) {
      expect(labelOf(parseChoiceReply(typed(text), { fallback, confirmation: false })), text).toBe(
        'Approve',
      );
    }
  });

  it('is replaced, not extended, by a locale lexicon', () => {
    // `06` §3.7: "locale-extended by 05 copy". A German group's `ja` must work, and an English
    // `yes` must not quietly keep working in a locale that did not list it — a word can mean the
    // opposite in another language.
    const de: ChoiceLexicon = { yes: ['ja'], no: ['nein'], connectors: ['oder'] };
    const fallback = confirmPair();
    expect(
      labelOf(parseChoiceReply(typed('ja'), { fallback, confirmation: false, lexicon: de })),
    ).toBe('Approve');
    expect(
      parseChoiceReply(typed('yes'), { fallback, confirmation: false, lexicon: de }).outcome,
    ).toBe('none');
    expect(
      parseChoiceReply(typed('ja oder nein'), { fallback, confirmation: false, lexicon: de })
        .outcome,
    ).toBe('ambiguous');
  });

  it('finds nothing when no option declared a yes or no key', () => {
    const fallback = numbered(5);
    expect(parseChoiceReply(typed('yes'), { fallback, confirmation: false }).outcome).toBe('none');
  });
});

describe('emoji typed as text', () => {
  it('reads 06 §3.7’s four characters', () => {
    const fallback = confirmPair();
    for (const text of [UNICODE_REACTIONS.check, UNICODE_REACTIONS.ack]) {
      expect(labelOf(parseChoiceReply(typed(text), { fallback, confirmation: false })), text).toBe(
        'Approve',
      );
    }
    for (const text of [UNICODE_REACTIONS.cross, UNICODE_REACTIONS.no]) {
      expect(labelOf(parseChoiceReply(typed(text), { fallback, confirmation: false })), text).toBe(
        'Reject',
      );
    }
  });

  it('reads Telegram’s 👌, because that is what `done` is there', () => {
    const fallback = confirmPair();
    expect(
      labelOf(
        parseChoiceReply(typed(String.fromCodePoint(0x1f44c)), {
          fallback,
          confirmation: false,
        }),
      ),
    ).toBe('Approve');
  });

  it('survives the variation selector either way round', () => {
    const fallback = confirmPair();
    const plain = String.fromCodePoint(0x1f44d);
    for (const text of [plain, `${plain}${VARIATION_SELECTOR_16}`]) {
      expect(
        labelOf(parseChoiceReply(typed(text), { fallback, confirmation: false })),
        JSON.stringify(text),
      ).toBe('Approve');
    }
  });
});

describe('reactions', () => {
  it('match the emoji that was offered', () => {
    const fallback = numbered(3);
    expect(fallback.kind).toBe('reactions');
    expect(
      labelOf(parseChoiceReply(reacted(UNICODE_REACTIONS.two), { fallback, confirmation: false })),
    ).toBe('Option 2');
  });

  it('match an unqualified emoji against a qualified offer', () => {
    // The reason `normaliseInboundEmoji` exists: Village offers ❤️ and the client sends ❤.
    const fallback = renderChoiceFallback(
      [[button('Love it', { emojiFallback: 'heart' }), button('No', { emojiFallback: 'cross' })]],
      profiles.signal,
    );
    expect(fallback.reactions[0]).toBe(`${String.fromCodePoint(0x2764)}${VARIATION_SELECTOR_16}`);
    expect(
      labelOf(
        parseChoiceReply(reacted(String.fromCodePoint(0x2764)), {
          fallback,
          confirmation: false,
        }),
      ),
    ).toBe('Love it');
  });

  it('answer a confirmation that was delivered as buttons (03 rule 2)', () => {
    // Telegram showed an inline keyboard, so no reaction was offered — `reaction` is `null` on
    // every choice. Rule 2 still lets a member react 👍 to the confirmation message, and the
    // declared `key` is what says which button that means.
    const fallback = confirmOnButtons();
    expect(fallback.kind).toBe('text');
    expect(fallback.choices.every((choice) => choice.reaction === null)).toBe(true);
    expect(
      labelOf(
        parseChoiceReply(reacted(String.fromCodePoint(0x1f44d)), {
          fallback,
          confirmation: true,
        }),
      ),
    ).toBe('Approve');
    expect(
      labelOf(
        parseChoiceReply(reacted(String.fromCodePoint(0x1f44e)), {
          fallback,
          confirmation: true,
        }),
      ),
    ).toBe('Reject');
  });

  it('ignore anything else, silently (03 rule 2: "anything else is ignored")', () => {
    const fallback = confirmPair();
    for (const emoji of [
      UNICODE_REACTIONS.heart,
      UNICODE_REACTIONS.celebrate,
      UNICODE_REACTIONS.thinking,
      'not an emoji',
      '',
    ]) {
      expect(
        parseChoiceReply(reacted(emoji), { fallback, confirmation: true }).outcome,
        JSON.stringify(emoji),
      ).toBe('none');
    }
  });

  it('never nudge, because most reactions on a message are not answers', () => {
    const fallback = confirmPair();
    expect(
      parseChoiceReply(reacted(UNICODE_REACTIONS.thinking), { fallback, confirmation: true })
        .outcome,
    ).not.toBe('ambiguous');
  });
});

describe('ambiguous versus none', () => {
  it('reads a reply that names two options as ambiguous', () => {
    const fallback = confirmPair();
    for (const text of ['yes or no', 'yes/no', 'yes, no', 'no or yes', 'yes and no']) {
      expect(parseChoiceReply(typed(text), { fallback, confirmation: false }).outcome, text).toBe(
        'ambiguous',
      );
    }
  });

  it('reads two digits as ambiguous', () => {
    const fallback = numbered(5);
    expect(parseChoiceReply(typed('1 or 2'), { fallback, confirmation: false }).outcome).toBe(
      'ambiguous',
    );
    expect(parseChoiceReply(typed('3, 4'), { fallback, confirmation: false }).outcome).toBe(
      'ambiguous',
    );
  });

  it('reads a word that names two options as ambiguous', () => {
    // Two buttons both declaring an affirmative key. "yes" cannot choose between them, and
    // guessing would approve whichever the producer happened to list first.
    const fallback = renderChoiceFallback(
      [[button('Approve', { emojiFallback: 'check' }), button('Noted', { emojiFallback: 'ack' })]],
      profiles.signal,
    );
    expect(fallback.kind).toBe('reactions');
    expect(parseChoiceReply(typed('yes'), { fallback, confirmation: false }).outcome).toBe(
      'ambiguous',
    );
  });

  it('nudges an unreadable reply to the prompt, and stays silent otherwise', () => {
    const fallback = confirmPair();
    for (const text of ['maybe', 'yes please', "I don't think yes is right", 'what?', '']) {
      expect(
        parseChoiceReply(typed(text, true), { fallback, confirmation: false }).outcome,
        `reply/${text}`,
      ).toBe('ambiguous');
      expect(
        parseChoiceReply(typed(text, false), { fallback, confirmation: false }).outcome,
        `loose/${text}`,
      ).toBe('none');
    }
  });

  it('never reads a yes-word out of a sentence', () => {
    // The conservative edge, deliberately: scanning for the first yes-word reads "I don't think
    // yes is right" as an approval. A reply this module cannot read in full is one it will not act
    // on, and `05` sends the nudge instead.
    const fallback = confirmPair();
    const reply = parseChoiceReply(typed("I don't think yes is right", true), {
      fallback,
      confirmation: false,
    });
    expect(reply.outcome).not.toBe('matched');
  });
});

describe('producer markers', () => {
  it('match the word and the digit both', () => {
    const fallback = renderChoiceFallback(
      [
        [
          button('Approve', { textFallback: 'yes', emojiFallback: 'check' }),
          button('Reject', { textFallback: 'no', emojiFallback: 'cross' }),
          button('Always', { textFallback: 'always' }),
          button('Edit', { textFallback: 'edit' }),
          button('Later', { textFallback: 'later' }),
        ],
      ],
      profiles.matrix,
    );
    expect(fallback.kind).toBe('text');
    expect(labelOf(parseChoiceReply(typed('always'), { fallback, confirmation: false }))).toBe(
      'Always',
    );
    expect(labelOf(parseChoiceReply(typed('ALWAYS.'), { fallback, confirmation: false }))).toBe(
      'Always',
    );
    expect(labelOf(parseChoiceReply(typed('3'), { fallback, confirmation: false }))).toBe('Always');
  });
});

describe('an empty offer', () => {
  it('matches nothing, whatever arrives', () => {
    const fallback = renderChoiceFallback([], profiles.signal);
    for (const input of [typed('yes', true), reacted(UNICODE_REACTIONS.check)]) {
      expect(parseChoiceReply(input, { fallback, confirmation: true }).outcome).toBe('none');
    }
  });
});
