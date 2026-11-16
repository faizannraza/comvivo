/**
 * The choice fallback (`06` §3.7 "Fallback when `buttons: false`"; `M3-T6`).
 *
 * On Matrix and Signal this is the only way to ask a question. So the tests are organised around
 * the decision — reactions or text — because every way of getting it wrong is a question a family
 * cannot answer:
 *
 * - **Reactions where they do not work.** Telegram allows a bot one reaction per message, so
 *   offering four is four API calls and one surviving emoji. `06` §3.7 did not state this check;
 *   it is added to the spec in this commit, and `reactions-per-message` below is why.
 * - **Reactions a platform has no emoji for.** Telegram's keycaps.
 * - **Two options wearing the same emoji**, which a member cannot tell apart.
 * - **Text where reactions would have done**, which costs a member a typed reply for nothing.
 *
 * The last block walks every profile at every option count and asserts the shape is answerable,
 * because the function is total by design: on a `buttons: false` platform the alternative to a
 * usable fallback is a prompt with no way to respond.
 */
import { describe, expect, it } from 'vitest';
import type { ActionButton, ActionRow, ChannelCapabilities } from '../contract.js';
import { PROFILE_NAMES, profiles } from '../index.js';
import {
  type ReactionKey,
  reactionsFor,
  TELEGRAM_REACTIONS,
  UNICODE_REACTIONS,
} from '../reactions.js';
import { renderChoiceFallback } from './fallback.js';
import { mintInteractionToken } from './token.js';

const button = (label: string, extra: Partial<ActionButton> = {}): ActionButton => ({
  label,
  style: 'secondary',
  token: mintInteractionToken(),
  ...extra,
});

const options = (count: number): readonly ActionRow[] => [
  Array.from({ length: count }, (_, index) => button(`Option ${String(index + 1)}`)),
];

const caps = (over: Partial<ChannelCapabilities> = {}): ChannelCapabilities => ({
  ...profiles.signal,
  ...over,
});

const confirmRow: readonly ActionRow[] = [
  [button('Approve', { emojiFallback: 'check' }), button('Reject', { emojiFallback: 'cross' })],
];

describe('reaction choices', () => {
  it('uses 06 §3.7’s ✅ ❌ for a confirm pair on a platform with an open reaction set', () => {
    const fallback = renderChoiceFallback(confirmRow, profiles.signal);
    expect(fallback.kind).toBe('reactions');
    expect(fallback.reactions).toEqual([UNICODE_REACTIONS.check, UNICODE_REACTIONS.cross]);
    expect(fallback.choices.map((choice) => choice.key)).toEqual(['check', 'cross']);
  });

  it('uses 👍 👎 where the platform’s reaction set lacks them (06 §3.7)', () => {
    // The substitution is a property of the key and the platform, which is why `emojiFallback`
    // carries a key. A literal '✅' in the producer would have thrown the map away.
    const fallback = renderChoiceFallback(confirmRow, caps({ maxReactionsPerMessage: null }), {
      reactions: reactionsFor('telegram'),
    });
    expect(fallback.kind).toBe('reactions');
    expect(fallback.reactions).toEqual([TELEGRAM_REACTIONS.check, TELEGRAM_REACTIONS.cross]);
  });

  it('numbers up to four options with keycaps', () => {
    const fallback = renderChoiceFallback(options(4), profiles.matrix);
    expect(fallback.kind).toBe('reactions');
    expect(fallback.reactions).toEqual([
      UNICODE_REACTIONS.one,
      UNICODE_REACTIONS.two,
      UNICODE_REACTIONS.three,
      UNICODE_REACTIONS.four,
    ]);
  });

  it('falls to text at five options, because the keycap keys run out', () => {
    expect(renderChoiceFallback(options(5), profiles.matrix).kind).toBe('text');
    expect(renderChoiceFallback(options(4), profiles.matrix).kind).toBe('reactions');
  });

  it('flattens rows in reading order', () => {
    const rows: readonly ActionRow[] = [[button('A'), button('B')], [button('C')]];
    const fallback = renderChoiceFallback(rows, profiles.matrix);
    expect(fallback.choices.map((choice) => choice.label)).toEqual(['A', 'B', 'C']);
    expect(fallback.choices.map((choice) => choice.index)).toEqual([0, 1, 2]);
  });

  it('carries each option’s token through unchanged', () => {
    const fallback = renderChoiceFallback(confirmRow, profiles.signal);
    expect(fallback.choices.map((choice) => choice.token)).toEqual(
      confirmRow.flat().map((entry) => entry.token),
    );
  });
});

describe('why reaction choices are declined', () => {
  it('no reactions on the platform at all', () => {
    expect(renderChoiceFallback(confirmRow, caps({ reactions: false })).kind).toBe('text');
  });

  it('reactions-per-message: one bot reaction cannot carry two options', () => {
    // `06` §3.9: "Telegram allows bots **one** reaction per message." Without this check the
    // fallback would offer two and the adapter would send two calls, the second replacing the
    // first — a question showing one emoji and accepting two answers.
    expect(profiles.telegram.maxReactionsPerMessage).toBe(1);
    expect(
      renderChoiceFallback(confirmRow, caps({ maxReactionsPerMessage: 1 }), {
        reactions: reactionsFor('telegram'),
      }).kind,
    ).toBe('text');
    // One option still fits in a one-reaction budget.
    expect(
      renderChoiceFallback(
        [[button('OK', { emojiFallback: 'check' })]],
        caps({ maxReactionsPerMessage: 1 }),
        {
          reactions: reactionsFor('telegram'),
        },
      ).kind,
    ).toBe('reactions');
  });

  it('a key the platform has no emoji for', () => {
    // Telegram's keycaps are `null`, so a numbered choice degrades without this module knowing
    // which platform it is looking at.
    expect(
      renderChoiceFallback(options(3), caps({ maxReactionsPerMessage: null }), {
        reactions: reactionsFor('telegram'),
      }).kind,
    ).toBe('text');
  });

  it('two options wearing the same emoji', () => {
    // `done` and `check` are both ✅ off Telegram. A member looking at one ✅ cannot pick either.
    const ambiguous: readonly ActionRow[] = [
      [
        button('Mark done', { emojiFallback: 'done' }),
        button('Approve', { emojiFallback: 'check' }),
      ],
    ];
    expect(UNICODE_REACTIONS.done).toBe(UNICODE_REACTIONS.check);
    expect(renderChoiceFallback(ambiguous, profiles.signal).kind).toBe('text');
  });

  it('no options at all', () => {
    expect(renderChoiceFallback([], profiles.signal)).toEqual({
      kind: 'text',
      choices: [],
      reactions: [],
    });
    expect(renderChoiceFallback([[]], profiles.signal).choices).toEqual([]);
  });

  it('five options even when every one of them declared a distinct key', () => {
    // Found by a break drill: raising `MAX_REACTION_CHOICES` to eight left every test green,
    // because `POSITIONAL_KEYS` runs out at four and a fifth *undeclared* option falls to text on
    // its own. The cap is only load-bearing when the producer named every key — which `07`'s
    // entity actions do — so that is the case that has to assert it.
    const declared: readonly ReactionKey[] = ['check', 'cross', 'ack', 'celebrate', 'heart'];
    const rows: readonly ActionRow[] = [
      declared.map((key, index) => button(`Option ${String(index + 1)}`, { emojiFallback: key })),
    ];
    expect(
      new Set(rows.flat().map((entry) => UNICODE_REACTIONS[entry.emojiFallback ?? 'one'])).size,
    ).toBe(5);
    expect(renderChoiceFallback(rows, profiles.signal).kind).toBe('text');
    expect(renderChoiceFallback([rows[0]?.slice(0, 4) ?? []], profiles.signal).kind).toBe(
      'reactions',
    );
  });

  it('a caller-widened cap, because the positional keys still run out at four', () => {
    // `maxReactionChoices` is an option, so it can be raised past the four keys that exist. The
    // two bounds are independent and both have to hold: five undeclared options have no fifth
    // keycap whatever the cap says.
    expect(renderChoiceFallback(options(6), profiles.signal, { maxReactionChoices: 6 }).kind).toBe(
      'text',
    );
  });

  it('a caller-tightened cap', () => {
    expect(renderChoiceFallback(options(3), profiles.signal, { maxReactionChoices: 2 }).kind).toBe(
      'text',
    );
  });
});

describe('text markers', () => {
  it('are digits from one', () => {
    const fallback = renderChoiceFallback(options(5), profiles.matrix);
    expect(fallback.kind).toBe('text');
    expect(fallback.choices.map((choice) => choice.marker)).toEqual(['1', '2', '3', '4', '5']);
    expect(fallback.reactions).toEqual([]);
  });

  it('use every producer marker when all of them are set and distinct', () => {
    const rows: readonly ActionRow[] = [
      [
        button('Approve', { textFallback: 'yes' }),
        button('Reject', { textFallback: 'no' }),
        button('Always', { textFallback: 'always' }),
        button('Edit', { textFallback: 'edit' }),
        button('Later', { textFallback: 'later' }),
      ],
    ];
    expect(renderChoiceFallback(rows, profiles.matrix).choices.map((c) => c.marker)).toEqual([
      'yes',
      'no',
      'always',
      'edit',
      'later',
    ]);
  });

  it('fall back to digits when only some buttons carry one', () => {
    // "Reply **yes** for Approve, **2** for Reject" has taught the member two grammars at once.
    const rows: readonly ActionRow[] = [
      [
        button('Approve', { textFallback: 'yes' }),
        button('Reject'),
        button('Edit'),
        button('x'),
        button('y'),
      ],
    ];
    expect(renderChoiceFallback(rows, profiles.matrix).choices.map((c) => c.marker)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });

  it('fall back to digits when two markers collide, including on case', () => {
    const rows: readonly ActionRow[] = [
      [
        button('Approve', { textFallback: 'yes' }),
        button('Also approve', { textFallback: 'YES' }),
        button('Reject', { textFallback: 'no' }),
        button('d', { textFallback: 'd' }),
        button('e', { textFallback: 'e' }),
      ],
    ];
    expect(renderChoiceFallback(rows, profiles.matrix).choices.map((c) => c.marker)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
  });

  it('fall back to digits when one button has no marker and the rest are distinct', () => {
    // Found by a break drill: `every` relaxed to `some` left every test green, because the
    // existing partial-set case had three empty markers and failed the distinctness check
    // instead. With exactly one missing marker the two checks stop overlapping, and `some` would
    // hand the last option an empty string — nothing for the member to type.
    const rows: readonly ActionRow[] = [
      [
        button('a', { textFallback: 'alpha' }),
        button('b', { textFallback: 'bravo' }),
        button('c', { textFallback: 'charlie' }),
        button('d', { textFallback: 'delta' }),
        button('e'),
      ],
    ];
    const fallback = renderChoiceFallback(rows, profiles.matrix);
    expect(fallback.choices.map((choice) => choice.marker)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('fall back to digits when a marker is only whitespace', () => {
    const rows: readonly ActionRow[] = [
      [
        button('a', { textFallback: '  ' }),
        button('b', { textFallback: 'b' }),
        button('c'),
        button('d'),
        button('e'),
      ],
    ];
    expect(renderChoiceFallback(rows, profiles.matrix).choices[0]?.marker).toBe('1');
  });
});

describe('the keys carried on a text choice', () => {
  it('are the producer’s, so a yes/no answer can still find its option', () => {
    // `03` §3.3.12 rule 2 lets a member react ✅ to a confirmation on a platform that showed
    // buttons. The parse table therefore has to know which button means approve even when no
    // reaction was ever offered — which is the `key`, not the label and not the token.
    const fallback = renderChoiceFallback(confirmRow, caps({ reactions: false }));
    expect(fallback.kind).toBe('text');
    expect(fallback.choices.map((choice) => choice.key)).toEqual(['check', 'cross']);
    expect(fallback.choices.map((choice) => choice.reaction)).toEqual([null, null]);
  });

  it('are positional where the producer declared none, and null past the fourth', () => {
    const fallback = renderChoiceFallback(options(6), profiles.matrix);
    expect(fallback.choices.map((choice) => choice.key)).toEqual([
      'one',
      'two',
      'three',
      'four',
      null,
      null,
    ]);
  });
});

describe('it is total: every profile, every option count', () => {
  const keySets: readonly (readonly ReactionKey[])[] = [
    [],
    ['check', 'cross'],
    // Fully declared, so the ≤4 cap rather than the positional key list is what bounds it.
    ['check', 'cross', 'ack', 'celebrate', 'heart', 'thinking', 'seen', 'writing', 'done', 'no'],
  ];

  it('always returns an answerable shape', () => {
    for (const name of PROFILE_NAMES) {
      for (const keys of keySets) {
        for (let count = 0; count <= 10; count += 1) {
          const rows: readonly ActionRow[] = [
            Array.from({ length: count }, (_, index) => {
              const key = keys[index];
              return key === undefined
                ? button(`Option ${String(index + 1)}`)
                : button(`Option ${String(index + 1)}`, { emojiFallback: key });
            }),
          ];
          const where = `${name}/${String(count)}/${keys.join('+')}`;
          const fallback = renderChoiceFallback(rows, profiles[name], {
            reactions: reactionsFor(name === 'ideal' ? 'web' : name),
          });
          expect(fallback.choices, where).toHaveLength(count);
          // Every option is identifiable by its marker, which is what a member types — and every
          // marker is something there is to type. An empty one is an option with no way to pick
          // it, which a distinctness check alone would accept.
          expect(new Set(fallback.choices.map((c) => c.marker.toLowerCase())).size, where).toBe(
            count,
          );
          expect(
            fallback.choices.every((choice) => choice.marker.trim().length > 0),
            where,
          ).toBe(true);
          if (fallback.kind === 'reactions') {
            expect(fallback.reactions, where).toHaveLength(count);
            expect(new Set(fallback.reactions).size, where).toBe(count);
            expect(count, where).toBeLessThanOrEqual(4);
            expect(
              fallback.choices.every((choice) => choice.reaction !== null),
              where,
            ).toBe(true);
          } else {
            expect(fallback.reactions, where).toEqual([]);
          }
        }
      }
    }
  });
});
