/**
 * `06` §3.5.4's splitting budget: **≤ 3 ms p95 for a 4 000-character AST, ≤ 10 ms for 16 000**
 * (`M3-T5`'s AC; `06` §8).
 *
 * Gating, because this is on the turn's critical path and because the cost is **not** linear in
 * the document: §3.5.4 sets the safety factor at 1.0 "because measurement is exact", so the only
 * way to know whether a slice fits is to render it — and the fitting search therefore renders many
 * candidates per part. A regression here is a quadratic one, which is the kind that is invisible
 * on a test document and ruinous on a real reply.
 *
 * Two document sizes and two profiles:
 *
 *  - **Telegram** at 4 096 characters, which is the real limit a real reply meets. A 4 000-char
 *    document is one part, so this measures the *packing* path — the one every reply takes;
 *  - **Telegram at a tightened limit**, which forces the splitting path. Same document, so the
 *    difference between the two rows is the cost of actually splitting;
 *  - **Signal (plain)**, whose measure counts UTF-8 bytes — a per-character walk rather than a
 *    `.length`, so it is the more expensive measure of the two.
 *
 * Run with `pnpm bench --filter split`.
 */
import type { Block, RichText } from '@comvivo/core';
import { BRAND, type MemberId } from '@comvivo/shared';
import { defineBench, type ErasedBench } from '../../../../evals/src/perf/index.js';
import type { ChannelCapabilities, RenderContext } from '../contract.js';
import { profiles } from '../profiles.js';
import { splitAndRender } from './split.js';

const ANA = 'mbr_01jd0000000000000000000000' as MemberId;

const CONTEXT: RenderContext = {
  mentions: {
    [ANA]: { displayName: 'Ana', username: 'ana_g', platformUserId: '42', canPing: true },
  },
  self: { platformUserId: '1', displayName: BRAND.displayName, flags: {} },
  linkPreview: false,
  locale: 'en',
};

/**
 * A document of about `chars` visible characters, shaped like a reply.
 *
 * Prose with a heading, a list, a fenced block, a quote, a link and a mention — the same mix as
 * `richtext.bench.ts`'s "typical" row, because the splitter's cost depends on which block kinds it
 * has to recurse into and a document of plain paragraphs would measure the cheapest path.
 */
function documentOf(chars: number): RichText {
  const unit: Block[] = [
    { t: 'h', level: 2, c: [{ t: 'text', text: 'Thursday' }] },
    {
      t: 'p',
      c: [
        { t: 'text', text: "I've put the recital on the calendar for " },
        { t: 'text', text: 'Thursday at six', marks: ['b'] },
        { t: 'text', text: '. Three things to bring, and ' },
        { t: 'mention', target: { kind: 'member', memberId: ANA }, fallback: '@Ana' },
        { t: 'text', text: ' is driving.' },
      ],
    },
    {
      t: 'list',
      ordered: false,
      items: [
        [{ t: 'p', c: [{ t: 'text', text: 'the shoes' }] }],
        [{ t: 'p', c: [{ t: 'text', text: 'the sheet music' }] }],
        [{ t: 'p', c: [{ t: 'text', text: 'a water bottle' }] }],
      ],
    },
    { t: 'code', lang: 'sh', text: 'open https://example.com/hall\ncd ~/music' },
    { t: 'quote', c: [{ t: 'p', c: [{ t: 'text', text: 'Doors open at half past five.' }] }] },
    {
      t: 'p',
      c: [
        { t: 'text', text: "The hall's address is " },
        { t: 'link', url: 'https://example.com/hall', c: [{ t: 'text', text: 'here' }] },
        { t: 'text', text: '.' },
      ],
    },
  ];
  // Repeat the unit until the visible text is long enough. ~330 characters per unit, measured by
  // the loop itself rather than assumed, so the row's name stays true if the unit changes.
  const blocks: Block[] = [];
  let length = 0;
  while (length < chars) {
    blocks.push(...unit.map((block) => structuredClone(block)));
    length += 330;
  }
  return { v: 1, blocks };
}

const SMALL = documentOf(4000);
const LARGE = documentOf(16_000);

function tightened(base: ChannelCapabilities, maxMessageChars: number): ChannelCapabilities {
  return { ...base, maxMessageChars };
}

function split(document: RichText, capabilities: ChannelCapabilities): void {
  splitAndRender(document, {
    context: CONTEXT,
    capabilities,
    truncationNotice: 'Trimmed — ask me for the rest.',
    // The real default. A row that raised it would be measuring a path no reply takes.
    maxParts: 6,
  });
}

const benchmarks: readonly ErasedBench[] = [
  defineBench({
    id: 'micro:split.telegram.4k',
    name: 'split a 4 000-character AST for Telegram',
    unit: 'ms',
    budget: 3,
    run: () => {
      split(SMALL, profiles.telegram);
    },
  }),
  defineBench({
    id: 'micro:split.telegram.16k',
    name: 'split a 16 000-character AST for Telegram',
    unit: 'ms',
    budget: 10,
    run: () => {
      split(LARGE, profiles.telegram);
    },
  }),
  defineBench({
    id: 'micro:split.telegram.4k.tight',
    name: 'split a 4 000-character AST into many parts',
    unit: 'ms',
    // The splitting path rather than the packing one: a 400-character limit forces ten parts out
    // of the same document, so the gap between this row and the first is what splitting costs.
    budget: 3,
    run: () => {
      split(SMALL, tightened(profiles.telegram, 400));
    },
  }),
  defineBench({
    id: 'micro:split.plain.4k',
    name: 'split a 4 000-character AST for Signal (UTF-8 bytes)',
    unit: 'ms',
    // The more expensive measure: counting bytes is a per-character walk, not a `.length`.
    budget: 3,
    run: () => {
      split(SMALL, profiles.signal);
    },
  }),
];

export default benchmarks;
