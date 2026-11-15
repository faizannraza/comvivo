/**
 * `parse` is total (`06` §3.5.2; `M3-T3`'s AC: "total and throw-free on fuzz").
 *
 * The one property that matters, stated three ways: **whatever the string, there is a reply**.
 * `06` §3.5.2 says "parsing never throws", and the reason it is a property rather than a list of
 * cases is that the input is a language model's prose — the least predictable string in the system,
 * and the one nobody can enumerate.
 *
 * The generators are deliberately hostile in the ways markdown is hostile: unbalanced delimiters,
 * nesting, lone surrogates, control characters and the custom syntax half-written. A plain
 * `fc.string()` finds almost nothing here, because random characters are not markdown — so the
 * grammar-shaped generator below is where the value is.
 */
import { RichTextSchema } from '@comvivo/core';
import type { MemberId } from '@comvivo/shared';
import { fcConfig } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseModelOutput } from './parse.js';

const MBR = 'mbr_01jd0000000000000000000000' as MemberId;

function parse(markdown: string): ReturnType<typeof parseModelOutput> {
  return parseModelOutput(markdown, {
    resolveMember: (id: MemberId) => (id === MBR ? { fallback: '@Ana' } : undefined),
  });
}

/**
 * The tokens markdown is made of, including the broken ones.
 *
 * Each entry is something a model actually emits. The unbalanced forms are the point: a reply cut
 * off by a token limit ends mid-construct, which is the single most common malformed input this
 * parser will ever see in production.
 */
/**
 * The invisible characters, built from their code points.
 *
 * Written as `String.fromCharCode` rather than as literals, because a control character in a
 * source file is invisible in a diff, in most editors and in a review — and these three are
 * exactly the ones a model emits by accident: a stray BEL from a terminal transcript, a NUL
 * from a truncated byte stream, and a zero-width space from a copy-paste.
 */
const BELL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const ZWSP = String.fromCharCode(0x200b);

const TOKENS = [
  '**',
  '*',
  '__',
  '_',
  '~~',
  '~',
  '`',
  '``',
  '```',
  '```js',
  '~~~',
  '||',
  '#',
  '##',
  '######',
  '- ',
  '1. ',
  '> ',
  '---',
  '***',
  '|',
  '|---|',
  '[',
  ']',
  '(',
  ')',
  '![',
  '<',
  '>',
  '<br>',
  '</b>',
  '\\',
  '&amp;',
  '\n',
  '\n\n',
  '  \n',
  '\t',
  ' ',
  'a',
  'word ',
  'https://e.co',
  'www.e.co',
  'a@b.co',
  `@{${MBR}}`,
  '@{mbr_bad}',
  '[l](javascript:x)',
  NUL,
  BELL,
  '\ud800',
  ZWSP,
  '🙂',
  'é',
  'مرحبا',
] as const;

/** Markdown-shaped noise: a sequence of tokens, which is what a truncated reply looks like. */
const markdownish = fc
  .array(fc.constantFrom(...TOKENS), { maxLength: 40 })
  .map((parts) => parts.join(''));

describe('parse is total (06 §3.5.2)', () => {
  it('never throws and always returns a storable document, on markdown-shaped noise', () => {
    fc.assert(
      fc.property(markdownish, (markdown) => {
        const result = parse(markdown);
        // Storable, which is the property that matters: `messages.rich_text` is a validated
        // column, so a document the schema refuses is a reply that never reaches the member —
        // the exact outcome `06` §3.5.2's failure mode exists to prevent.
        expect(RichTextSchema.safeParse(result.richText).success).toBe(true);
      }),
      fcConfig({ numRuns: 1000 }),
    );
  });

  it('never throws on arbitrary unicode, including what is not valid text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 2000 }), (markdown) => {
        const result = parse(markdown);
        expect(RichTextSchema.safeParse(result.richText).success).toBe(true);
      }),
      fcConfig({ numRuns: 1000 }),
    );
  });

  it('never throws on text that is only the custom syntax, half-written', () => {
    // The two constructs this module adds are the two the markdown parser knows nothing about, so
    // they are the two where a bug would be ours rather than micromark's.
    const custom = fc
      .array(fc.constantFrom('||', '|', `@{${MBR}}`, '@{', '}', 'mbr_', 'x', '\n'), {
        maxLength: 30,
      })
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(custom, (markdown) => {
        const result = parse(markdown);
        expect(RichTextSchema.safeParse(result.richText).success).toBe(true);
      }),
      fcConfig({ numRuns: 1000 }),
    );
  });

  it('keeps every text run’s content inside the document it came from', () => {
    // Not an equality — parsing is lossy by design, and `**` disappears — but a *containment*:
    // every word of the input that survives as text must have come from the input. A parser that
    // invented text would be a parser that could put one member's words in another's reply.
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z ]{0,40}$/), (words) => {
        const result = parse(words);
        for (const block of result.richText.blocks) {
          if (block.t !== 'p') continue;
          for (const inline of block.c) {
            if (inline.t !== 'text') continue;
            expect(words).toContain(inline.text.trim());
          }
        }
      }),
      fcConfig({ numRuns: 1000 }),
    );
  });
});
