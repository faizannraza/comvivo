/**
 * The RichText AST and its schema (`06` §3.5.1; `02` §3.3.9 for the column).
 *
 * ## Why this lives in `core` rather than in `channel-sdk`
 *
 * `06` §3.5.1 puts the AST *types* in `channel-sdk/src/richtext/ast.ts`, next to the parser and the
 * per-platform renderers that are the only code which builds or consumes them. `02` §3.3.9 says
 * the *schema* is `RichTextSchema` from `@comvivo/core/domain/rich-text`, because
 * `messages.rich_text` is a column and `packages/storage` may not depend on a channel package
 * (`01` §4 as amended by A11: storage → core, never storage → channels).
 *
 * Two homes for one type is the one outcome worth avoiding, so the type lives here with the schema
 * and `channel-sdk` imports it. `core` can hold it: the AST is a pure data shape with no I/O, and
 * the parser — which needs `mdast-util-from-markdown` — stays in `channel-sdk` where `06` puts it.
 * Logged in `STATUS.md` → Plan changes.
 *
 * ## Why the limits are a tree walk and not part of the recursion
 *
 * Three of `06` §3.5.1's four hard limits — list nesting ≤ 3, quote nesting ≤ 2, ≤ 5 000 nodes —
 * are properties of the whole document, not of any one node. Expressed inside the recursive
 * schemas they would need depth threaded through every variant, and the node budget cannot be
 * expressed that way at all. One walk after a successful structural parse costs a single pass and
 * reports *which* limit, with the depth or count that broke it.
 *
 * The fourth limit, the link scheme allowlist, **is** per-node and lives on the node.
 */
import { capped, idSchema, type MemberId, z } from '@comvivo/shared';
import { Temporal } from 'temporal-polyfill';

// --- The AST (`06` §3.5.1) ----------------------------------------------------------------------
//
// Optional properties are spelled `?: T | undefined` rather than `?: T` because the repository
// compiles with `exactOptionalPropertyTypes`, under which those two are different types and only
// the former matches what `zod`'s `.optional()` produces.

/** Inline formatting. There is no underline: CommonMark has none (`06` §3.5.1). */
export type Mark = 'b' | 'i' | 's' | 'spoiler';

/** Who an `@`-mention points at. */
export type MentionTarget =
  | { kind: 'member'; memberId: MemberId }
  | { kind: 'platform_user'; platformUserId: string };

/** A text run. `marks` is sorted canonically: `b`, `i`, `s`, `spoiler`. */
export type TextInline = { t: 'text'; text: string; marks?: Mark[] | undefined };

export type Inline =
  | TextInline
  /** Inline code. No marks inside, which is why it is not a `TextInline` with a mark. */
  | { t: 'code'; text: string }
  | { t: 'link'; url: string; c: TextInline[] }
  /** `fallback` is `"@Display Name"`, rendered where the platform has no mention primitive. */
  | { t: 'mention'; target: MentionTarget; fallback: string }
  /** An ISO instant rendered in the reader's zone. Templates only; the model never produces one. */
  | { t: 'time'; at: string; fallback: string }
  | { t: 'br' };

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'list'; ordered: boolean; start?: number | undefined; items: Block[][] }
  | { t: 'code'; lang?: string | undefined; text: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' };

/** A rendered message body. `v` is the AST version, so a stored row can be migrated (`12` §3.8). */
export type RichText = { v: 1; blocks: Block[] };

// --- Limits (`06` §3.5.1) -----------------------------------------------------------------------

/** `02` §3.3.9: `messages.rich_text` is capped at 64 KiB of JSON. */
export const RICH_TEXT_MAX_BYTES = 64 * 1024;

/**
 * `06` §3.5.1: at most 5 000 `Block` plus `Inline` nodes in one document.
 *
 * **This limit and {@link RICH_TEXT_MAX_BYTES} interact, measured.** A text run serialises to
 * about 24 bytes, so 5 000 of them is ~120 KB and the 64 KiB cap rejects such a document long
 * before the node count does. A `{"t":"br"}` is 11 bytes, so ~5 950 line breaks fit inside the
 * cap. The node budget therefore binds only for the cheapest node kinds — which is exactly what it
 * is for: 6 000 line breaks is 64 KiB of nothing that would still blow up a renderer's node count,
 * and the byte cap alone would wave it through.
 */
export const RICH_TEXT_MAX_NODES = 5_000;

/** `06` §3.5.1: a list may be nested three deep. */
export const RICH_TEXT_MAX_LIST_DEPTH = 3;

/** `06` §3.5.1: a quote may be nested two deep. */
export const RICH_TEXT_MAX_QUOTE_DEPTH = 2;

/**
 * `06` §3.5.1: the only schemes a stored link may carry.
 *
 * `06` degrades any other link to plain text while parsing, so a link node with another scheme did
 * not come from the parser. Refusing it here is what keeps `javascript:` out of a column that the
 * dashboard renders as an anchor, which is the one place this list is load-bearing rather than
 * cosmetic.
 */
export const RICH_TEXT_LINK_SCHEMES = ['https:', 'http:', 'mailto:'] as const;

/** `06` §3.5.1: the shape of a fenced block's language tag. */
export const RICH_TEXT_LANG_PATTERN = /^[a-z0-9+#-]{1,20}$/;

// --- Schemas ------------------------------------------------------------------------------------

const markSchema = z.enum(['b', 'i', 's', 'spoiler']);

const mentionTargetSchema: z.ZodType<MentionTarget> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), memberId: idSchema('mbr') }),
  z.object({ kind: z.literal('platform_user'), platformUserId: z.string().min(1) }),
]);

const textInlineSchema = z.object({
  t: z.literal('text'),
  text: z.string(),
  marks: z.array(markSchema).optional(),
});

/**
 * An `http:`/`https:` URL: scheme, `//`, then a non-empty authority.
 *
 * Deliberately not built on `URL`. `core` compiles with `lib: ["ES2024"]` and `types: []` (`01`
 * §1: no `node:*`, no ambient platform globals), so the WHATWG `URL` parser is not in scope here —
 * and that is the right trade, because the one thing this check must do is reject a scheme, which
 * is a lexical question and not a parsing one.
 */
const HTTP_URL_PATTERN = /^https?:\/\/[^\s/?#]+\S*$/i;

/** A `mailto:` URL with a non-empty local part and domain. */
const MAILTO_URL_PATTERN = /^mailto:[^\s@]+@[^\s@]+$/i;

/**
 * Whether `text` holds any C0 or C1 control character, `DEL` included.
 *
 * This is the check that matters most, and it is separate from the scheme patterns on purpose: a
 * `javascript:` scheme interrupted by a tab or a newline is read as `javascript:` by some HTML
 * parsers while failing a naive prefix test, so a stored URL is only safe to put in an `href` if
 * it holds no control character at all.
 *
 * A loop rather than a character class, because Biome's `noControlCharactersInRegex` refuses the
 * regex — correctly, in general: a control character in a pattern is almost always a mistake. A
 * suppression would have silenced the rule for a file that goes on to validate untrusted URLs.
 * `for…of` walks code points without allocating, which matters because this runs on every link of
 * every message (`M1-T17`'s 3 ms ingestion budget).
 */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * A link URL: free of control characters, and one of `06` §3.5.1's three schemes.
 *
 * `06`'s parser degrades every other scheme to plain text, so a link node carrying one did not
 * come from the parser. Refusing it here is what keeps `javascript:` out of a column the dashboard
 * renders as an anchor — the one place this allowlist is load-bearing rather than cosmetic.
 */
const linkUrlSchema = z
  .string()
  .max(2048, 'a link URL is at most 2048 characters')
  .refine((url) => !hasControlCharacter(url), 'a link URL must not contain control characters')
  .refine(
    (url) => HTTP_URL_PATTERN.test(url) || MAILTO_URL_PATTERN.test(url),
    `a link URL must use ${RICH_TEXT_LINK_SCHEMES.join(', ')} (06 §3.5.1 degrades the rest to text)`,
  );

const instantTextSchema = z.string().refine((at) => {
  try {
    Temporal.Instant.from(at);
    return true;
  } catch {
    return false;
  }
}, 'a `time` node holds an ISO instant, e.g. `2026-11-06T09:30:00Z`');

const inlineSchema: z.ZodType<Inline> = z.discriminatedUnion('t', [
  textInlineSchema,
  z.object({ t: z.literal('code'), text: z.string() }),
  z.object({ t: z.literal('link'), url: linkUrlSchema, c: z.array(textInlineSchema) }),
  z.object({
    t: z.literal('mention'),
    target: mentionTargetSchema,
    fallback: z.string().min(1),
  }),
  z.object({ t: z.literal('time'), at: instantTextSchema, fallback: z.string().min(1) }),
  z.object({ t: z.literal('br') }),
]);

const blockSchema: z.ZodType<Block> = z.lazy(() =>
  z.discriminatedUnion('t', [
    z.object({ t: z.literal('p'), c: z.array(inlineSchema) }),
    z.object({ t: z.literal('h'), level: z.literal([1, 2, 3]), c: z.array(inlineSchema) }),
    z.object({
      t: z.literal('list'),
      ordered: z.boolean(),
      start: z.int().min(0).max(1_000_000).optional(),
      items: z.array(z.array(blockSchema)),
    }),
    z.object({
      t: z.literal('code'),
      lang: z
        .string()
        .regex(RICH_TEXT_LANG_PATTERN, 'a code fence language is `^[a-z0-9+#-]{1,20}$` (06 §3.5.1)')
        .optional(),
      text: z.string(),
    }),
    z.object({ t: z.literal('quote'), c: z.array(blockSchema) }),
    z.object({ t: z.literal('hr') }),
  ]),
);

/**
 * `messages.rich_text` (`02` §3.3.9): the structure, then the document-wide limits, then the cap.
 *
 * The order is the point. Structure first, so the walk can trust the shape it is given; limits
 * next, so an over-nested document is reported as over-nested rather than as 64 KiB of JSON; the
 * byte cap last, since it is the only one a *valid* document can still fail.
 */
export const RichTextSchema = capped(
  z.object({ v: z.literal(1), blocks: z.array(blockSchema) }).superRefine((value, context) => {
    for (const message of violations(value)) {
      context.addIssue({ code: 'custom', message });
    }
  }),
  RICH_TEXT_MAX_BYTES,
  'rich text',
);

// --- The document-wide limits -------------------------------------------------------------------

/** How deep the walk currently is, per limit. */
interface Depths {
  readonly list: number;
  readonly quote: number;
}

/**
 * Every `06` §3.5.1 limit the document breaks, as messages.
 *
 * All of them rather than the first, because a document that is both over-nested and over budget
 * should say so once: a caller that fixes the nesting and re-submits would otherwise learn about
 * the node count on the second attempt.
 */
function violations(document: RichText): string[] {
  const found: string[] = [];
  let nodes = 0;
  let deepestList = 0;
  let deepestQuote = 0;

  const walkInline = (inline: Inline): void => {
    nodes += 1;
    if (inline.t === 'link') nodes += inline.c.length;
  };

  const walkBlock = (block: Block, depths: Depths): void => {
    nodes += 1;
    switch (block.t) {
      case 'p':
      case 'h':
        for (const inline of block.c) walkInline(inline);
        return;
      case 'list': {
        const depth = depths.list + 1;
        deepestList = Math.max(deepestList, depth);
        for (const item of block.items) {
          for (const child of item) walkBlock(child, { ...depths, list: depth });
        }
        return;
      }
      case 'quote': {
        const depth = depths.quote + 1;
        deepestQuote = Math.max(deepestQuote, depth);
        for (const child of block.c) walkBlock(child, { ...depths, quote: depth });
        return;
      }
      case 'code':
      case 'hr':
        return;
    }
  };

  for (const block of document.blocks) walkBlock(block, { list: 0, quote: 0 });

  if (nodes > RICH_TEXT_MAX_NODES) {
    found.push(
      `rich text has ${String(nodes)} nodes, over the ${String(RICH_TEXT_MAX_NODES)}-node limit`,
    );
  }
  if (deepestList > RICH_TEXT_MAX_LIST_DEPTH) {
    found.push(
      `a list is nested ${String(deepestList)} deep, over the limit of ${String(RICH_TEXT_MAX_LIST_DEPTH)}`,
    );
  }
  if (deepestQuote > RICH_TEXT_MAX_QUOTE_DEPTH) {
    found.push(
      `a quote is nested ${String(deepestQuote)} deep, over the limit of ${String(RICH_TEXT_MAX_QUOTE_DEPTH)}`,
    );
  }
  return found;
}
