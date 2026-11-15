/**
 * Model output → the RichText AST (`06` §3.5.2; `M3-T3`).
 *
 * `mdast-util-from-markdown` with three GFM extensions, then a total walk from mdast to `06`
 * §3.5.1's AST, then the custom syntax, then the schema.
 *
 * ## The contract is "never throws"
 *
 * `06` §3.5.2 makes that a requirement rather than a quality: the alternative to a reply that lost
 * its bold is **no reply**, and the input is a language model's prose, which is the least
 * predictable string in the system. So every failure lands in the same place — `degradeToPlain` —
 * and `parse.prop.test.ts` asserts totality over fuzz rather than over a list of cases somebody
 * thought of.
 *
 * Four things degrade the whole document, and each one is counted separately on
 * `comvivo_richtext_degraded_total{reason}` because each points somewhere different:
 *
 * | reason | cause | whose problem |
 * |---|---|---|
 * | `too_large` | over 64 KiB of markdown | the prompt's output budget |
 * | `nesting_limit` | over 64 levels of block nesting, or over 1 024 emphasis runs; refused unparsed | the prompt's output budget |
 * | `output_too_large` | the markdown fits, the **AST's JSON** does not | the prompt's output budget |
 * | `node_limit` | over 5 000 AST nodes | the prompt's output budget |
 * | `parser_error` | a throw from micromark or from this walk | ours |
 * | `schema_invalid` | the walk produced a tree `RichTextSchema` refused | ours, and unreachable |
 *
 * ## Over-deep nesting is clamped, not degraded
 *
 * `06` §3.5.1 caps list nesting at 3 and quote nesting at 2. §3.5.2's failure mode mentions "a
 * node limit exceeded", and treating a fourth-level bullet as a reason to throw away the whole
 * document's formatting would be a bad trade for a member: one over-nested list costs them every
 * heading, link and mention in the reply. So the walk **clamps** — a list deeper than the limit
 * contributes its items to the deepest allowed level, which is exactly what the Telegram renderer
 * already does with nested quotes ("nested quotes flattened", `06` §3.5.3). Recorded in `STATUS`
 * → Plan changes.
 *
 * ## Why the node budget is counted during the walk
 *
 * `RichTextSchema` would catch an over-budget document at the end, but by then the walk has
 * allocated it. A 64 KiB input of `- a` repeated is 16 000 list items; counting as we go lets the
 * walk stop at 5 000 nodes and degrade, instead of building a tree it is about to throw away.
 */
import {
  type Block,
  type Inline,
  isAllowedLinkUrl,
  type Mark,
  RICH_TEXT_MAX_BYTES,
  RICH_TEXT_MAX_LIST_DEPTH,
  RICH_TEXT_MAX_NODES,
  RICH_TEXT_MAX_QUOTE_DEPTH,
  type RichText,
  RichTextSchema,
  type TextInline,
} from '@comvivo/core';
import type { Logger } from '@comvivo/shared';
import { getMetrics } from '@comvivo/shared/observability';
import type {
  Heading,
  List,
  Nodes,
  PhrasingContent,
  Root,
  RootContent,
  TableCell,
  TableRow,
} from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import {
  applyCustomSyntax,
  type CustomSyntaxOptions,
  canonicalMarks,
  textNode,
} from './custom-syntax.js';
import {
  type DegradeReason,
  degradeLinkToText,
  degradeToPlain,
  emphasisRuns,
  MAX_EMPHASIS_RUNS,
  MAX_INPUT_NESTING,
  maxLeadingNesting,
  tableToCodeBlock,
  utf8Length,
} from './degrade.js';

export interface ParseOptions extends CustomSyntaxOptions {
  readonly logger?: Logger | undefined;
}

export interface ParseResult {
  readonly richText: RichText;
  /** `undefined` when the document parsed. Otherwise why it did not. */
  readonly degraded?: DegradeReason | undefined;
}

/**
 * The micromark and mdast extension sets, built once.
 *
 * Once, because `gfmTable()` and the rest allocate an extension object per call and `parse` runs
 * on every model reply. They are frozen configuration, not state — none of the three carries
 * per-document data, which is what makes sharing them safe.
 *
 * Three extensions, named individually rather than taking `micromark-extension-gfm`: that bundle
 * also brings footnotes and task lists, and `06` §3.5.1's AST has no node for either — so the
 * model could have written syntax the parser understood and the AST silently dropped.
 */
const MICROMARK_EXTENSIONS = [gfmStrikethrough(), gfmAutolinkLiteral(), gfmTable()];
const MDAST_EXTENSIONS = [
  gfmStrikethroughFromMarkdown(),
  gfmAutolinkLiteralFromMarkdown(),
  gfmTableFromMarkdown(),
];

/** Parse model output. Never throws (`06` §3.5.2). */
export function parseModelOutput(markdown: string, options: ParseOptions): ParseResult {
  if (utf8Length(markdown) > RICH_TEXT_MAX_BYTES) return degrade(markdown, 'too_large', options);
  // Before `fromMarkdown`, because the thing being avoided is `fromMarkdown` itself: it is
  // quadratic in container nesting, and at the 64 KiB cap above that is about five minutes.
  // `MAX_INPUT_NESTING` carries the measurement.
  if (maxLeadingNesting(markdown) > MAX_INPUT_NESTING) {
    return degrade(markdown, 'nesting_limit', options);
  }
  // The same reason, for the other super-linear shape: many emphasis pairs nest one level each,
  // and 8 000 of them took 28 seconds before the walk's own stack gave out. `MAX_EMPHASIS_RUNS`
  // carries that measurement. Reported under the same reason because it is the same cause from an
  // operator's point of view — the model wrote something too deeply structured to parse.
  if (emphasisRuns(markdown) > MAX_EMPHASIS_RUNS) {
    return degrade(markdown, 'nesting_limit', options);
  }

  let built: RichText;
  try {
    const root: Root = fromMarkdown(markdown, {
      extensions: MICROMARK_EXTENSIONS,
      mdastExtensions: MDAST_EXTENSIONS,
    });
    const walker = new Walker(options);
    built = { v: 1, blocks: walker.blocks(root.children) };
    if (walker.overBudget) return degrade(markdown, 'node_limit', options);
  } catch {
    // The error itself is deliberately not logged beyond its presence: micromark's messages quote
    // the input, which is message content (`01` §11.7). The reason label and the `parser_error`
    // count are what an operator acts on, and the input is available under
    // `COMVIVO_DEBUG_CONTENT` like every other piece of content.
    return degrade(markdown, 'parser_error', options);
  }

  // The **built** document can be over `02` §3.3.9's cap even when the markdown was not: the AST's
  // JSON costs about 30 bytes of structure per node, so 40 KiB of short lines becomes 90 KiB of
  // document. Measured separately from `schema_invalid` because it is not a bug — it is the same
  // "the model wrote too much" as `too_large`, found one step later — and filing it as "the parser
  // produced a tree its own schema rejects" would send somebody looking for a defect here.
  if (utf8Length(JSON.stringify(built)) > RICH_TEXT_MAX_BYTES) {
    return degrade(markdown, 'output_too_large', options);
  }
  // The backstop. Unreachable if the walk is right, which is why it is a *check* rather than a
  // cast: a tree that fails here would otherwise be rejected at the column, and a reply that
  // vanishes is worse than one that lost its formatting.
  const parsed = RichTextSchema.safeParse(built);
  if (!parsed.success) return degrade(markdown, 'schema_invalid', options);
  return { richText: built };
}

function degrade(markdown: string, reason: DegradeReason, options: ParseOptions): ParseResult {
  getMetrics().counter('richtext_degraded_total').inc({ reason });
  options.logger?.warn('channel.richtext_degraded', {
    detail: { reason, bytes: utf8Length(markdown) },
  });
  return { richText: degradeToPlain(markdown), degraded: reason };
}

/** How deep the walk is, per `06` §3.5.1 limit. */
interface Depths {
  readonly list: number;
  readonly quote: number;
}

const TOP: Depths = { list: 0, quote: 0 };

/**
 * The mdast → RichText walk.
 *
 * A class, for one reason: the node budget is a counter shared by every level of a recursion that
 * returns values. Threading it through as an argument would make every helper return a pair, and
 * the thing that actually matters — that the count is checked in one place — would be spread
 * across a dozen call sites.
 */
class Walker {
  #nodes = 0;
  readonly #options: ParseOptions;

  constructor(options: ParseOptions) {
    this.#options = options;
  }

  /**
   * Whether the walk has run past `06` §3.5.1's node budget.
   *
   * Counted over the nodes **produced**, not the mdast nodes visited, and that distinction was a
   * bug before it was a comment. `'a\n'.repeat(3000)` is one mdast `text` node — micromark keeps
   * soft breaks inside the value — which `softBreaks` expands into 5 999 AST nodes. Counting
   * visits said 2; the schema then counted 6 000 and refused, so a document that was plainly over
   * the node limit was reported as `schema_invalid`: "this parser produced a tree its own schema
   * rejects", which is a bug report about us rather than about the reply's size.
   */
  get overBudget(): boolean {
    return this.#nodes > RICH_TEXT_MAX_NODES;
  }

  blocks(nodes: readonly RootContent[], depths: Depths = TOP): Block[] {
    const out: Block[] = [];
    for (const node of nodes) {
      if (this.overBudget) return out;
      const produced = this.#block(node, depths);
      this.#nodes += produced.length;
      out.push(...produced);
    }
    return out;
  }

  /**
   * One mdast block → zero or more AST blocks.
   *
   * Zero for the nodes that carry no content of their own: a link-reference `definition` is
   * markdown bookkeeping, and `yaml` front matter is not enabled but costs nothing to ignore.
   * Several for an over-deep list, whose items are spliced into the level above.
   */
  #block(node: RootContent, depths: Depths): Block[] {
    switch (node.type) {
      case 'paragraph':
        return [{ t: 'p', c: this.#inlines(node.children) }];
      case 'heading':
        return [{ t: 'h', level: headingLevel(node), c: this.#inlines(node.children) }];
      case 'code':
        return [codeBlock(node.lang ?? undefined, node.value)];
      case 'thematicBreak':
        return [{ t: 'hr' }];
      case 'blockquote':
        return this.#quote(node.children, depths);
      case 'list':
        return this.#list(node, depths);
      case 'table':
        // `06` §3.5.2: parsed only so it can be degraded. mdast puts the header first, which is
        // the one piece of a table's meaning that space-padding alone would throw away.
        return [
          tableToCodeBlock(
            node.children.map((row) => this.#cells(row)),
            { header: node.children.length > 1 },
          ),
        ];
      case 'html':
        // `06` §3.5.2: "Raw HTML becomes literal text." A paragraph rather than a code block,
        // because the model writing `<br>` meant a line break, not a snippet to be admired.
        return [{ t: 'p', c: [{ t: 'text', text: node.value }] }];
      // Everything below carries no block-level content of its own at this position, and each is
      // listed rather than left to a `default` so a dependency bump that adds a node type is a
      // lint error here instead of a silently dropped construct.
      //
      // `definition` is a link-reference definition: markdown bookkeeping with nothing to show.
      // `footnoteDefinition` and `yaml` belong to extensions this parser does not enable
      // (`06` §3.5.2 names three, and neither footnotes nor front matter is among them), so they
      // cannot occur — they are here because `RootContent` declares them.
      case 'definition':
      case 'footnoteDefinition':
      case 'yaml':
        return [];
      // mdast's `RootContent` is a union of **block and phrasing** content, so these sixteen are
      // declared at this position and cannot reach it: a `text` or a `strong` only ever arrives
      // through `#inlines`, and a `listItem`, `tableRow` or `tableCell` is read by its parent.
      // Returning nothing is the safe answer if the tree ever did hand one over.
      case 'break':
      case 'delete':
      case 'emphasis':
      case 'footnoteReference':
      case 'image':
      case 'imageReference':
      case 'inlineCode':
      case 'link':
      case 'linkReference':
      case 'listItem':
      case 'strong':
      case 'tableCell':
      case 'tableRow':
      case 'text':
        return [];
    }
  }

  /** A blockquote, clamped at `06` §3.5.1's depth of 2 (see the module header). */
  #quote(children: readonly RootContent[], depths: Depths): Block[] {
    const depth = depths.quote + 1;
    if (depth > RICH_TEXT_MAX_QUOTE_DEPTH) {
      // Flattened into the quote above, which is what `06` §3.5.3's Telegram and Discord renderers
      // do with nested quotes anyway — so this makes the AST match what every platform shows.
      return this.blocks(children, depths);
    }
    return [{ t: 'quote', c: this.blocks(children, { ...depths, quote: depth }) }];
  }

  /** A list, clamped at `06` §3.5.1's depth of 3. */
  #list(node: List, depths: Depths): Block[] {
    const depth = depths.list + 1;
    const inner: Depths = { ...depths, list: Math.min(depth, RICH_TEXT_MAX_LIST_DEPTH) };
    const items = node.children.map((item) => this.blocks(item.children, inner));
    if (depth > RICH_TEXT_MAX_LIST_DEPTH) {
      // The items join the level above as plain blocks. Their own bullets are lost, which is the
      // price of keeping the other 99% of the reply.
      return items.flat();
    }
    const ordered = node.ordered === true;
    // `start` only when it is meaningful: mdast reports `1` for every ordered list, and carrying
    // that would make `1.` and an explicit `1.` differ in the AST for no reason a reader could see.
    const start =
      ordered && typeof node.start === 'number' && node.start !== 1 ? node.start : undefined;
    return [{ t: 'list', ordered, ...(start === undefined ? {} : { start }), items }];
  }

  /** A table row's cells, as the plain text each one renders to. */
  #cells(row: TableRow): string[] {
    return row.children.map((cell: TableCell) => plainOf(this.#inlines(cell.children)));
  }

  /** Phrasing content → inlines, with the custom syntax applied and adjacent runs merged. */
  #inlines(nodes: readonly PhrasingContent[], marks: readonly Mark[] = []): Inline[] {
    const out: Inline[] = [];
    for (const node of nodes) {
      if (this.overBudget) break;
      out.push(...this.#inline(node, marks));
    }
    // Applied here — once per phrasing run, on the finished nodes — because `06` §3.5.2 says
    // "after parsing, to `text` nodes only". A run is the smallest unit that still has its marks.
    const merged = coalesce(applyCustomSyntax(out, this.#options));
    // Counted after merging, so the budget is spent on the tree that is actually built.
    this.#nodes += merged.length;
    return merged;
  }

  #inline(node: PhrasingContent, marks: readonly Mark[]): Inline[] {
    switch (node.type) {
      case 'text':
        // `06` §3.5.2: "Soft line breaks become `br`." A newline inside a paragraph is what a
        // member typed and what a model copies; treating it as whitespace is the single most
        // visible way a reply comes out wrong.
        return softBreaks(node.value, marks);
      case 'strong':
        return this.#inlines(node.children, [...marks, 'b']);
      case 'emphasis':
        return this.#inlines(node.children, [...marks, 'i']);
      case 'delete':
        return this.#inlines(node.children, [...marks, 's']);
      case 'inlineCode':
        // No marks: `06` §3.5.1 gives inline code its own node precisely because nothing nests
        // inside it on any platform.
        return [{ t: 'code', text: node.value }];
      case 'break':
        return [{ t: 'br' }];
      case 'link':
        return this.#link(node.url, this.#inlines(node.children, marks));
      case 'image': {
        // `06` §3.5.2: `![alt](u)` becomes `link(alt → u)`. An empty alt would make a link with no
        // label, which renders as nothing — so the URL stands in for it.
        const label =
          node.alt === null || node.alt === undefined || node.alt === '' ? node.url : node.alt;
        return this.#link(node.url, [textNode(label, canonicalMarks([...marks]))]);
      }
      case 'html':
        return [textNode(node.value, canonicalMarks([...marks]))];
      case 'linkReference':
        // A reference whose `definition` was dropped. Its label is what the model wrote, so it is
        // the honest thing to show; the alternative is a reply with a gap in the middle of a
        // sentence.
        return this.#inlines(node.children, marks);
      case 'imageReference':
        // The same, but an image reference has no children — only an `alt`, which is the label the
        // model wrote and the only thing there is to show.
        return node.alt === null || node.alt === undefined || node.alt === ''
          ? []
          : [textNode(node.alt, canonicalMarks([...marks]))];
      case 'footnoteReference':
        // Footnotes are not among `06` §3.5.2's three extensions, so micromark never produces
        // this — it is declared on `PhrasingContent` and listed so a dependency bump that enables
        // it is a lint error rather than a reference that vanishes mid-sentence.
        return [];
    }
  }

  /** A link, or its label as text when `06` §3.5.1 does not allow the scheme. */
  #link(url: string, label: readonly Inline[]): Inline[] {
    const runs = flattenLabel(label, url);
    // `core`'s own predicate, so the allowlist, the control-character check and the length cap
    // have one implementation — a second copy here is how two copies of an allowlist come to
    // disagree about `java\tscript:`. A predicate rather than the document parse this used to do:
    // worth about 0.13 ms on a markup-dense 4 000-character reply (measured, `M3-T3`), which is
    // small — but it scaled with the **number** of links rather than their length, which is the
    // wrong shape for a check on a hot path.
    if (!isAllowedLinkUrl(url)) return degradeLinkToText(runs);
    return [{ t: 'link', url, c: runs }];
  }
}

/**
 * Merge adjacent `text` runs that carry the same marks.
 *
 * mdast hands back a run per construct, so `a <b>c</b> d` arrives as five text nodes and
 * `a[^1]` as two. Unmerged they cost five AST nodes against `06` §3.5.1's budget and make every
 * renderer emit five tags where one belongs — `<b>a</b><b>b</b>` instead of `<b>ab</b>`, which is
 * not just ugly: Telegram counts the markup against the message length.
 *
 * Only `text` merges. Inline code, links and mentions are distinct nodes by construction.
 */
function coalesce(inlines: readonly Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const inline of inlines) {
    const previous = out.at(-1);
    if (
      inline.t === 'text' &&
      previous !== undefined &&
      previous.t === 'text' &&
      sameMarks(previous.marks, inline.marks)
    ) {
      out[out.length - 1] = textNode(previous.text + inline.text, previous.marks);
      continue;
    }
    out.push(inline);
  }
  return out;
}

function sameMarks(a: readonly Mark[] | undefined, b: readonly Mark[] | undefined): boolean {
  // Both are canonically sorted by `textNode`, so equality is positional.
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((mark, index) => mark === right[index]);
}

/**
 * A link's label as text runs, with nothing lost.
 *
 * `06` §3.5.1 types a link's children as `TextInline[]` only, so inline code, an image or a nested
 * mention inside a label has to become text. **Filtering** them out — which is what this did
 * first — produced `[`npm i`](https://x)` as a link with no label at all, and a link with no
 * label renders as nothing: the reply lost the words and kept the URL it could not show.
 *
 * An empty label falls back to the URL, for the same reason `06` §3.5.2 gives an image with no
 * `alt` its URL: a link nobody can see is worse than an ugly one.
 */
function flattenLabel(label: readonly Inline[], url: string): TextInline[] {
  const runs: TextInline[] = [];
  for (const inline of label) {
    switch (inline.t) {
      case 'text':
        runs.push(inline);
        break;
      case 'code':
        // The monospace is lost and the words are kept, which is the right way round.
        runs.push({ t: 'text', text: inline.text });
        break;
      case 'link':
        // CommonMark forbids a link inside a link, so this is an image that became one.
        runs.push(...inline.c);
        break;
      case 'mention':
      case 'time':
        runs.push({ t: 'text', text: inline.fallback });
        break;
      case 'br':
        // A label spanning two lines is one label; the break would split the anchor on every
        // platform that has one.
        runs.push({ t: 'text', text: ' ' });
        break;
    }
  }
  const merged = coalesce(runs).filter(
    (run): run is TextInline => run.t === 'text' && run.text !== '',
  );
  return merged.length > 0 ? merged : [{ t: 'text', text: url }];
}

/** `06` §3.5.2: headings h4–h6 become level 3. */
function headingLevel(node: Heading): 1 | 2 | 3 {
  return node.depth <= 1 ? 1 : node.depth === 2 ? 2 : 3;
}

/** A fenced block, with `lang` kept only when `06` §3.5.1's pattern accepts it. */
function codeBlock(lang: string | undefined, text: string): Block {
  // Lower-cased first, because a model writes ```JavaScript about as often as ```javascript and
  // the pattern is lower-case only. An info string with arguments (```js {1,3}) keeps its first
  // word, which is what every highlighter reads.
  const first = lang?.trim().split(/\s+/)[0]?.toLowerCase();
  const kept =
    first !== undefined && first !== '' && /^[a-z0-9+#-]{1,20}$/.test(first) ? first : undefined;
  return { t: 'code', ...(kept === undefined ? {} : { lang: kept }), text };
}

/** Split a text value on its newlines, putting a `br` between the pieces. */
function softBreaks(value: string, marks: readonly Mark[]): Inline[] {
  const pieces = value.split('\n');
  const canonical = canonicalMarks([...marks]);
  const out: Inline[] = [];
  pieces.forEach((piece, index) => {
    if (index > 0) out.push({ t: 'br' });
    if (piece !== '') out.push(textNode(piece, canonical));
  });
  return out;
}

/** The plain text of a run of inlines, for a table cell. */
function plainOf(inlines: readonly Inline[]): string {
  return inlines.map(plainOfInline).join('');
}

/**
 * One inline as plain text.
 *
 * Split out of the `map` above because a `switch` as a callback body reads to Biome's
 * `useIterableCallbackReturn` as a path with no `return` — which, for an exhaustive switch over a
 * discriminated union, it is not. A named function with a declared return type says so to the
 * compiler and to a reader.
 */
function plainOfInline(inline: Inline): string {
  switch (inline.t) {
    case 'text':
    case 'code':
      return inline.text;
    case 'link':
      return inline.c.map((run) => run.text).join('');
    case 'mention':
    case 'time':
      return inline.fallback;
    case 'br':
      // A newline inside a cell would break the column alignment the code block exists for.
      return ' ';
  }
}

/** Every mdast node type this walk knows how to ignore, for the test that keeps the list honest. */
export const IGNORED_MDAST_TYPES: readonly Nodes['type'][] = ['definition', 'footnoteDefinition'];
