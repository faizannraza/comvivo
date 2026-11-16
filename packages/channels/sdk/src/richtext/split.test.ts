/**
 * The splitter, case by case (`06` §3.5.4; `M3-T5`).
 *
 * `split.prop.test.ts` states C07's three properties over a thousand generated documents. This
 * file pins the decisions a property cannot see: *where* the cut lands, what a continued list is
 * numbered, which notice the reader gets, and what happens at the edges §3.5.4 names but does not
 * number.
 *
 * Every case uses a tightened limit, because the real profiles are 2 000–16 000 characters and a
 * readable test document is not. Tightening the limit is the same code path a platform with a
 * small limit takes — it is a capability, not a mode.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import { BRAND, type MemberId } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import type { ChannelCapabilities, RenderContext } from '../contract.js';
import { profiles } from '../profiles.js';
import {
  DEFAULT_MAX_PARTS_PER_MESSAGE,
  RESPLIT_LIMIT_FACTOR,
  splitAndRender,
  splitBlocks,
} from './split.js';

const ANA = 'mbr_01jd0000000000000000000000' as MemberId;

const CONTEXT: RenderContext = {
  mentions: {
    [ANA]: { displayName: 'Ana', username: 'ana_g', platformUserId: '42', canPing: true },
  },
  self: { platformUserId: '1', displayName: BRAND.displayName, flags: {} },
  linkPreview: false,
  locale: 'en',
};

const NOTICE = 'Trimmed — ask me for the rest.';

/**
 * A tightened limit on the **plain** profile.
 *
 * Plain, not web, and the reason is worth recording: `web-md`'s measure is `visibleText`, which
 * counts the *content* of a list and not its markers — so `1. aaaa` measures as four characters.
 * That is defensible for a dashboard with a 16 000-character limit and it makes a cased test
 * unreadable, because the number being asserted is not the text being asserted. On the plain
 * profile the measure is the rendered string's own length, so `measured` and `plainText` are the
 * same thing for the ASCII these cases use.
 */
function caps(
  maxMessageChars: number,
  base: ChannelCapabilities = profiles.signal,
): ChannelCapabilities {
  return { ...base, maxMessageChars };
}

/** The plain text of each part, which is what a reader sees. */
function partsOf(
  document: RichText,
  limit: number,
  over: Partial<ChannelCapabilities> = {},
): string[] {
  return splitAndRender(document, {
    context: CONTEXT,
    capabilities: { ...caps(limit), ...over },
    truncationNotice: NOTICE,
    maxParts: 1000,
  }).map((part) => part.plainText);
}

const doc = (...blocks: Block[]): RichText => ({ v: 1, blocks });
const p = (...c: Inline[]): Block => ({ t: 'p', c });
const t = (text: string): Inline => ({ t: 'text', text });

describe('a document that fits is one part (06 §3.5.4)', () => {
  it('is not split at all', () => {
    expect(partsOf(doc(p(t('short'))), 100)).toEqual(['short']);
  });

  it('packs several blocks into one part while they fit', () => {
    expect(partsOf(doc(p(t('one')), p(t('two'))), 100)).toEqual(['one\n\ntwo']);
  });

  it('starts a new part when the next block would not fit', () => {
    // The packing decision is made against `cur ++ [piece]`, not against the piece alone — two
    // blocks that each fit can still overflow together.
    expect(partsOf(doc(p(t('aaaa')), p(t('bbbb'))), 6)).toEqual(['aaaa', 'bbbb']);
  });
});

describe('the boundary preference (06 §3.5.4)', () => {
  it('prefers a `br`, and consumes it', () => {
    // The break *is* the boundary, so emitting it at the end of a part would be a blank line.
    expect(partsOf(doc(p(t('aaa'), { t: 'br' }, t('bbb'))), 5)).toEqual(['aaa', 'bbb']);
  });

  it('takes the latest `br` that fits', () => {
    expect(partsOf(doc(p(t('a'), { t: 'br' }, t('b'), { t: 'br' }, t('ccccc'))), 6)).toEqual([
      'a\nb',
      'ccccc',
    ]);
  });

  it('prefers a `br`, and the pieces may then re-pack into one part', () => {
    // Two behaviours in one case, both §3.5.4's own.
    //
    // The cut lands on the `br` rather than on the later sentence end, because §3.5.4's order is
    // literal. And the pieces are then **packed back together** by the same loop that packs any
    // other blocks: consuming the `br` and trimming the boundary whitespace makes the pieces
    // shorter than the paragraph they came from, so two of them fit where the original did not.
    //
    // The visible consequence is that a line break becomes a paragraph break — `ab\n\nShort.`
    // where the document said `ab\nShort.` Pinned rather than fixed: merging the pieces back into
    // one paragraph would have to re-insert the `br` the cut consumed, and refusing to pack them
    // would send more messages than the limit requires. Both are worse than a blank line.
    // And the same trade appears again one level down: the tail cuts at the **sentence end** after
    // `Short.`, not at the later whitespace before `sentence` — so three parts where two would
    // have held the text. §3.5.4 ranks a sentence end above whitespace, which is right for reading
    // and occasionally costs a message. Both orderings are the specification's, both are pinned,
    // and either can be revisited with a measurement rather than by taste.
    expect(partsOf(doc(p(t('ab'), { t: 'br' }, t('Short. Longer sentence here.'))), 20)).toEqual([
      'ab\n\nShort.',
      'Longer sentence',
      'here.',
    ]);
  });

  it('falls to a sentence end when there is no `br`', () => {
    expect(partsOf(doc(p(t('One. Two. Three.'))), 11)).toEqual(['One. Two.', 'Three.']);
  });

  it('recognises every sentence terminator §3.5.4 names', () => {
    for (const [terminator, first] of [
      ['.', 'aa.'],
      ['!', 'aa!'],
      ['?', 'aa?'],
      ['。', 'aa。'],
    ] as const) {
      expect(partsOf(doc(p(t(`aa${terminator} bbbb`))), 6), terminator).toEqual([first, 'bbbb']);
    }
  });

  it('falls to whitespace when there is no sentence end', () => {
    expect(partsOf(doc(p(t('alpha beta gamma'))), 11)).toEqual(['alpha beta', 'gamma']);
  });

  it('drops the whitespace at the boundary, so the next part starts with a word', () => {
    const parts = partsOf(doc(p(t('alpha beta'))), 6);
    expect(parts).toEqual(['alpha', 'beta']);
    for (const part of parts) expect(part).toBe(part.trim());
  });

  it('hard-cuts a token with no boundary in it', () => {
    expect(partsOf(doc(p(t('abcdefghij'))), 4)).toEqual(['abcd', 'efgh', 'ij']);
  });
});

describe('grapheme safety (06 §3.5.4, M3-T5 AC)', () => {
  it('never cuts inside a grapheme cluster', () => {
    // A family emoji is five code points and one cluster. Cutting between them gives two broken
    // glyphs, and on some clients a replacement character — which is why §3.5.4 names the
    // segmenter rather than leaving the cut to `slice`.
    const family = '👨‍👩‍👧‍👦';
    const parts = partsOf(doc(p(t(family.repeat(6)))), 30);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(
        [...new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(part)].length,
        part,
      ).toBe(part.length / family.length);
      expect(part, part).not.toContain('�');
    }
    expect(parts.join('')).toBe(family.repeat(6));
  });

  it('keeps a combining mark with its base character', () => {
    const accented = 'é';
    const parts = partsOf(doc(p(t(accented.repeat(8)))), 5);
    for (const part of parts) {
      // An odd length would mean a base separated from its mark.
      expect(part.length % accented.length, JSON.stringify(part)).toBe(0);
    }
    expect(parts.join('')).toBe(accented.repeat(8));
  });

  it('emits an oversized cluster rather than breaking it or looping', () => {
    // Signal counts UTF-8 bytes and a family emoji is 25 of them, so at a limit of 10 there is no
    // version of this that fits. The three options are an over-long part, a dropped character, or
    // mojibake — and an over-long part is the only one a member can still read. The platform will
    // refuse it; `06` §3.5.3's rejection path then re-sends as plain.
    const parts = partsOf(doc(p(t('👨‍👩‍👧‍👦'))), 10, { lengthUnit: 'utf8-bytes' });
    expect(parts).toEqual(['👨‍👩‍👧‍👦']);
  });
});

describe('fenced blocks (06 §3.5.4, M3-T5 AC)', () => {
  const code = (text: string, lang?: string): Block =>
    lang === undefined ? { t: 'code', text } : { t: 'code', lang, text };

  it('splits on line boundaries', () => {
    const parts = splitBlocks(doc(code('aaa\nbbb\nccc')), {
      context: CONTEXT,
      capabilities: caps(8),
      truncationNotice: NOTICE,
      maxParts: 1000,
    });
    expect(
      parts.map((slice) => slice.map((block) => (block.t === 'code' ? block.text : '?'))),
    ).toEqual([['aaa\nbbb'], ['ccc']]);
  });

  it('keeps `lang` on every piece, not only the first', () => {
    // A highlighter that lost the language halfway through a snippet would show the second half
    // unhighlighted, which reads as two different things rather than one thing continued.
    const parts = splitBlocks(doc(code('aaa\nbbb\nccc', 'js')), {
      context: CONTEXT,
      capabilities: caps(8),
      truncationNotice: NOTICE,
      maxParts: 1000,
    });
    expect(parts.length).toBeGreaterThan(1);
    for (const slice of parts) {
      for (const block of slice) {
        expect(block.t === 'code' ? block.lang : undefined).toBe('js');
      }
    }
  });

  it('hard-cuts a single line that is longer than a part', () => {
    const parts = splitBlocks(doc(code('abcdefghij')), {
      context: CONTEXT,
      capabilities: caps(4),
      truncationNotice: NOTICE,
      maxParts: 1000,
    });
    const texts = parts.flatMap((slice) =>
      slice.map((block) => (block.t === 'code' ? block.text : '?')),
    );
    expect(texts.join('')).toBe('abcdefghij');
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(4);
  });

  it('hard-cuts a long line on grapheme boundaries, not code points', () => {
    // The gap a break drill found: the paragraph path and the fenced-block path have **separate**
    // hard cuts, and the grapheme tests above only covered the first. Replacing `splitCode`'s
    // segmenter with `[...text]` — a code-point split — passed all 48 tests, because no case put a
    // multi-code-point cluster inside a fence. A snippet with an emoji in a comment is ordinary.
    const family = '👨‍👩‍👧‍👦';
    const parts = splitBlocks(doc(code(family.repeat(6))), {
      context: CONTEXT,
      capabilities: caps(40),
      truncationNotice: NOTICE,
      maxParts: 1000,
    });
    const texts = parts.flatMap((slice) =>
      slice.map((block) => (block.t === 'code' ? block.text : '?')),
    );
    expect(texts.length).toBeGreaterThan(1);
    for (const text of texts) {
      expect(text.length % family.length, JSON.stringify(text)).toBe(0);
      expect(text, text).not.toContain('\ufffd');
    }
    expect(texts.join('')).toBe(family.repeat(6));
  });

  it('keeps an empty fenced block as a block', () => {
    expect(
      splitBlocks(doc(code('')), {
        context: CONTEXT,
        capabilities: caps(10),
        truncationNotice: NOTICE,
      }),
    ).toEqual([[{ t: 'code', text: '' }]]);
  });
});

describe('lists (06 §3.5.4, M3-T5 AC)', () => {
  const item = (text: string): Block[] => [p(t(text))];
  const list = (ordered: boolean, items: Block[][], start?: number): Block => ({
    t: 'list',
    ordered,
    ...(start === undefined ? {} : { start }),
    items,
  });

  function listsOf(document: RichText, limit: number): readonly Block[][] {
    return splitBlocks(document, {
      context: CONTEXT,
      capabilities: caps(limit),
      truncationNotice: NOTICE,
      maxParts: 1000,
    }).map((slice) => [...slice]);
  }

  it('splits between items', () => {
    // 9, not 7: the bullet is `•` (U+2022), which is **three** UTF-8 bytes, and the plain profile
    // counts bytes. `• aaaa` is eight. A limit of seven would split inside the item instead, which
    // is correct behaviour for a limit that cannot hold one item — and not what this case is about.
    expect(partsOf(doc(list(false, [item('aaaa'), item('bbbb')])), 9)).toEqual([
      '• aaaa',
      '• bbbb',
    ]);
  });

  it('continues the numbering of an ordered list', () => {
    // A second part that restarted at 1 would tell a reader there are two lists — and a reply that
    // says "step 1" twice is worse than one that arrives in two messages.
    expect(partsOf(doc(list(true, [item('aaaa'), item('bbbb'), item('cccc')])), 9)).toEqual([
      '1. aaaa',
      '2. bbbb',
      '3. cccc',
    ]);
  });

  it('continues from an explicit `start`', () => {
    expect(partsOf(doc(list(true, [item('aaaa'), item('bbbb')], 7)), 9)).toEqual([
      '7. aaaa',
      '8. bbbb',
    ]);
  });

  it('omits `start` on a bullet list and on an ordered list that begins at 1', () => {
    // The same rule the parser applies, so a split list and an unsplit one compare equal where
    // they should.
    const slices = listsOf(doc(list(true, [item('aaaa'), item('bbbb')])), 9);
    expect(slices[0]?.[0]).not.toHaveProperty('start');
    expect(slices[1]?.[0]).toHaveProperty('start', 2);
    const bullets = listsOf(doc(list(false, [item('aaaa'), item('bbbb')])), 7);
    for (const slice of bullets) expect(slice[0]).not.toHaveProperty('start');
  });

  it('splits an oversized item recursively, keeping the marker on the first piece only', () => {
    // §3.5.4: "A single oversized item is split recursively." The continuation arrives as bare
    // blocks, which is how a continued line reads — and avoids showing the reader the same item
    // number twice.
    const parts = partsOf(doc(list(true, [item('alpha beta gamma delta')])), 12);
    expect(parts[0]).toBe('1. alpha');
    expect(parts.join(' ')).toContain('delta');
    expect(parts.filter((part) => part.startsWith('1.'))).toHaveLength(1);
  });

  it('keeps an empty list as a list', () => {
    expect(listsOf(doc(list(false, [])), 10)).toEqual([[{ t: 'list', ordered: false, items: [] }]]);
  });
});

describe('quotes (06 §3.5.4)', () => {
  it('wraps every piece in a quote', () => {
    const parts = partsOf(doc({ t: 'quote', c: [p(t('aaaa')), p(t('bbbb'))] }), 9);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.startsWith('>'), part).toBe(true);
  });

  it('accounts for the quote prefix when deciding where to cut', () => {
    // `> ` is two characters per line in plain text, so splitting against the bare limit and
    // wrapping afterwards overflows by the prefix. The wrapper is inside the measure.
    for (const part of splitAndRender(doc({ t: 'quote', c: [p(t('alpha beta gamma'))] }), {
      context: CONTEXT,
      capabilities: caps(10),
      truncationNotice: NOTICE,
      maxParts: 1000,
    })) {
      expect(part.measured, part.plainText).toBeLessThanOrEqual(10);
    }
  });
});

describe('atomic inlines (06 §3.5.4)', () => {
  it('keeps a link, a mention and a time node whole when they fit', () => {
    const document = doc(
      p({ t: 'link', url: 'https://e.co', c: [{ t: 'text', text: 'here' }] }),
      p({ t: 'mention', target: { kind: 'member', memberId: ANA }, fallback: '@A' }),
      p({ t: 'time', at: '2026-11-15T18:00:00Z', fallback: 'Sat' }),
    );
    // Two parts, not three: the first paragraph is 19 bytes and fills the part on its own, and the
    // other two pack together — which is the packing loop working, not the atomics being split.
    expect(partsOf(document, 20)).toEqual(['here (https://e.co)', '@Ana\n\nSat']);
  });

  it('degrades a too-long link to its label, dropping the URL', () => {
    // §3.5.4: "An atomic node longer than the limit degrades to text." The label only, because a
    // link long enough to reach here gets cut — and cutting `label (url)` leaves a **broken
    // clickable URL** in one part and its tail in the next. A wrong URL is worse than an absent
    // one: a member can ask for the link again and cannot un-click a bad one.
    const document = doc(
      p({ t: 'link', url: 'https://e.co/very/long/path', c: [{ t: 'text', text: 'alpha beta' }] }),
    );
    const parts = partsOf(document, 8);
    expect(parts.join(' ')).not.toContain('https://');
    expect(parts.join('')).toContain('alpha');
  });

  it('degrades a link with no label to its URL, which is all there is', () => {
    const document = doc(p({ t: 'link', url: 'https://e.co/abcdefghij', c: [] }));
    expect(partsOf(document, 8).join('')).toBe('https://e.co/abcdefghij');
  });

  it('degrades a too-long inline code node to text', () => {
    const parts = partsOf(doc(p({ t: 'code', text: 'abcdefghij' })), 4);
    expect(parts.join('')).toBe('abcdefghij');
  });

  it('degrades a too-long mention to its fallback', () => {
    const long = 'mbr_01jd000000000000000000000z' as MemberId;
    const parts = partsOf(
      doc(
        p({
          t: 'mention',
          target: { kind: 'member', memberId: long },
          fallback: '@A very long name',
        }),
      ),
      8,
    );
    expect(parts.join('')).toContain('very');
  });
});

describe('the part budget (06 §3.5.4, M3-T5 AC)', () => {
  const many = doc(...Array.from({ length: 12 }, (_, index) => p(t(`part-${String(index)}`))));

  it('defaults to six parts', () => {
    expect(DEFAULT_MAX_PARTS_PER_MESSAGE).toBe(6);
    expect(partsOf(many, 8)).toHaveLength(12);
    const capped = splitAndRender(many, {
      context: CONTEXT,
      capabilities: caps(8),
      truncationNotice: NOTICE,
    });
    expect(capped).toHaveLength(DEFAULT_MAX_PARTS_PER_MESSAGE);
  });

  it('keeps `max - 1` parts and makes the last one the notice', () => {
    // The notice **replaces** the overflow rather than being appended to it, which is what "keep
    // first (max-1)" says — and the only version that stays within the budget it is enforcing.
    const parts = splitAndRender(many, {
      context: CONTEXT,
      capabilities: caps(8),
      truncationNotice: NOTICE,
      maxParts: 3,
    }).map((part) => part.plainText);
    expect(parts).toEqual(['part-0', 'part-1', NOTICE]);
  });

  it('takes the notice from the caller rather than shipping copy', () => {
    // `CLAUDE.md` §2 keeps bot copy in versioned template files, and this package cannot reach the
    // engine's copy service — so a default here would be an English string invisible to every
    // translator and to `copy:check`.
    const parts = splitAndRender(many, {
      context: CONTEXT,
      capabilities: caps(8),
      truncationNotice: 'recortado',
      maxParts: 2,
    });
    expect(parts.at(-1)?.plainText).toBe('recortado');
  });

  it('does not add a notice when nothing was dropped', () => {
    expect(partsOf(doc(p(t('short'))), 100)).toEqual(['short']);
  });
});

describe('the re-split factor (06 §3.5.4)', () => {
  it('is 80%, and tightens the limit when asked', () => {
    expect(RESPLIT_LIMIT_FACTOR).toBe(0.8);
    const document = doc(p(t('alpha beta gamma delta')));
    const whole = partsOf(document, 24);
    const resplit = splitAndRender(document, {
      context: CONTEXT,
      capabilities: caps(24),
      truncationNotice: NOTICE,
      maxParts: 1000,
      limitFactor: RESPLIT_LIMIT_FACTOR,
    });
    // 24 → 19, so the same document needs one more part.
    expect(resplit.length).toBeGreaterThan(whole.length);
    for (const part of resplit) expect(part.measured).toBeLessThanOrEqual(19);
  });
});

describe('edges', () => {
  it('returns one empty part for an empty document', () => {
    expect(
      splitBlocks(doc(), { context: CONTEXT, capabilities: caps(10), truncationNotice: NOTICE }),
    ).toEqual([]);
    expect(
      splitAndRender(doc(), { context: CONTEXT, capabilities: caps(10), truncationNotice: NOTICE }),
    ).toEqual([]);
  });

  it('keeps a thematic break whole, because there is nothing to cut', () => {
    expect(partsOf(doc({ t: 'hr' }), 2)).toEqual(['———']);
  });

  it('does not mutate the document it was given', () => {
    const document = doc(p(t('alpha beta gamma')), {
      t: 'list',
      ordered: true,
      items: [[p(t('x'))]],
    });
    const before = JSON.stringify(document);
    partsOf(document, 8);
    expect(JSON.stringify(document)).toBe(before);
  });
});
