/**
 * The splitter (`06` §3.5.4; `M3-T5`).
 *
 * One reply becomes one or more platform messages, and the whole design rests on a single
 * sentence from §3.5.4: **"Each part is rendered from its own AST slice, so markup can never be
 * broken across parts."**
 *
 * That is why this splits the *tree* and not the rendered string. A splitter that cut Telegram
 * HTML at 4 096 characters would produce `<b>half a bo` — which Telegram answers with
 * `400 can't parse entities`, so the member gets nothing. Cutting the AST and rendering each slice
 * means every part is well-formed by construction, and `split.prop.test.ts` asserts exactly that
 * (`06` §9's C07).
 *
 * ## What "fits" means
 *
 * `measure` renders a candidate and counts the unit the platform counts (`M3-T4`). §3.5.4 sets the
 * safety factor at **1.0** "because measurement is exact", so there is no slack to absorb an
 * approximation: the only way to know whether a slice fits is to render it. That makes the fitting
 * search the expensive part, and the reason the greedy walk below is written to measure a prefix
 * rather than each candidate independently.
 *
 * ## The boundary preference, and what it costs
 *
 * §3.5.4 orders the boundaries: `br`, then a sentence end, then whitespace, then a hard cut at a
 * grapheme boundary. Taken literally — and it is taken literally here — the **latest `br` that
 * fits wins even when a sentence end would have been later**. That is right almost always: a
 * paragraph with `br`s in it is a multi-line paragraph, and breaking at a line the model wrote is
 * where a reader expects the break. It is wasteful in one shape — a single `br` near the start of
 * an otherwise long paragraph gives a short first part — and that is accepted rather than patched
 * with a threshold this specification does not have. `split.test.ts` pins the behaviour so a later
 * measurement can change it on purpose.
 */
import type { Block, Inline, RichText, TextInline } from '@comvivo/core';
import type { ChannelCapabilities, RenderContext, RenderedPart } from '../contract.js';
import { renderPart } from './render/index.js';

/** `06` §3.5.4's default. Config (`channels.defaults.outbound`) overrides it at `M3-T27`. */
export const DEFAULT_MAX_PARTS_PER_MESSAGE = 6;

/** `06` §3.5.4: "On a platform `message_too_long`, re-split once at 80% of the limit." */
export const RESPLIT_LIMIT_FACTOR = 0.8;

/**
 * Grapheme clusters, for the hard cut.
 *
 * `'und'` is what §3.5.4 names, and it is the right choice: grapheme segmentation is
 * locale-independent in practice, and a reply that split differently on a host set to `tr-TR`
 * would be a difference nobody could reproduce. Built once — a `Segmenter` is not cheap and this
 * runs on every reply.
 */
const GRAPHEMES = new Intl.Segmenter('und', { granularity: 'grapheme' });

/** `06` §3.5.4's sentence end: one of `. ! ? 。` followed by whitespace. */
const SENTENCE_END = /[.!?。]\s/g;

export interface SplitOptions {
  readonly context: RenderContext;
  readonly capabilities: ChannelCapabilities;
  /**
   * The rendered `channels.truncated` notice (`06` §3.5.4).
   *
   * Passed in, not defaulted, and **required**. `CLAUDE.md` §2 keeps bot copy in versioned
   * template files, and this package may not reach the engine's copy service — so a default here
   * would be an English string shipped inside the channel SDK, invisible to every translator and
   * to `copy:check`. The key's catalog is `packages/engine/copy/channels/en.yaml` (`M3-T18`); the
   * caller renders it and hands over the text.
   */
  readonly truncationNotice: string;
  /** `maxPartsPerMessage`. Defaults to `06` §3.5.4's 6. */
  readonly maxParts?: number;
  /**
   * A fraction of `maxMessageChars`, for §3.5.4's re-split after a platform `message_too_long`.
   *
   * The splitter is exact, so this should never be needed — which is precisely why it exists: a
   * platform that counts differently from its own documentation is a thing that happens, and the
   * alternative to one re-split at 80% is a message that can never be sent.
   */
  readonly limitFactor?: number;
}

/**
 * The AST slices `splitAndRender` will render, one per part.
 *
 * Exposed because the slices are what §3.5.4 actually talks about — "each part is rendered from its
 * own AST slice" — and three callers need them rather than the rendered strings.
 *
 * `M3-T27`'s dispatcher needs them to re-split at 80% after a platform `message_too_long` without
 * re-deciding the boundaries. `05` §3.10.1's trace records the part count. And C07's
 * text-preservation property needs them to say anything true at all: comparing the *rendered* text
 * of one part against six cannot work, because each part re-adds its own quote prefix and list
 * bullet, so the six-part version legitimately holds five extra `>` characters. Over the slices the
 * statement is exact.
 */
export function splitBlocks(
  document: RichText,
  options: SplitOptions,
): readonly (readonly Block[])[] {
  const limit = Math.max(
    1,
    Math.floor(options.capabilities.maxMessageChars * (options.limitFactor ?? 1)),
  );
  // `RichText.blocks` is a mutable array in `06` §3.5.1's type, so the copy is not ceremony: it is
  // what lets every function below take `readonly Block[]` and so never mutate a caller's slice.
  const measure = (blocks: readonly Block[]): number =>
    renderPart({ v: 1, blocks: [...blocks] }, options.context, options.capabilities).measured;

  const slices = sliceBlocks(document.blocks, limit, measure);
  return truncate(
    slices,
    options.maxParts ?? DEFAULT_MAX_PARTS_PER_MESSAGE,
    options.truncationNotice,
  );
}

/**
 * Split `document` into parts that each fit, and render each one.
 *
 * Never returns an empty list for a non-empty document, and never more than `maxParts`.
 */
export function splitAndRender(document: RichText, options: SplitOptions): readonly RenderedPart[] {
  return splitBlocks(document, options).map((blocks) =>
    renderPart({ v: 1, blocks: [...blocks] }, options.context, options.capabilities),
  );
}

/**
 * What a measurement needs: a list of blocks in, a platform-unit length out.
 *
 * **The wrapper lives inside the measure**, and that was a bug before it was a comment. A list
 * item's content was split against the bare limit and then wrapped back into a one-item list,
 * which adds the bullet and the indent — so a piece that fitted as blocks did not fit as an item,
 * and the part overflowed by exactly the marker. The same was latent in `splitQuote`: a
 * `<blockquote>` costs nothing in Telegram's visible-length measure and `> ` per line costs two
 * characters per line in plain text. So a function that splits the children of a container passes
 * down a measure that already includes the container, and every decision below is made against
 * what will actually be sent. Found by C07's fitting property on the first run.
 */
type Measure = (blocks: readonly Block[]) => number;

/**
 * §3.5.4's main loop: pack blocks into slices, splitting a block that does not fit alone.
 *
 * Two phases rather than the specification's single interleaved loop, and the result is the same
 * because `splitBlock` does not look at what is already packed — it takes a block and a limit.
 * Separating them is what lets the packing be a binary search.
 *
 * ## Why the packing is a binary search
 *
 * The obvious loop adds one piece at a time and measures `cur ++ [piece]` each time, which is what
 * §3.5.4's pseudocode describes. Measuring means **rendering** (the safety factor is 1.0, so there
 * is no approximation available), so that loop renders a 1-block slice, then a 2-block slice, then
 * a 3-block slice — **quadratic in the number of blocks of a part**.
 *
 * `split.bench.ts` found it, and found it in the shape that matters: a 4 000-character reply that
 * **fits in one part** took 3.19 ms against §3.5.4's 3 ms budget, while the same document split
 * into ten parts took 0.56 ms — six times faster, because flushing keeps `cur` short. The common
 * case was the slow one. At 16 000 characters it was 13.3 ms against a 10 ms budget.
 *
 * Adding a block never shortens the rendered output, so "how many of the pending pieces fit" is
 * monotone and can be bisected: O(log k) renders per part instead of O(k). Still exact — every
 * probe is a real render of a real candidate — and `C07`'s fitting property is what keeps it so.
 */
function sliceBlocks(blocks: readonly Block[], limit: number, measure: Measure): Block[][] {
  const pieces: Block[] = [];
  for (const block of blocks) {
    if (measure([block]) <= limit) pieces.push(block);
    else pieces.push(...splitBlock(block, limit, measure));
  }

  const parts: Block[][] = [];
  let at = 0;
  while (at < pieces.length) {
    const count = longestFittingRun(pieces, at, limit, measure);
    parts.push(pieces.slice(at, at + count));
    at += count;
  }
  return parts;
}

/**
 * How many pieces starting at `from` fit together. At least one, always.
 *
 * At least one even when that one does not fit: a piece `splitBlock` could not shrink — a
 * thematic break under a three-character limit, or a grapheme cluster larger than the limit — has
 * to go somewhere, and an empty part would mean the loop above never advances.
 */
function longestFittingRun(
  pieces: readonly Block[],
  from: number,
  limit: number,
  measure: Measure,
): number {
  const available = pieces.length - from;
  const fits = (count: number): boolean => measure(pieces.slice(from, from + count)) <= limit;
  // Double first, so a document that fits in one part costs about log₂(n) renders rather than a
  // bisection over the whole remainder.
  let low = 1;
  let high = 1;
  while (high < available && fits(Math.min(high * 2, available)))
    high = Math.min(high * 2, available);
  if (high >= available && fits(available)) return available;
  // `low` fits (or is the forced minimum) and `high + 1` does not.
  low = high;
  let bound = Math.min(high * 2, available);
  while (low < bound) {
    const middle = Math.ceil((low + bound) / 2);
    if (fits(middle)) low = middle;
    else bound = middle - 1;
  }
  return Math.max(1, low);
}

/**
 * §3.5.4's truncation: keep `max - 1` parts and make the last one a notice.
 *
 * The notice replaces the overflow rather than being appended to it, which is what "keep first
 * (max-1)" says — and is the only version that stays within the part budget it is enforcing.
 */
function truncate(parts: Block[][], maxParts: number, notice: string): Block[][] {
  if (parts.length <= maxParts) return parts;
  const kept = parts.slice(0, Math.max(0, maxParts - 1));
  kept.push([{ t: 'p', c: [{ t: 'text', text: notice }] }]);
  return kept;
}

/** One block into pieces that each fit, per §3.5.4's `splitBlock` rules. */
function splitBlock(block: Block, limit: number, measure: Measure): Block[] {
  switch (block.t) {
    case 'p':
    case 'h':
      return splitInlineBlock(block, limit, measure);
    case 'code':
      return splitCode(block, limit, measure);
    case 'list':
      return splitList(block, limit, measure);
    case 'quote':
      return splitQuote(block, limit, measure);
    case 'hr':
      // Three characters, and nothing to cut. A limit below that is a misconfigured profile, not
      // a document this function can do anything about.
      return [block];
  }
}

/** A `p` or `h` with different inlines, keeping the heading's level. */
function withInlines(block: Extract<Block, { t: 'p' | 'h' }>, c: Inline[]): Block {
  return block.t === 'h' ? { t: 'h', level: block.level, c } : { t: 'p', c };
}

function splitInlineBlock(
  block: Extract<Block, { t: 'p' | 'h' }>,
  limit: number,
  measure: Measure,
): Block[] {
  const out: Block[] = [];
  let rest: readonly Inline[] = block.c;
  while (rest.length > 0) {
    const cut = cutInlines(block, rest, limit, measure);
    if (cut.head.length === 0) {
      // No progress is possible — a limit too small for even one grapheme. Emitting what is left
      // is better than looping: the platform will refuse an over-long message, and a hang would
      // take the worker with it.
      out.push(withInlines(block, [...rest]));
      return out;
    }
    out.push(withInlines(block, cut.head));
    rest = cut.tail;
  }
  return out.length > 0 ? out : [withInlines(block, [])];
}

interface InlineCut {
  readonly head: Inline[];
  readonly tail: readonly Inline[];
}

/**
 * The best place to cut `inlines`, per §3.5.4's boundary order.
 *
 * The greedy prefix comes first because it bounds the search: everything after the first inline
 * that does not fit is irrelevant, and measuring is the expensive operation.
 */
function cutInlines(
  block: Extract<Block, { t: 'p' | 'h' }>,
  inlines: readonly Inline[],
  limit: number,
  measure: Measure,
): InlineCut {
  let fitting = 0;
  while (
    fitting < inlines.length &&
    measure([withInlines(block, [...inlines.slice(0, fitting + 1)])]) <= limit
  ) {
    fitting += 1;
  }
  if (fitting === inlines.length) return { head: [...inlines], tail: [] };

  // 1. `br` — the highest-quality boundary, and the one the model asked for. The `br` itself is
  //    consumed: it *is* the break, so emitting it at the end of a part would be a blank line.
  //
  //    The search stops at index **1**, not 0. A break at the very start would cut an empty head,
  //    which produces no part and no progress — and the first version of this looped until the
  //    guard below emitted the whole oversized paragraph, overflowing by everything after the
  //    break. C07's fitting property found it on a quote whose paragraph opened with a `br`.
  //    Falling through instead cuts inside the text that follows, with the break kept where the
  //    document put it.
  for (let at = fitting - 1; at >= 1; at -= 1) {
    if (inlines[at]?.t === 'br') {
      return { head: [...inlines.slice(0, at)], tail: inlines.slice(at + 1) };
    }
  }

  // 2 and 3. A sentence end, then whitespace, inside the text node that straddles the limit.
  const straddling = inlines[fitting];
  if (straddling?.t === 'text') {
    const split = cutText(block, inlines.slice(0, fitting), straddling, limit, measure);
    if (split !== undefined) {
      // Everything **after** the straddling node joins the tail. The first version returned
      // `cutText`'s tail unchanged, which silently dropped every inline past the one it cut — so a
      // paragraph of two text runs lost the second one entirely. C07's text-preservation property
      // found it; the fitting property could not, because a shorter part fits perfectly well.
      return { head: split.head, tail: [...split.tail, ...inlines.slice(fitting + 1)] };
    }
  }

  // The straddling node is atomic (`code`, `link`, `mention`, `time`) and something before it
  // fits: cut at the inline boundary.
  if (fitting > 0) {
    return { head: [...inlines.slice(0, fitting)], tail: inlines.slice(fitting) };
  }

  // 4. Nothing fits, so the first inline is longer than a whole part on its own.
  return splitOversizedInline(block, inlines, limit, measure);
}

/**
 * Cut the text node that straddles the limit, preferring a sentence end, then whitespace.
 *
 * `undefined` when not even one grapheme of it fits, which sends the caller to the inline
 * boundary instead.
 */
function cutText(
  block: Extract<Block, { t: 'p' | 'h' }>,
  before: readonly Inline[],
  node: TextInline,
  limit: number,
  measure: Measure,
): InlineCut | undefined {
  const clusters = graphemesOf(node.text);
  // The largest grapheme count that fits, by bisection: each probe is a render, so a linear scan
  // over a 4 000-character paragraph would be 4 000 renders.
  const fits = (count: number): boolean =>
    measure([withInlines(block, [...before, textWith(node, clusters.slice(0, count).join(''))])]) <=
    limit;
  let low = 0;
  let high = clusters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  if (low === 0) return undefined;

  const candidate = clusters.slice(0, low).join('');
  const boundary = lastSentenceEnd(candidate) ?? lastWhitespace(candidate) ?? candidate.length;
  const head = node.text.slice(0, boundary).replace(/\s+$/, '');
  const tail = node.text.slice(boundary).replace(/^\s+/, '');
  if (head === '') {
    // The only boundary found was at offset 0 — a paragraph opening with whitespace. Fall back to
    // the hard grapheme cut, which §3.5.4 makes the last resort for exactly this reason.
    return {
      head: [...before, textWith(node, candidate)],
      tail: [textWith(node, node.text.slice(candidate.length))],
    };
  }
  return {
    head: [...before, textWith(node, head)],
    tail: tail === '' ? [] : [textWith(node, tail)],
  };
}

/**
 * A single inline longer than a whole part.
 *
 * §3.5.4: "`link`, `mention`, `code` inline nodes are atomic. An atomic node longer than the limit
 * degrades to text." Degrading first and then cutting is the order that matters: cutting a `link`
 * in half would produce two anchors pointing at two halves of a URL, both broken, where one long
 * line of visible text is at least readable.
 */
function splitOversizedInline(
  block: Extract<Block, { t: 'p' | 'h' }>,
  inlines: readonly Inline[],
  limit: number,
  measure: Measure,
): InlineCut {
  const first = inlines[0];
  if (first === undefined) return { head: [], tail: [] };
  const degraded = degradeInline(first);
  if (degraded === undefined) {
    // A `br`, which is one character. If that does not fit there is nothing to do but hand it
    // back and let the caller stop.
    return { head: [], tail: inlines };
  }
  const split = cutText(block, [], degraded, limit, measure);
  if (split === undefined) return { head: [], tail: inlines };
  return { head: split.head, tail: [...split.tail, ...inlines.slice(1)] };
}

/** An atomic inline as the text a reader would see, or `undefined` for a `br`. */
function degradeInline(inline: Inline): TextInline | undefined {
  switch (inline.t) {
    case 'text':
      return inline;
    case 'code':
      // The monospace is lost and the characters are kept, which is the right way round for a
      // snippet somebody has to read.
      return { t: 'text', text: inline.text };
    case 'link': {
      const label = inline.c.map((run) => run.text).join('');
      // The **label only**, not the plain renderer's `label (url)`.
      //
      // Two reasons, and the first is the one that decides it. A link long enough to reach here is
      // longer than a whole part, so whatever this becomes gets cut — and cutting `label (url)`
      // leaves a *broken clickable URL* in one part and its tail in the next. A URL that is wrong
      // is worse than a URL that is absent: a member can ask for the link again, and cannot
      // un-click a bad one. The second is that a degradation driven by length must not **grow** the
      // node, which appending the URL does.
      //
      // An empty label leaves the URL as the only thing there is to show, which is the same
      // fallback `06` §3.5.2 gives an image with no `alt`.
      return { t: 'text', text: label === '' ? inline.url : label };
    }
    case 'mention':
    case 'time':
      return { t: 'text', text: inline.fallback };
    case 'br':
      return undefined;
  }
}

/** A text node with different text and the same marks. */
function textWith(node: TextInline, text: string): TextInline {
  return node.marks === undefined ? { t: 'text', text } : { t: 'text', text, marks: node.marks };
}

/** The offset just after the last `. ! ? 。` that is followed by whitespace, or `undefined`. */
function lastSentenceEnd(text: string): number | undefined {
  SENTENCE_END.lastIndex = 0;
  let found: number | undefined;
  for (const match of text.matchAll(SENTENCE_END)) {
    // After the punctuation, before the whitespace: the space belongs to the next part and is
    // trimmed there.
    found = match.index + 1;
  }
  return found;
}

/** The offset of the last whitespace run's start, or `undefined`. */
function lastWhitespace(text: string): number | undefined {
  for (let at = text.length - 1; at >= 0; at -= 1) {
    if (/\s/.test(text[at] ?? '')) return at;
  }
  return undefined;
}

/**
 * A fenced block split on line boundaries, `lang` kept on every piece (`06` §3.5.4).
 *
 * `lang` on every piece, not only the first: a syntax highlighter that lost the language halfway
 * through a snippet would show the second half unhighlighted, which reads as two different things
 * rather than one thing continued.
 */
function splitCode(block: Extract<Block, { t: 'code' }>, limit: number, measure: Measure): Block[] {
  const piece = (text: string): Block =>
    block.lang === undefined ? { t: 'code', text } : { t: 'code', lang: block.lang, text };
  const out: Block[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) out.push(piece(current.join('\n')));
    current = [];
  };
  for (const line of block.text.split('\n')) {
    if (current.length > 0 && measure([piece([...current, line].join('\n'))]) > limit) flush();
    if (measure([piece(line)]) > limit) {
      // One line longer than a whole part. §3.5.4: "A single long line gets a grapheme hard cut."
      flush();
      for (const chunk of hardCut(line, limit, (text) => measure([piece(text)]))) {
        out.push(piece(chunk));
      }
      continue;
    }
    current.push(line);
  }
  flush();
  return out.length > 0 ? out : [piece('')];
}

/**
 * `text` in chunks that each fit, cut only at grapheme boundaries.
 *
 * Grapheme clusters rather than code points, because a family emoji is five code points and one
 * cluster: cutting between them produces two broken glyphs, and on some clients a replacement
 * character. §3.5.4 names the segmenter for exactly this.
 */
function hardCut(text: string, limit: number, measure: (text: string) => number): string[] {
  const clusters = graphemesOf(text);
  const out: string[] = [];
  let at = 0;
  while (at < clusters.length) {
    let low = at;
    let high = clusters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (measure(clusters.slice(at, middle).join('')) <= limit) low = middle;
      else high = middle - 1;
    }
    if (low === at) {
      // Not even one cluster fits. Emit it anyway rather than loop: a limit this small is a
      // misconfigured profile, and a hang would take the worker with it.
      low = at + 1;
    }
    out.push(clusters.slice(at, low).join(''));
    at = low;
  }
  return out;
}

/**
 * A list split between items, with `start` continued (`06` §3.5.4).
 *
 * The continuation is what makes a split list readable: a second part that restarted at 1 would
 * tell a reader there are two lists, and a reply that says "step 1" twice is worse than one that
 * arrives in two messages.
 */
function splitList(block: Extract<Block, { t: 'list' }>, limit: number, measure: Measure): Block[] {
  const chunkOf = (items: readonly Block[][], startAt: number): Block => ({
    t: 'list',
    ordered: block.ordered,
    // Only ordered lists carry a number, and only when it is not the implicit 1 — the same rule
    // the parser applies, so a split list and an unsplit one compare equal where they should.
    ...(block.ordered && startAt !== 1 ? { start: startAt } : {}),
    items: items.map((item) => [...item]),
  });

  const out: Block[] = [];
  let current: Block[][] = [];
  let number = block.start ?? 1;
  let currentStart = number;
  const flush = (): void => {
    if (current.length > 0) out.push(chunkOf(current, currentStart));
    current = [];
    currentStart = number;
  };

  for (const item of block.items) {
    if (current.length > 0 && measure([chunkOf([...current, item], currentStart)]) > limit) flush();
    if (measure([chunkOf([item], currentStart)]) > limit) {
      // §3.5.4: "A single oversized item is split recursively." Its first piece keeps the marker
      // and the rest arrive as bare blocks — which is how a continued line reads, and avoids
      // showing the reader the same item number twice.
      flush();
      // Measured **as an item**, so the bullet and the indent are inside the budget. Splitting
      // against the bare limit and wrapping the first piece back into a list overflowed by exactly
      // the marker's width — which is what C07's fitting property caught.
      const asItem: Measure = (blocks) => measure([chunkOf([[...blocks]], number)]);
      const pieces = sliceBlocks(item, limit, asItem);
      const [head, ...continuation] = pieces;
      if (head !== undefined) out.push(chunkOf([head], number));
      for (const piece of continuation) out.push(...piece);
      number += 1;
      currentStart = number;
      continue;
    }
    current.push(item);
    number += 1;
  }
  flush();
  return out.length > 0 ? out : [chunkOf([], block.start ?? 1)];
}

/** A quote split across its children, each piece wrapped in a quote (`06` §3.5.4). */
function splitQuote(
  block: Extract<Block, { t: 'quote' }>,
  limit: number,
  measure: Measure,
): Block[] {
  // The children are sliced by the same packing loop as the document, then each slice is wrapped
  // — so a quote containing a long list or a fenced block is split by the rules for those, and
  // every piece is still a quote. A reader sees one quotation continued, not a quote and then
  // some loose text.
  //
  // The measure passed down **includes the wrapper**, because `> ` per line is two characters per
  // line in plain text: splitting against the bare limit and wrapping afterwards would overflow by
  // the prefix.
  const wrapped: Measure = (blocks) => measure([{ t: 'quote', c: [...blocks] }]);
  return sliceBlocks(block.c, limit, wrapped).map((group) => ({ t: 'quote', c: group }));
}

/** The grapheme clusters of `text`. */
export function graphemesOf(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of GRAPHEMES.segment(text)) out.push(segment);
  return out;
}
