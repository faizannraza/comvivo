/**
 * C07, the splitting property (`06` §9; `M3-T5`'s AC: 1 000 runs for Telegram/plain/web).
 *
 * `06` §9's C07 names three things, and they are the three that matter because they are the three
 * ways a split reply reaches a member wrong:
 *
 *  1. **every part fits the limit** — a part that does not is a send the platform refuses;
 *  2. **markup is well-formed** — Telegram answers `400 can't parse entities` and sends nothing,
 *     so a part with an unbalanced tag is silence from an assistant that was working a minute ago;
 *  3. **the concatenated plain text is preserved** — the property a cased test cannot give you.
 *     A splitter that dropped a sentence, duplicated a list item or lost the last grapheme of a
 *     paragraph would pass every example somebody thought to write down.
 *
 * The third is the reason this is a property suite rather than a longer `split.test.ts`. "The text
 * survives" is a statement about all documents, and the generator below is written to produce the
 * documents a model actually emits — nested lists, fenced blocks, mentions, long paragraphs — at
 * sizes that straddle each profile's limit.
 *
 * ## Why the comparison is normalised
 *
 * Splitting is not a pure partition of the rendered string, in three ways the specification is
 * explicit about. A part boundary **absorbs the whitespace** around it, which is what makes the
 * next part start with a word rather than a space. A `br` is **consumed** as the break. And a hard
 * cut lands at a grapheme boundary, which §3.5.4 allows to fall **inside a word** when nothing
 * else fits — so the parts do not even rejoin with a separator.
 *
 * ## Why these are tagged `slow`
 *
 * Nine properties at 1 000 runs, each run rendering a document several times — `11` §3.1.3's
 * `slow` tag and its 30 s timeout. In isolation the suite takes about three seconds; under a full
 * `pnpm verify` the unit tier's 5 s default was exceeded and the run failed as a **timeout**, which
 * reads in a log exactly like a counterexample and is not one. The tag is the mechanism `11`
 * §3.1.3 provides for this rather than a per-test override, so one decision covers the file.
 *
 * So the property is stated over the **non-whitespace characters**: every one of them survives, in
 * order, exactly once. That catches a dropped sentence, a duplicated list item and a lost final
 * grapheme, which are the failures that matter; it deliberately says nothing about where the
 * spaces went, because the specification deliberately does not promise that. The first version
 * joined the parts with a space and compared collapsed whitespace, and it failed on a hard cut
 * mid-word — correctly, because that version was asserting something untrue.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import { BRAND, type MemberId } from '@comvivo/shared';
import { fcConfig } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ChannelCapabilities, RenderContext } from '../contract.js';
import { profiles } from '../profiles.js';
import { visibleText } from './render/measure.js';
import { validateTelegramHtml } from './render/telegram-validator.js';
import { splitAndRender, splitBlocks } from './split.js';

const ANA = 'mbr_01jd0000000000000000000000' as MemberId;

const CONTEXT: RenderContext = {
  mentions: {
    [ANA]: { displayName: 'Ana', username: 'ana_g', platformUserId: '42', canPing: true },
  },
  self: { platformUserId: '1', displayName: BRAND.displayName, flags: {} },
  linkPreview: false,
  locale: 'en',
};

const NOTICE = '(trimmed)';

/**
 * Text a model writes: words, sentences, and the characters that make cutting hard.
 *
 * The emoji and the family sequence are not decoration. A family emoji is five code points and
 * one grapheme cluster, so a cut between its code points produces two broken glyphs — which is
 * what §3.5.4's grapheme requirement exists to prevent and what a generator of plain ASCII would
 * never find.
 */
const words = fc.constantFrom(
  'the',
  'recital',
  'is',
  'on',
  'Thursday.',
  'Bring shoes!',
  'Really?',
  'そうです。',
  'مرحبا',
  '🙂',
  '👨‍👩‍👧‍👦',
  'é',
  'a-very-long-unbroken-token-that-cannot-be-split-at-whitespace',
);

const sentence = fc.array(words, { minLength: 1, maxLength: 40 }).map((parts) => parts.join(' '));

const marks = fc.subarray(['b', 'i', 's', 'spoiler'] as const, { maxLength: 2 });

const textInline: fc.Arbitrary<Inline> = fc
  .tuple(sentence, marks)
  .map(([text, applied]) =>
    applied.length === 0 ? { t: 'text', text } : { t: 'text', text, marks: [...applied] },
  );

const atomicInline: fc.Arbitrary<Inline> = fc.oneof(
  fc.constant<Inline>({ t: 'br' }),
  sentence.map<Inline>((text) => ({ t: 'code', text })),
  fc
    .tuple(sentence, fc.constantFrom('https://example.com/a', 'https://example.com/a-long-path'))
    .map<Inline>(([label, url]) => ({ t: 'link', url, c: [{ t: 'text', text: label }] })),
  fc.constant<Inline>({
    t: 'mention',
    target: { kind: 'member', memberId: ANA },
    fallback: '@Ana',
  }),
  fc.constant<Inline>({ t: 'time', at: '2026-11-15T18:00:00Z', fallback: 'Sat 18:00' }),
);

const inlines = fc.array(
  fc.oneof({ weight: 3, arbitrary: textInline }, { weight: 1, arbitrary: atomicInline }),
  {
    minLength: 1,
    maxLength: 12,
  },
);

const leafBlock: fc.Arbitrary<Block> = fc.oneof(
  inlines.map<Block>((c) => ({ t: 'p', c })),
  fc
    .tuple(fc.constantFrom(1, 2, 3) as fc.Arbitrary<1 | 2 | 3>, inlines)
    .map<Block>(([level, c]) => ({
      t: 'h',
      level,
      c,
    })),
  fc
    .tuple(
      fc.option(fc.constantFrom('js', 'ts', 'sh'), { nil: undefined }),
      fc.array(sentence, { maxLength: 12 }),
    )
    .map<Block>(([lang, lines]) => ({
      t: 'code',
      ...(lang === undefined ? {} : { lang }),
      text: lines.join('\n'),
    })),
  fc.constant<Block>({ t: 'hr' }),
);

/** A list or a quote of leaves, which is as deep as `06` §3.5.1 allows plus the leaf level. */
const containerBlock: fc.Arbitrary<Block> = fc.oneof(
  fc
    .tuple(
      fc.boolean(),
      fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
      fc.array(fc.array(leafBlock, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 6 }),
    )
    .map<Block>(([ordered, start, items]) => ({
      t: 'list',
      ordered,
      ...(start === undefined ? {} : { start }),
      items,
    })),
  fc.array(leafBlock, { minLength: 1, maxLength: 4 }).map<Block>((c) => ({ t: 'quote', c })),
);

const document: fc.Arbitrary<RichText> = fc
  .array(fc.oneof({ weight: 2, arbitrary: leafBlock }, { weight: 1, arbitrary: containerBlock }), {
    minLength: 1,
    maxLength: 10,
  })
  .map((blocks) => ({ v: 1, blocks }));

/**
 * The same shapes, with every **atomic** node short enough to fit.
 *
 * For the text-preservation property only, and the reason is §3.5.4's own rule: "an atomic node
 * longer than the limit degrades to text". A degradation **changes the text** — a too-long link
 * becomes its label, so its URL is gone — and that is correct behaviour rather than loss, because
 * a link longer than a whole message would otherwise be cut into a broken clickable URL. A
 * property that said "every character survives" while generating documents that trigger the
 * degradation would be asserting something the specification contradicts.
 *
 * So the degradation gets its own cased tests in `split.test.ts`, and the property is stated over
 * documents where it does not fire. The fitting and well-formedness properties above use the full
 * generator, because neither is affected by it.
 */
const shortAtomic: fc.Arbitrary<Inline> = fc.oneof(
  fc.constant<Inline>({ t: 'br' }),
  fc.constantFrom<Inline>({ t: 'code', text: 'x = 1' }, { t: 'code', text: 'ls -la' }),
  fc.constant<Inline>({ t: 'link', url: 'https://e.co/a', c: [{ t: 'text', text: 'here' }] }),
  fc.constant<Inline>({
    t: 'mention',
    target: { kind: 'member', memberId: ANA },
    fallback: '@Ana',
  }),
  fc.constant<Inline>({ t: 'time', at: '2026-11-15T18:00:00Z', fallback: 'Sat' }),
);

const safeInlines = fc.array(
  fc.oneof({ weight: 3, arbitrary: textInline }, { weight: 1, arbitrary: shortAtomic }),
  { minLength: 1, maxLength: 12 },
);

const safeLeaf: fc.Arbitrary<Block> = fc.oneof(
  safeInlines.map<Block>((c) => ({ t: 'p', c })),
  fc
    .tuple(fc.constantFrom(1, 2, 3) as fc.Arbitrary<1 | 2 | 3>, safeInlines)
    .map<Block>(([level, c]) => ({ t: 'h', level, c })),
  fc
    .tuple(
      fc.option(fc.constantFrom('js', 'ts', 'sh'), { nil: undefined }),
      fc.array(sentence, { maxLength: 12 }),
    )
    .map<Block>(([lang, lines]) => ({
      t: 'code',
      ...(lang === undefined ? {} : { lang }),
      text: lines.join('\n'),
    })),
  fc.constant<Block>({ t: 'hr' }),
);

const safeContainer: fc.Arbitrary<Block> = fc.oneof(
  fc
    .tuple(
      fc.boolean(),
      fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
      fc.array(fc.array(safeLeaf, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 6 }),
    )
    .map<Block>(([ordered, start, items]) => ({
      t: 'list',
      ordered,
      ...(start === undefined ? {} : { start }),
      items,
    })),
  fc.array(safeLeaf, { minLength: 1, maxLength: 4 }).map<Block>((c) => ({ t: 'quote', c })),
);

const safeDocument: fc.Arbitrary<RichText> = fc
  .array(fc.oneof({ weight: 2, arbitrary: safeLeaf }, { weight: 1, arbitrary: safeContainer }), {
    minLength: 1,
    maxLength: 10,
  })
  .map((blocks) => ({ v: 1, blocks }));

/** The non-whitespace characters of `text`, in order. See the module header. */
function normalise(text: string): string {
  return text.replaceAll(/\s+/g, '');
}

/**
 * The smallest limit the fitting property is stated for.
 *
 * A grapheme cluster cannot be split without breaking it, so a limit below the size of the largest
 * cluster in the corpus is a limit no splitter can meet: `👨‍👩‍👧‍👦` is one cluster and **25 UTF-8
 * bytes**, which is over Signal's unit at a limit of 24. §3.5.4 requires the cut to land on a
 * grapheme boundary, so the only three options are to emit an over-long part, to drop the
 * character, or to produce mojibake — and the splitter emits it, which is the one of the three a
 * member can still read. The floor keeps the property a clean statement, and
 * `split.test.ts` pins the behaviour below it on purpose rather than by omission.
 */
const LIMIT_FLOOR = 40;

/** The three profiles `M3-T5`'s AC names. */
const PROFILES: readonly (readonly [string, ChannelCapabilities])[] = [
  ['telegram', profiles.telegram],
  ['signal (plain)', profiles.signal],
  ['web', profiles.web],
];

/**
 * A limit small enough that the generator's documents straddle it.
 *
 * The real profiles are 2 000–16 000 characters and the generator makes documents of a few
 * hundred, so against the real numbers almost nothing would split and the property would be
 * asserting that a one-part message survives. A tightened limit is what makes the suite exercise
 * the thing it is named after — and because the limit is a capability, tightening it is the same
 * code path a platform with a small limit takes.
 */
function tightened(
  capabilities: ChannelCapabilities,
  maxMessageChars: number,
): ChannelCapabilities {
  return { ...capabilities, maxMessageChars };
}

describe('C07: every part fits its limit (06 §9)', { tags: ['prop', 'slow'] }, () => {
  for (const [name, profile] of PROFILES) {
    it(`holds for ${name}`, () => {
      fc.assert(
        fc.property(document, fc.integer({ min: LIMIT_FLOOR, max: 400 }), (value, limit) => {
          const capabilities = tightened(profile, limit);
          const parts = splitAndRender(value, {
            context: CONTEXT,
            capabilities,
            truncationNotice: NOTICE,
            // A high cap, so this property is about fitting rather than about truncation — which
            // the next block covers on its own.
            maxParts: 1000,
          });
          for (const part of parts) {
            expect(
              part.measured,
              `${name} @${String(limit)}: ${part.plainText.slice(0, 60)}`,
            ).toBeLessThanOrEqual(limit);
          }
        }),
        fcConfig({ numRuns: 1000 }),
      );
    });
  }
});

describe('C07: markup is well-formed in every part (06 §9)', { tags: ['prop', 'slow'] }, () => {
  it('holds for Telegram HTML', () => {
    // The property with teeth: Telegram rejects the whole message, so one unbalanced tag in one
    // part of a six-part reply is six messages the group never sees.
    fc.assert(
      fc.property(document, fc.integer({ min: LIMIT_FLOOR, max: 400 }), (value, limit) => {
        const parts = splitAndRender(value, {
          context: CONTEXT,
          capabilities: tightened(profiles.telegram, limit),
          truncationNotice: NOTICE,
          maxParts: 1000,
        });
        for (const part of parts) {
          expect(validateTelegramHtml(String(part.payload)), String(part.payload)).toEqual([]);
        }
      }),
      fcConfig({ numRuns: 1000 }),
    );
  });
});

describe('C07: the concatenated text is preserved (06 §9)', { tags: ['prop', 'slow'] }, () => {
  for (const [name, profile] of PROFILES) {
    it(`holds for ${name}`, () => {
      // Over the **AST slices**, not the rendered parts. Each part re-adds its own quote prefix
      // and list bullet, so a six-part render legitimately holds five extra `>` characters that
      // the one-part render does not — the first version of this compared rendered text and
      // failed on a quote, correctly, because it was asserting something untrue. `visibleText`
      // over the slices is the exact statement: every non-whitespace character of the document
      // survives, in order, exactly once.
      fc.assert(
        fc.property(safeDocument, fc.integer({ min: LIMIT_FLOOR, max: 400 }), (value, limit) => {
          const slices = splitBlocks(value, {
            context: CONTEXT,
            capabilities: tightened(profile, limit),
            truncationNotice: NOTICE,
            maxParts: 1000,
          });
          const rejoined: RichText = { v: 1, blocks: slices.flatMap((slice) => [...slice]) };
          expect(normalise(visibleText(rejoined)), `${name} @${String(limit)}`).toBe(
            normalise(visibleText(value)),
          );
        }),
        fcConfig({ numRuns: 1000 }),
      );
    });
  }
});

describe('the splitter terminates and stays within its part budget', {
  tags: ['prop', 'slow'],
}, () => {
  it('never returns more parts than `maxParts`, whatever the limit', () => {
    fc.assert(
      fc.property(
        document,
        fc.integer({ min: LIMIT_FLOOR, max: 200 }),
        fc.integer({ min: 1, max: 8 }),
        (value, limit, maxParts) => {
          const parts = splitAndRender(value, {
            context: CONTEXT,
            capabilities: tightened(profiles.telegram, limit),
            truncationNotice: NOTICE,
            maxParts,
          });
          expect(parts.length).toBeLessThanOrEqual(maxParts);
          // And never zero for a non-empty document: a reply that vanishes is worse than a
          // truncated one, and the truncation path is the one that could have produced it.
          expect(parts.length).toBeGreaterThan(0);
        },
      ),
      fcConfig({ numRuns: 1000 }),
    );
  });

  it('answers even when the limit is smaller than a single grapheme cluster', () => {
    // A misconfigured profile. The guard being tested is the loop's progress check: without it
    // this hangs, and a hang on the outbound path takes the worker with it.
    const value: RichText = {
      v: 1,
      blocks: [{ t: 'p', c: [{ t: 'text', text: '👨‍👩‍👧‍👦'.repeat(20) }] }],
    };
    const parts = splitAndRender(value, {
      context: CONTEXT,
      capabilities: tightened(profiles.telegram, 1),
      truncationNotice: NOTICE,
      maxParts: 4,
    });
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.length).toBeLessThanOrEqual(4);
  });
});
