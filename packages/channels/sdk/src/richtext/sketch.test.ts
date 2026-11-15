/**
 * The corpus notation is lossless (`M3-T3`).
 *
 * This is the test that makes `parse.corpus.test.ts` worth having. 155 cases compare a document to
 * a one-line string, so if the notation dropped a field, every case that differed only in that
 * field would pass — and the corpus would be 155 assertions about nothing.
 *
 * So: for each kind of node, two documents that differ in **exactly one** field must sketch
 * differently. That is a weaker claim than full injectivity and a much stronger one than "it looks
 * right", and it is the claim the corpus actually depends on.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import { describe, expect, it } from 'vitest';
import { sketch, sketchBlock, sketchInline } from './sketch.js';

function document(...blocks: Block[]): RichText {
  return { v: 1, blocks };
}

function paragraph(...inlines: Inline[]): Block {
  return { t: 'p', c: inlines };
}

describe('the notation distinguishes every field it carries', () => {
  it('distinguishes text, and its marks', () => {
    const pairs: readonly (readonly [Inline, Inline])[] = [
      [
        { t: 'text', text: 'a' },
        { t: 'text', text: 'b' },
      ],
      [
        { t: 'text', text: 'a' },
        { t: 'text', text: 'a', marks: ['b'] },
      ],
      [
        { t: 'text', text: 'a', marks: ['b'] },
        { t: 'text', text: 'a', marks: ['i'] },
      ],
      [
        { t: 'text', text: 'a', marks: ['b'] },
        { t: 'text', text: 'a', marks: ['b', 'i'] },
      ],
    ];
    for (const [left, right] of pairs) {
      expect(sketchInline(left), JSON.stringify([left, right])).not.toBe(sketchInline(right));
    }
  });

  it('distinguishes a text run from inline code with the same text', () => {
    // The pair a notation that printed both as their text would collapse — and inline code is the
    // one inline that takes no marks, so collapsing them would hide a real mapping bug.
    expect(sketchInline({ t: 'text', text: 'x' })).not.toBe(sketchInline({ t: 'code', text: 'x' }));
  });

  it('distinguishes a link’s URL and its label', () => {
    const base: Inline = { t: 'link', url: 'https://a.co', c: [{ t: 'text', text: 'l' }] };
    expect(sketchInline(base)).not.toBe(
      sketchInline({ t: 'link', url: 'https://b.co', c: [{ t: 'text', text: 'l' }] }),
    );
    expect(sketchInline(base)).not.toBe(
      sketchInline({ t: 'link', url: 'https://a.co', c: [{ t: 'text', text: 'm' }] }),
    );
  });

  it('distinguishes a mention’s target and its fallback', () => {
    const member: Inline = {
      t: 'mention',
      target: { kind: 'member', memberId: 'mbr_01jd0000000000000000000000' as never },
      fallback: '@Ana',
    };
    expect(sketchInline(member)).not.toBe(
      sketchInline({
        t: 'mention',
        target: { kind: 'member', memberId: 'mbr_01jd0000000000000000000001' as never },
        fallback: '@Ana',
      }),
    );
    expect(sketchInline(member)).not.toBe(sketchInline({ ...member, fallback: '@Bea' } as Inline));
    // And a platform user from a member, which are different nodes with the same shape.
    expect(sketchInline(member)).not.toBe(
      sketchInline({
        t: 'mention',
        target: { kind: 'platform_user', platformUserId: 'mbr_01jd0000000000000000000000' },
        fallback: '@Ana',
      }),
    );
  });

  it('distinguishes a time node’s instant and its fallback', () => {
    const base: Inline = { t: 'time', at: '2026-01-01T00:00:00Z', fallback: 'soon' };
    expect(sketchInline(base)).not.toBe(sketchInline({ ...base, at: '2026-01-02T00:00:00Z' }));
    expect(sketchInline(base)).not.toBe(sketchInline({ ...base, fallback: 'later' }));
  });

  it('distinguishes a heading’s level', () => {
    expect(sketchBlock({ t: 'h', level: 1, c: [] })).not.toBe(
      sketchBlock({ t: 'h', level: 2, c: [] }),
    );
  });

  it('distinguishes a list’s ordering, its start and its items', () => {
    const items = [[paragraph({ t: 'text', text: 'a' })]];
    expect(sketchBlock({ t: 'list', ordered: false, items })).not.toBe(
      sketchBlock({ t: 'list', ordered: true, items }),
    );
    expect(sketchBlock({ t: 'list', ordered: true, items })).not.toBe(
      sketchBlock({ t: 'list', ordered: true, start: 3, items }),
    );
    expect(sketchBlock({ t: 'list', ordered: true, start: 3, items })).not.toBe(
      sketchBlock({ t: 'list', ordered: true, start: 4, items }),
    );
    // Item boundaries, which is the field a flat notation loses: one item of two paragraphs is
    // not two items of one, and that is exactly what the clamping tests assert.
    const oneItem = [[paragraph({ t: 'text', text: 'a' }), paragraph({ t: 'text', text: 'b' })]];
    const twoItems = [[paragraph({ t: 'text', text: 'a' })], [paragraph({ t: 'text', text: 'b' })]];
    expect(sketchBlock({ t: 'list', ordered: false, items: oneItem })).not.toBe(
      sketchBlock({ t: 'list', ordered: false, items: twoItems }),
    );
  });

  it('distinguishes a code block’s language and its text', () => {
    expect(sketchBlock({ t: 'code', text: 'x' })).not.toBe(
      sketchBlock({ t: 'code', lang: 'js', text: 'x' }),
    );
    expect(sketchBlock({ t: 'code', lang: 'js', text: 'x' })).not.toBe(
      sketchBlock({ t: 'code', lang: 'ts', text: 'x' }),
    );
    expect(sketchBlock({ t: 'code', text: 'x' })).not.toBe(sketchBlock({ t: 'code', text: 'y' }));
  });

  it('distinguishes quote nesting', () => {
    const inner: Block = { t: 'quote', c: [paragraph({ t: 'text', text: 'x' })] };
    expect(sketchBlock(inner)).not.toBe(sketchBlock({ t: 'quote', c: [inner] }));
  });

  it('distinguishes a paragraph from a heading with the same content', () => {
    const content: Inline[] = [{ t: 'text', text: 'x' }];
    expect(sketchBlock({ t: 'p', c: content })).not.toBe(
      sketchBlock({ t: 'h', level: 1, c: content }),
    );
  });

  it('distinguishes block boundaries', () => {
    // Two paragraphs from one, which a notation that joined everything would lose — and which is
    // the difference between one message and two after the splitter runs (`M3-T5`).
    expect(sketch(document(paragraph({ t: 'text', text: 'ab' })))).not.toBe(
      sketch(document(paragraph({ t: 'text', text: 'a' }), paragraph({ t: 'text', text: 'b' }))),
    );
  });
});

describe('the notation stays on one line', () => {
  it('escapes a newline inside a text run', () => {
    // The whole point of the notation is that a case is one line. A run holding a newline would
    // otherwise break the corpus table into something no reviewer can scan.
    const printed = sketch(document(paragraph({ t: 'text', text: 'a\nb' })));
    expect(printed).not.toContain('\n');
    expect(printed).toBe('p["a\\nb"]');
  });

  it('escapes a newline inside a code block', () => {
    const printed = sketchBlock({ t: 'code', text: 'a\nb' });
    expect(printed).not.toContain('\n');
  });

  it('distinguishes an empty text run from no run at all', () => {
    expect(sketchBlock(paragraph())).not.toBe(sketchBlock(paragraph({ t: 'text', text: '' })));
  });
});

describe('every node kind renders', () => {
  it('has a case for each `t`, so a new node kind cannot be invisible', () => {
    // The exhaustive switches in `sketch.ts` make this a compile error rather than a runtime one,
    // but a notation that printed a node as `undefined` would still pass every corpus case that
    // did not use it. This asserts the output is non-empty for all of them.
    const inlines: Inline[] = [
      { t: 'text', text: 'x' },
      { t: 'code', text: 'x' },
      { t: 'link', url: 'https://e.co', c: [] },
      {
        t: 'mention',
        target: { kind: 'member', memberId: 'mbr_01jd0000000000000000000000' as never },
        fallback: '@A',
      },
      { t: 'time', at: '2026-01-01T00:00:00Z', fallback: 'soon' },
      { t: 'br' },
    ];
    for (const inline of inlines) {
      expect(sketchInline(inline), inline.t).not.toBe('');
      expect(sketchInline(inline), inline.t).not.toContain('undefined');
    }
    const blocks: Block[] = [
      paragraph(),
      { t: 'h', level: 3, c: [] },
      { t: 'list', ordered: false, items: [] },
      { t: 'code', text: '' },
      { t: 'quote', c: [] },
      { t: 'hr' },
    ];
    for (const block of blocks) {
      expect(sketchBlock(block), block.t).not.toBe('');
      expect(sketchBlock(block), block.t).not.toContain('undefined');
    }
  });
});
