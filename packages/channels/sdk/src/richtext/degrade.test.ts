/**
 * The substitutions (`06` §3.5.1–§3.5.2; `M3-T3`).
 *
 * `parse.test.ts` checks that the parser reaches these. This file checks that what they produce is
 * **storable** — because the whole value of a fallback is that it works when nothing else did, and
 * a fallback whose output `RichTextSchema` refuses turns "the reply lost its formatting" into "the
 * reply never arrived".
 *
 * Two bugs came out of writing it, both in the budget arithmetic, and both only visible by parsing
 * the fallback's own output rather than by reading it:
 *
 *  - the paragraph cap was `5000 / 2`, so a degraded 64 KiB reply came to 2 501 paragraphs —
 *    5 002 nodes with the truncation notice, two over the limit;
 *  - the byte budget reserved a flat eighth of the cap for "structure", and 2 499 paragraphs of
 *    structure is 100 KiB. The budget is now counted from `JSON.stringify` itself.
 */
import { RICH_TEXT_MAX_BYTES, RICH_TEXT_MAX_NODES, RichTextSchema } from '@comvivo/core';
import { describe, expect, it } from 'vitest';
import {
  DEGRADE_REASONS,
  DEGRADE_TRUNCATION_NOTICE,
  degradeLinkToText,
  degradeToPlain,
  emphasisRuns,
  MAX_DEGRADED_PARAGRAPHS,
  MAX_EMPHASIS_RUNS,
  MAX_INPUT_NESTING,
  maxLeadingNesting,
  tableToCodeBlock,
  truncateToJsonBytes,
  utf8Length,
} from './degrade.js';
import { sketch } from './sketch.js';

describe('degradeToPlain (06 §3.5.2)', () => {
  it('splits on blank lines and keeps the text', () => {
    expect(sketch(degradeToPlain('one\n\ntwo\n\nthree'))).toBe('p["one"] p["two"] p["three"]');
  });

  it('treats a blank line with trailing whitespace as a blank line', () => {
    // Which is what a model emits: a line of spaces between paragraphs is invisible to whoever
    // wrote the prompt and common in generated text.
    expect(sketch(degradeToPlain('one\n   \ntwo'))).toBe('p["one"] p["two"]');
  });

  it('keeps a single newline inside a paragraph, because the fallback has no `br`', () => {
    // `06` §3.5.2's fallback is "plain paragraphs", so a soft break stays in the text. Every
    // renderer prints a newline inside a text run as a newline, which is what the model meant.
    expect(sketch(degradeToPlain('a\nb'))).toBe('p["a\\nb"]');
  });

  it('answers with one empty paragraph rather than nothing at all', () => {
    // `{v:1, blocks: []}` renders as silence, which a member cannot tell from being ignored — and
    // unlike `parse`, this function is already on a failure path and has no caller to inform.
    expect(sketch(degradeToPlain('   \n\t  '))).toBe('p[]');
    expect(sketch(degradeToPlain(''))).toBe('p[]');
  });

  it('stays inside the node budget, notice included', () => {
    const many = 'x\n\n'.repeat(MAX_DEGRADED_PARAGRAPHS + 500);
    const document = degradeToPlain(many);
    // Two nodes per paragraph, and the budget has to hold the notice too.
    expect(document.blocks.length).toBeLessThanOrEqual(MAX_DEGRADED_PARAGRAPHS + 1);
    expect(document.blocks.length * 2).toBeLessThanOrEqual(RICH_TEXT_MAX_NODES);
    expect(RichTextSchema.safeParse(document).success).toBe(true);
  });

  it('stays inside the byte cap for many short paragraphs', () => {
    // The shape that broke the first version: the paragraph count is the binding limit and the
    // per-paragraph JSON structure is most of the size.
    const document = degradeToPlain('ab\n\n'.repeat(4000));
    expect(utf8Length(JSON.stringify(document))).toBeLessThanOrEqual(RICH_TEXT_MAX_BYTES);
    expect(RichTextSchema.safeParse(document).success).toBe(true);
  });

  it('stays inside the byte cap for one enormous paragraph', () => {
    const document = degradeToPlain('x'.repeat(RICH_TEXT_MAX_BYTES * 3));
    expect(utf8Length(JSON.stringify(document))).toBeLessThanOrEqual(RICH_TEXT_MAX_BYTES);
    expect(RichTextSchema.safeParse(document).success).toBe(true);
  });

  it('stays inside the byte cap when every character needs a JSON escape', () => {
    // A quote or a backslash is one byte of text and two of JSON, so a budget counted in plain
    // UTF-8 overshoots by 2× on exactly this input — and a reply full of quoted strings is not
    // unusual. The characters are built from their code points rather than written as literals:
    // a control character in a source file is invisible in a diff and in most editors.
    const escapes = ['"', '\\', '\n', String.fromCharCode(1), String.fromCharCode(0x1f)];
    for (const unit of escapes) {
      const document = degradeToPlain(unit.repeat(RICH_TEXT_MAX_BYTES));
      expect(utf8Length(JSON.stringify(document)), JSON.stringify(unit)).toBeLessThanOrEqual(
        RICH_TEXT_MAX_BYTES,
      );
      expect(RichTextSchema.safeParse(document).success, JSON.stringify(unit)).toBe(true);
    }
  });

  it('stays inside the byte cap for four-byte characters', () => {
    const document = degradeToPlain('🙂'.repeat(RICH_TEXT_MAX_BYTES));
    expect(utf8Length(JSON.stringify(document))).toBeLessThanOrEqual(RICH_TEXT_MAX_BYTES);
    expect(RichTextSchema.safeParse(document).success).toBe(true);
  });

  it('marks what it dropped', () => {
    const document = degradeToPlain('x'.repeat(RICH_TEXT_MAX_BYTES * 2));
    expect(sketch(document)).toContain(DEGRADE_TRUNCATION_NOTICE);
  });

  it('does not mark anything when nothing was dropped', () => {
    expect(sketch(degradeToPlain('short'))).toBe('p["short"]');
  });
});

describe('truncateToJsonBytes', () => {
  it('cuts on a code-point boundary, never inside one', () => {
    // '🙂' is four bytes. A byte-wise cut at 2 would produce half a surrogate pair, which renders
    // as a replacement character in every client.
    expect(truncateToJsonBytes('🙂🙂', 4)).toBe('🙂');
    expect(truncateToJsonBytes('🙂🙂', 5)).toBe('🙂');
    expect(truncateToJsonBytes('🙂🙂', 7)).toBe('🙂');
    expect(truncateToJsonBytes('🙂🙂', 8)).toBe('🙂🙂');
    expect(truncateToJsonBytes('🙂', 3)).toBe('');
  });

  it('is empty for a non-positive limit', () => {
    expect(truncateToJsonBytes('abc', 0)).toBe('');
    expect(truncateToJsonBytes('abc', -1)).toBe('');
  });

  it('returns the whole string when it fits', () => {
    expect(truncateToJsonBytes('abc', 3)).toBe('abc');
    expect(truncateToJsonBytes('abc', 99)).toBe('abc');
  });
});

describe('utf8Length', () => {
  it('counts the bytes each code point actually takes', () => {
    expect(utf8Length('a')).toBe(1);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('中')).toBe(3);
    expect(utf8Length('🙂')).toBe(4);
    expect(utf8Length('a é 中 🙂')).toBe(1 + 1 + 2 + 1 + 3 + 1 + 4);
    expect(utf8Length('')).toBe(0);
  });

  it('agrees with the encoder on every boundary', () => {
    // The four width boundaries, because an off-by-one in the ranges is invisible for ASCII and
    // then wrong for every non-Latin script. Built from code points for the same reason as above.
    const encoder = new TextEncoder();
    for (const code of [0x7f, 0x80, 0x7ff, 0x800, 0xffff, 0x10000, 0x10ffff]) {
      const text = String.fromCodePoint(code);
      expect(utf8Length(text), code.toString(16)).toBe(encoder.encode(text).length);
    }
  });
});

describe('tableToCodeBlock (06 §3.5.2)', () => {
  it('pads the columns to the widest cell', () => {
    const block = tableToCodeBlock([
      ['a', 'bb'],
      ['ccc', 'd'],
    ]);
    expect(block).toEqual({ t: 'code', text: 'a    bb\nccc  d' });
  });

  it('rules off the header when there is one', () => {
    const block = tableToCodeBlock(
      [
        ['name', 'qty'],
        ['milk', '2'],
      ],
      { header: true },
    );
    expect(block).toEqual({ t: 'code', text: 'name  qty\n────  ───\nmilk  2' });
  });

  it('rules off nothing when the table is only a header', () => {
    // A rule with no data under it would look like a table whose rows failed to render.
    const block = tableToCodeBlock([['name', 'qty']], { header: true });
    expect(block).toEqual({ t: 'code', text: 'name  qty' });
  });

  it('pads a ragged row rather than losing its cells', () => {
    const block = tableToCodeBlock([['a', 'b'], ['c']]);
    expect(block).toEqual({ t: 'code', text: 'a  b\nc' });
  });

  it('is an empty block for a table with no columns', () => {
    expect(tableToCodeBlock([])).toEqual({ t: 'code', text: '' });
    expect(tableToCodeBlock([[]])).toEqual({ t: 'code', text: '' });
  });

  it('carries no `lang`, so nothing tries to highlight it', () => {
    expect(tableToCodeBlock([['a']])).not.toHaveProperty('lang');
  });

  it('measures width in code points, so an emoji does not skew the whole column', () => {
    // One code point, two columns wide on most terminals — which is a rendering question no
    // segmenter answers for every client. Counting code points keeps the table readable; counting
    // UTF-16 units would make an emoji column twice as wide as it needs to be.
    const block = tableToCodeBlock([
      ['🙂', 'x'],
      ['ab', 'y'],
    ]);
    expect(block.t === 'code' ? block.text : '').toBe('🙂   x\nab  y');
  });
});

describe('degradeLinkToText (06 §3.5.1)', () => {
  it('keeps the label and drops the URL', () => {
    // The label, not the URL: a `javascript:` URL shown to a member as text is both useless and
    // an invitation.
    expect(degradeLinkToText([{ t: 'text', text: 'click here' }])).toEqual([
      { t: 'text', text: 'click here' },
    ]);
  });

  it('drops an empty run, leaving nothing rather than an empty node', () => {
    expect(degradeLinkToText([{ t: 'text', text: '' }])).toEqual([]);
  });
});

describe('the reason list', () => {
  it('has no duplicates and is the metric’s label domain', () => {
    expect(new Set(DEGRADE_REASONS).size).toBe(DEGRADE_REASONS.length);
    expect([...DEGRADE_REASONS]).toEqual([
      'too_large',
      'output_too_large',
      'nesting_limit',
      'node_limit',
      'parser_error',
      'schema_invalid',
    ]);
  });
});

describe('maxLeadingNesting (M3-T3)', () => {
  it('counts the container markers that open a level', () => {
    expect(maxLeadingNesting('x')).toBe(0);
    expect(maxLeadingNesting('- x')).toBe(1);
    expect(maxLeadingNesting('- - - x')).toBe(3);
    expect(maxLeadingNesting('> x')).toBe(1);
    expect(maxLeadingNesting('> > > x')).toBe(3);
    expect(maxLeadingNesting('> - 1. x')).toBe(3);
    expect(maxLeadingNesting('1. x')).toBe(1);
    expect(maxLeadingNesting('12) x')).toBe(1);
    expect(maxLeadingNesting('* x')).toBe(1);
    expect(maxLeadingNesting('+ x')).toBe(1);
  });

  it('counts a thematic break as no nesting at all', () => {
    // `-----` is an `hr`, not five lists, and the difference is the space after the marker. Getting
    // this wrong would refuse a reply for using a horizontal rule.
    expect(maxLeadingNesting('-----')).toBe(0);
    expect(maxLeadingNesting('***')).toBe(0);
    expect(maxLeadingNesting('___')).toBe(0);
    // With spaces, two: the final `-` has no space after it, so it does not open a container.
    // CommonMark reads the whole line as an `hr`, so over-counting at all is the safe direction
    // and two is far below the limit either way.
    expect(maxLeadingNesting('- - -')).toBe(2);
    expect(maxLeadingNesting('- - - ')).toBe(3);
  });

  it('looks at every line, not only the first', () => {
    expect(maxLeadingNesting('x\n- - x\ny')).toBe(2);
  });

  it('ignores markers that are not at the start of a line', () => {
    expect(maxLeadingNesting('a - b > c 1. d')).toBe(0);
  });

  it('allows the deepest legitimate nesting `06` §3.5.1 permits', () => {
    // Three lists inside two quotes is the maximum the AST can hold, and it must not be refused.
    expect(maxLeadingNesting('> > - - - x')).toBeLessThanOrEqual(MAX_INPUT_NESTING);
  });

  it('stops counting once the limit is passed, so a hostile input is cheap', () => {
    const hostile = '- '.repeat(32_000);
    const started = Date.now();
    expect(maxLeadingNesting(hostile)).toBeGreaterThan(MAX_INPUT_NESTING);
    // Generous, because a timing assertion on a shared runner has to be. The point is that it is
    // milliseconds rather than the five minutes the parse would have taken.
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('emphasisRuns (M3-T3)', () => {
  it('counts a maximal run of one delimiter as one', () => {
    expect(emphasisRuns('x')).toBe(0);
    expect(emphasisRuns('*a*')).toBe(2);
    expect(emphasisRuns('**a**')).toBe(2);
    expect(emphasisRuns('***a***')).toBe(2);
    expect(emphasisRuns('~~a~~')).toBe(2);
    expect(emphasisRuns('_a_')).toBe(2);
    // Different delimiters touching are different runs.
    expect(emphasisRuns('*_a_*')).toBe(4);
  });

  it('counts the runs a saturated input holds without walking past the limit', () => {
    expect(emphasisRuns('*a '.repeat(5))).toBe(5);
    expect(emphasisRuns('*'.repeat(10_000))).toBe(1);
    expect(emphasisRuns('*a '.repeat(10_000))).toBeGreaterThan(MAX_EMPHASIS_RUNS);
  });

  it('leaves room for far more emphasis than a reply ever has', () => {
    // 512 complete bold spans in one reply, which is one every 130 characters of a full 64 KiB.
    expect(emphasisRuns('**bold** and '.repeat(256))).toBeLessThanOrEqual(MAX_EMPHASIS_RUNS);
  });
});
