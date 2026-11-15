/**
 * What to do when the markup cannot be represented (`06` §3.5.1–§3.5.2; `M3-T3`).
 *
 * Three substitutions, all of them lossy on purpose and none of them an error:
 *
 *  1. a **GFM table** becomes a `code` block of space-padded columns, which is readable in
 *     monospace on every platform the product targets (`06` §3.5.2);
 *  2. a **link whose scheme is not allowed** becomes its own label as text (`06` §3.5.1);
 *  3. a **whole document** that cannot be parsed becomes plain paragraphs split on blank lines
 *     (`06` §3.5.2's failure mode).
 *
 * The third is the one that matters operationally, and it is the reason this module is separate
 * from `parse.ts`: `06` §3.5.2 says "parsing never throws", and the way to make that true is to
 * have the fallback be a plain function the parser can call from a `catch` — not a branch inside
 * a recursive walk that has already half-built something.
 *
 * ## The degraded document is itself valid
 *
 * A fallback that produced something `RichTextSchema` rejects would be worse than the failure it
 * is covering: the reply would be dropped at the column rather than losing its formatting. So the
 * paragraph count is capped against `06` §3.5.1's node budget and the serialised size against
 * `02` §3.3.9's 64 KiB, and `degrade.test.ts` asserts the output parses for inputs that break both.
 */
import {
  type Block,
  RICH_TEXT_MAX_BYTES,
  RICH_TEXT_MAX_NODES,
  type RichText,
  type TextInline,
} from '@comvivo/core';

/**
 * Why a document was degraded. The `reason` label of `comvivo_richtext_degraded_total`.
 *
 * Six values, and they are worth distinguishing because each points somewhere different.
 * `too_large`, `output_too_large`, `nesting_limit` and `node_limit` are the model writing more
 * than the limits allow, which is a prompt problem — and they are four rather than one because
 * they are found at four different points: on the input's size, on its nesting, during the walk,
 * and after the tree is serialised. `parser_error` is a bug in this code or in
 * `mdast-util-from-markdown`, which is ours. `schema_invalid` is the backstop — the parser
 * produced a tree the schema refused, which is also ours and should never happen.
 */
export const DEGRADE_REASONS = [
  'too_large',
  'output_too_large',
  'nesting_limit',
  'node_limit',
  'parser_error',
  'schema_invalid',
] as const;

export type DegradeReason = (typeof DEGRADE_REASONS)[number];

/**
 * How many paragraphs a degraded document may hold.
 *
 * A paragraph is two nodes — the block and its one text run — so 2 500 of them is `06` §3.5.1's
 * whole 5 000-node budget. **Minus one**, because the truncation notice is itself a paragraph:
 * without the `- 1` a degraded 64 KiB reply came to 5 002 nodes and `RichTextSchema` refused it,
 * which is the one thing this function exists not to do. Found by the test that parses the
 * fallback's own output.
 */
export const MAX_DEGRADED_PARAGRAPHS = Math.floor(RICH_TEXT_MAX_NODES / 2) - 1;

/**
 * What one paragraph's JSON costs beyond its text: `{"t":"p","c":[{"t":"text","text":""}]}`.
 *
 * Counted rather than estimated, because the estimate was wrong in the dangerous direction. The
 * first version reserved an eighth of the cap for "structure", which is 8 KiB — and 2 499
 * paragraphs of structure is 100 KiB, so a degraded reply made of many short lines sailed past the
 * byte cap and `RichTextSchema` refused it.
 */
const PARAGRAPH_OVERHEAD_BYTES = JSON.stringify({ t: 'p', c: [{ t: 'text', text: '' }] }).length;

/** `{"v":1,"blocks":[]}` plus a comma between paragraphs. */
const DOCUMENT_OVERHEAD_BYTES = JSON.stringify({ v: 1, blocks: [] }).length;

/**
 * How many levels of block nesting the **input** may declare before it is refused unparsed.
 *
 * `06` §3.5.1 allows 3 for a list and 2 for a quote, so 64 is twenty times anything legitimate.
 * It exists because `mdast-util-from-markdown` is **quadratic** in container nesting, measured at
 * `M3-T3` on `'- '.repeat(n)`:
 *
 * | depth | input | parse |
 * |---|---|---|
 * | 500 | 1 KB | 83 ms |
 * | 1 000 | 2 KB | 299 ms |
 * | 2 000 | 4 KB | 1 205 ms |
 * | 4 000 | 8 KB | 4 559 ms |
 * | 6 000 | 12 KB | 9 885 ms |
 *
 * Four times the time per doubling of depth. Extrapolated to `06` §3.5.2's 64 KiB input cap that
 * is about **five minutes** for 32 768 levels — inside every other limit, and on the turn's
 * critical path, where it means the member gets nothing and `05` §5's 60 s deadline fires on a
 * worker that is still busy. "Parsing never throws" was true of that input; "parsing answers" was
 * not, and the second is what a member experiences.
 *
 * Checked by counting leading block markers rather than by a timeout, because a timeout cannot be
 * made deterministic and this can: the scan is one pass with no allocation, and at depth 64 the
 * parse it allows is about a millisecond.
 */
export const MAX_INPUT_NESTING = 64;

/**
 * The deepest run of block markers at the start of any line.
 *
 * Counts `>` and a list bullet (`-`, `*`, `+` or `1.`/`1)`) **followed by a space**, which is what
 * CommonMark needs to open a container. The space matters: `-----` is a thematic break and must
 * count as zero, while `- - - - x` is four nested lists and counts as four.
 *
 * Stops as soon as the limit is passed, so a hostile input costs one partial line rather than a
 * full scan.
 */
export function maxLeadingNesting(input: string, limit = MAX_INPUT_NESTING): number {
  let worst = 0;
  for (const line of input.split('\n')) {
    const depth = leadingNesting(line, limit);
    if (depth > worst) worst = depth;
    if (worst > limit) return worst;
  }
  return worst;
}

/** One line's leading container markers. */
function leadingNesting(line: string, limit: number): number {
  let depth = 0;
  let at = 0;
  while (at < line.length && depth <= limit) {
    const char = line[at];
    if (char === ' ' || char === '\t') {
      at += 1;
      continue;
    }
    if (char === '>') {
      depth += 1;
      at += 1;
      continue;
    }
    if ((char === '-' || char === '*' || char === '+') && isSpace(line[at + 1])) {
      depth += 1;
      at += 2;
      continue;
    }
    const afterDigits = skipDigits(line, at);
    if (
      afterDigits > at &&
      (line[afterDigits] === '.' || line[afterDigits] === ')') &&
      isSpace(line[afterDigits + 1])
    ) {
      depth += 1;
      at = afterDigits + 2;
      continue;
    }
    break;
  }
  return depth;
}

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t';
}

function skipDigits(line: string, from: number): number {
  let at = from;
  while (at < line.length) {
    const char = line[at];
    if (char === undefined || char < '0' || char > '9') break;
    at += 1;
  }
  return at;
}

/**
 * How many emphasis delimiter runs the input may hold.
 *
 * The second super-linear behaviour, and it is not nesting of *containers* — it is the number of
 * resolvable emphasis pairs, which micromark resolves into a tree one level deep per pair.
 * Measured at `M3-T3` on `'*a '.repeat(n) + 'b' + ' a*'.repeat(n)`:
 *
 * | runs | input | parse |
 * |---|---|---|
 * | 256 | 1.5 KB | 38 ms |
 * | 512 | 3 KB | 85 ms |
 * | 1 024 | 6 KB | 230 ms |
 * | 2 048 | 12 KB | 944 ms |
 * | 4 096 | 24 KB | 4 527 ms |
 * | 8 000 | 48 KB | **27 916 ms**, then `parser_error` from the walk's own stack |
 *
 * Quadratic again. 1 024 runs is 512 complete spans — a reply with one bold or italic phrase every
 * 130 characters of a full 64 KiB — so it is generous for anything a model writes to a family and
 * bounds the worst case at about 230 ms.
 *
 * `_` and `~` are counted too. Neither reproduced the cost (`'_a '` ×8 000 is 43 ms, because `_`
 * needs a word boundary to open; `~` ×8 000 is 46 ms), but they are the same class of delimiter and
 * the cap is far above legitimate use, so including them costs nothing and removes a shape nobody
 * has measured. Backticks, brackets, angles and pipes were each measured at 8 000 runs — 72, 42,
 * 39 and 19 ms — and are not capped.
 */
export const MAX_EMPHASIS_RUNS = 1024;

/** The emphasis-class delimiters (`06` §3.5.2 maps all three to a mark). */
const EMPHASIS_DELIMITERS = new Set(['*', '_', '~']);

/**
 * How many runs of emphasis delimiters `input` holds, stopping once `limit` is passed.
 *
 * A "run" is a maximal sequence of the same delimiter: `**bold**` is two. One pass, no allocation.
 */
export function emphasisRuns(input: string, limit = MAX_EMPHASIS_RUNS): number {
  let runs = 0;
  let previous = '';
  for (let at = 0; at < input.length; at += 1) {
    const char = input[at] ?? '';
    if (EMPHASIS_DELIMITERS.has(char) && char !== previous) {
      runs += 1;
      if (runs > limit) return runs;
    }
    previous = char;
  }
  return runs;
}

/** A blank line, allowing the whitespace a model actually emits between paragraphs. */
const BLANK_LINE = /\n[ \t]*\n/;

/** The notice appended when the fallback itself had to drop something. */
export const DEGRADE_TRUNCATION_NOTICE = '…';

/**
 * What a string costs **inside JSON**, which is not what it costs as UTF-8.
 *
 * A quote, a backslash or a control character becomes an escape sequence, and a run of them can
 * double the length — so a fallback budgeted in plain UTF-8 bytes overshoots on exactly the input
 * that reached the fallback in the first place. `JSON.stringify` is the authority on its own
 * encoding; the `- 2` drops the quotes it adds, which the paragraph overhead already counted.
 */
function escapedLength(text: string): number {
  return utf8Length(JSON.stringify(text)) - 2;
}

/**
 * `06` §3.5.2's failure mode: plain paragraphs, split on blank lines.
 *
 * Never throws and always returns a document `RichTextSchema` accepts, because the caller is
 * already in a failure path and has nothing better to fall back to.
 */
export function degradeToPlain(input: string): RichText {
  const paragraphs: Block[] = [];
  // The wrapper, plus the notice paragraph that may still be appended: both are reserved up front,
  // so the loop never has to give back space it has already spent.
  let bytes =
    DOCUMENT_OVERHEAD_BYTES + PARAGRAPH_OVERHEAD_BYTES + utf8Length(DEGRADE_TRUNCATION_NOTICE);
  let dropped = false;

  for (const chunk of input.split(BLANK_LINE)) {
    const text = chunk.trim();
    if (text === '') continue;
    if (paragraphs.length >= MAX_DEGRADED_PARAGRAPHS) {
      dropped = true;
      break;
    }
    const remaining = RICH_TEXT_MAX_BYTES - bytes - PARAGRAPH_OVERHEAD_BYTES - 1;
    if (remaining <= 0) {
      dropped = true;
      break;
    }
    const kept = truncateToJsonBytes(text, remaining);
    if (kept !== text) dropped = true;
    // `+ 1` for the comma that separates this paragraph from the next.
    bytes += PARAGRAPH_OVERHEAD_BYTES + escapedLength(kept) + 1;
    paragraphs.push({ t: 'p', c: [{ t: 'text', text: kept }] });
    if (kept !== text) break;
  }

  if (dropped) {
    // A visible marker, rather than silently stopping mid-sentence. One character, so it cannot
    // itself push the document over a budget that has just been reached.
    paragraphs.push({ t: 'p', c: [{ t: 'text', text: DEGRADE_TRUNCATION_NOTICE }] });
  }
  // An input of only whitespace degrades to one empty paragraph rather than to no blocks, because
  // `{v:1, blocks: []}` renders as nothing at all — and a reply that arrives as silence is
  // indistinguishable from the bot having ignored the member.
  if (paragraphs.length === 0) paragraphs.push({ t: 'p', c: [] });
  return { v: 1, blocks: paragraphs };
}

/** Bytes a string takes as UTF-8, without allocating a buffer. */
export function utf8Length(text: string): number {
  let length = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code < 0x10000) length += 3;
    else length += 4;
  }
  return length;
}

/**
 * The longest prefix of `text` that fits in `limit` bytes **once JSON-escaped**, cut on a
 * code-point boundary.
 *
 * Two decisions, each of which was a bug first.
 *
 * **Escaped**, not plain UTF-8: a `"` is one byte of text and two of JSON, so a budget counted in
 * UTF-8 overshoots by 2× on a reply full of quoted strings — and 64 KiB of quotes degraded to a
 * 128 KiB document the column refused. Every character's cost comes from `JSON.stringify` itself
 * rather than from a table of the escapes, because the table is the thing that goes out of date.
 *
 * **Code points**, not bytes: cutting a UTF-8 sequence in half produces a replacement character,
 * and `for…of` iterates code points, so an emoji is never split into surrogates. Grapheme clusters
 * are the splitter's problem (`M3-T5`); here the input is already a failure and a name ending
 * mid-combining-mark is not the thing to optimise for.
 */
export function truncateToJsonBytes(text: string, limit: number): string {
  if (limit <= 0) return '';
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = escapedLength(character);
    if (bytes + size > limit) return text.slice(0, end);
    bytes += size;
    end += character.length;
  }
  return text;
}

/**
 * A GFM table as a `code` block of space-padded columns (`06` §3.5.2).
 *
 * Monospace, because that is the only way a table survives a chat client: Telegram, Discord, Slack
 * and Signal all render a fenced block in a fixed-width font and none of them has a table
 * primitive.
 *
 * Column widths are measured in **grapheme clusters**, not code points. The difference is the
 * whole point of padding: a family emoji is five code points and one cluster, so a code-point
 * count would pad its column four characters too wide and every row below it would be out of
 * line. `06` §3.5.4's splitter needs the same measure ("grapheme-safe"), which is why the
 * segmenter is built once here rather than per call.
 *
 * No `lang`, deliberately: a syntax highlighter colouring a table is worse than no highlighting.
 */
export function tableToCodeBlock(
  rows: readonly (readonly string[])[],
  options: { readonly header?: boolean } = {},
): Block {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (width === 0) return { t: 'code', text: '' };
  const columns: number[] = [];
  for (let index = 0; index < width; index += 1) {
    columns.push(Math.max(0, ...rows.map((row) => graphemeLength(row[index] ?? ''))));
  }
  const lines = rows.map((row) =>
    columns
      .map((size, index) => padTo(row[index] ?? '', size))
      // Two spaces between columns: one reads as a single wide word in a proportional font, and
      // a `|` would look like markup the platform had failed to render.
      .join('  ')
      .trimEnd(),
  );
  // A rule under the header, because padding alone loses the one piece of a table's meaning that
  // is not in its cells: which row names the columns. Without it a two-row table reads as four
  // unrelated values, and the reader has to guess.
  if (options.header === true && lines.length > 1) {
    lines.splice(1, 0, columns.map((size) => '─'.repeat(Math.max(1, size))).join('  '));
  }
  return { t: 'code', text: lines.join('\n') };
}

/**
 * The segmenter the column widths are measured with.
 *
 * `'en'` explicitly rather than the host's locale: grapheme segmentation is locale-independent in
 * practice, and a table that aligned differently on a host set to `tr-TR` would be a rendering
 * difference nobody could reproduce. The same reason every other formatter in this repository
 * takes its locale as an argument.
 */
const GRAPHEMES = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** How many grapheme clusters `text` has — what a monospace column actually counts. */
export function graphemeLength(text: string): number {
  let count = 0;
  for (const _ of GRAPHEMES.segment(text)) count += 1;
  return count;
}

/** Pad to `size` grapheme clusters. */
function padTo(cell: string, size: number): string {
  const length = graphemeLength(cell);
  return length >= size ? cell : cell + ' '.repeat(size - length);
}

/**
 * A link that may not be stored as a link, as the text it was labelled with (`06` §3.5.1).
 *
 * The **label**, not the URL: `06` §3.5.1 says other schemes "are degraded to text", and a
 * `javascript:` URL shown to a member as text is both useless and an invitation. When the label is
 * empty there is nothing honest to show, so the node disappears — which is the same outcome as a
 * link whose text the model forgot to write.
 */
export function degradeLinkToText(label: readonly TextInline[]): TextInline[] {
  return label.filter((run) => run.text !== '');
}
