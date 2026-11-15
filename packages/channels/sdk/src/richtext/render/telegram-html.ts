/**
 * The `telegram-html` renderer (`06` §3.5.3; `M3-T4`).
 *
 * Telegram's HTML parse mode, which is **not** HTML: it is a fixed list of tags, four named
 * entities, and a parser that rejects the whole message rather than ignoring what it does not
 * understand. `400 can't parse entities` means the member gets nothing, and the input that
 * triggers it is somebody else's text — so every output of this module is checked by a validator
 * (`telegram-validator.ts`) rather than reviewed.
 *
 * ## The nesting order is part of the contract
 *
 * `06` §3.5.3: `a > b > i > s > tg-spoiler`. Telegram's parser is tolerant of some orders and not
 * others, and the failures are not symmetric — a `<b>` inside an `<a>` is fine, an `<a>` inside a
 * `<b>` is accepted but loses the link on some clients. One fixed order means the question is
 * answered once, so `MARK_ORDER` below is the order and `openMarks` is the only place that opens a
 * tag.
 *
 * ## Why `<code>` has nothing nested inside it
 *
 * `06` §3.5.1 gives inline code its own node precisely because no platform nests formatting inside
 * it, and `06` §3.5.3 says so for this markup: "`<code>` (nothing nested inside)". A `<b>` inside
 * a `<code>` renders as the literal characters on Telegram Desktop and as bold monospace on
 * Android, which is the kind of difference nobody can debug from a bug report.
 */
import type { Block, Inline, Mark, RichText, TextInline } from '@comvivo/core';
import { Temporal } from 'temporal-polyfill';
import type { ChannelCapabilities, RenderContext } from '../../contract.js';
import { escapeTelegramAttribute, escapeTelegramText, neutraliseMassMentions } from './escape.js';

/** `06` §3.5.3's nesting order, outermost first. The link is outside all of them. */
const MARK_ORDER: readonly Mark[] = ['b', 'i', 's', 'spoiler'];

const MARK_TAGS: Readonly<Record<Mark, string>> = {
  b: 'b',
  i: 'i',
  s: 's',
  spoiler: 'tg-spoiler',
};

/** `06` §3.5.3: a quote over this many characters gets `expandable`. */
export const TELEGRAM_EXPANDABLE_QUOTE_CHARS = 600;

/** `06` §3.5.3: `hr`, which Telegram has no tag for. */
export const TELEGRAM_RULE = '———';

/** Two non-breaking spaces per list level — Telegram collapses ordinary leading spaces. */
const TELEGRAM_INDENT = '  ';

/** `06` §3.5.3's `tg-time` format string. */
export const TG_TIME_FORMAT = 'wDt';

export interface TelegramRenderOptions {
  /** `massMentionTokens`, so the neutralisation is the platform's own list (`06` §3.6). */
  readonly capabilities?: Pick<ChannelCapabilities, 'massMentionTokens'> | undefined;
}

/** Render to Telegram HTML. Pure: `(ast, ctx) → string` (`06` §3.5.3). */
export function renderTelegramHtml(
  document: RichText,
  context: RenderContext,
  options: TelegramRenderOptions = {},
): string {
  const tokens = options.capabilities?.massMentionTokens ?? [];
  const out = document.blocks.map((block) => renderBlock(block, context, tokens, 0)).join('');
  // Trailing newlines are length on a 4 096-character budget and an empty line in the bubble.
  return out.replace(/\n+$/, '');
}

function renderBlock(
  block: Block,
  context: RenderContext,
  tokens: readonly string[],
  depth: number,
): string {
  switch (block.t) {
    case 'p':
      return `${renderInlines(block.c, context, tokens)}\n\n`;
    case 'h':
      // `06` §3.5.3: every level is `<b>…</b>\n`. Telegram has no headings, and three sizes of
      // bold would be three ways of saying the same thing.
      return `<b>${renderInlines(block.c, context, tokens)}</b>\n`;
    case 'list':
      return renderList(block, context, tokens, depth);
    case 'code':
      return renderCode(block);
    case 'quote':
      return renderQuote(block, context, tokens, depth);
    case 'hr':
      return `${TELEGRAM_RULE}\n\n`;
  }
}

function renderList(
  block: Extract<Block, { t: 'list' }>,
  context: RenderContext,
  tokens: readonly string[],
  depth: number,
): string {
  const indent = TELEGRAM_INDENT.repeat(depth);
  let number = block.start ?? 1;
  const lines: string[] = [];
  for (const item of block.items) {
    const marker = block.ordered ? `${String(number)}. ` : '• ';
    number += 1;
    lines.push(`${indent}${marker}${renderItem(item, context, tokens, depth)}`);
  }
  return `${lines.join('')}\n`;
}

/**
 * One list item's blocks.
 *
 * The first paragraph joins the marker; anything after it goes on its own line. Rendering the
 * blocks and prefixing the marker would put the bullet on an empty line whenever an item opens
 * with a nested list, which is what a list of lists looks like.
 */
function renderItem(
  item: readonly Block[],
  context: RenderContext,
  tokens: readonly string[],
  depth: number,
): string {
  if (item.length === 0) return '\n';
  return item
    .map((child, index) => {
      if (child.t === 'p' || child.t === 'h') {
        const inner = renderInlines(child.c, context, tokens);
        return index === 0 ? `${inner}\n` : `${TELEGRAM_INDENT.repeat(depth + 1)}${inner}\n`;
      }
      return renderBlock(child, context, tokens, depth + 1);
    })
    .join('');
}

/**
 * A fenced block.
 *
 * `<pre><code class="language-x">` per `06` §3.5.3, and the `class` only when there is a language:
 * Telegram treats `class="language-"` as an unknown language rather than as none, and shows the
 * block unhighlighted with the attribute still in the entity list.
 */
function renderCode(block: Extract<Block, { t: 'code' }>): string {
  const open =
    block.lang === undefined
      ? '<pre><code>'
      : `<pre><code class="language-${escapeTelegramAttribute(block.lang)}">`;
  return `${open}${escapeTelegramText(block.text)}</code></pre>\n\n`;
}

/**
 * A blockquote, flattened.
 *
 * `06` §3.5.3: "nested quotes flattened" — Telegram has no nested `<blockquote>` and emitting one
 * is a parse error. `expandable` above 600 characters, which is Telegram's own collapse threshold:
 * a long quote otherwise fills the whole bubble before the reply that follows it.
 */
function renderQuote(
  block: Extract<Block, { t: 'quote' }>,
  context: RenderContext,
  tokens: readonly string[],
  depth: number,
): string {
  const inner = flattenQuote(block)
    .map((child) => renderBlock(child, context, tokens, depth))
    .join('')
    .replace(/\n+$/, '');
  const expandable = visibleLength(inner) > TELEGRAM_EXPANDABLE_QUOTE_CHARS;
  return `<blockquote${expandable ? ' expandable' : ''}>${inner}</blockquote>\n\n`;
}

/** A quote's children with any nested quotes spliced in, since Telegram cannot nest them. */
function flattenQuote(block: Extract<Block, { t: 'quote' }>): Block[] {
  const out: Block[] = [];
  for (const child of block.c) {
    if (child.t === 'quote') out.push(...flattenQuote(child));
    else out.push(child);
  }
  return out;
}

function renderInlines(
  inlines: readonly Inline[],
  context: RenderContext,
  tokens: readonly string[],
): string {
  return inlines.map((inline) => renderInline(inline, context, tokens)).join('');
}

function renderInline(inline: Inline, context: RenderContext, tokens: readonly string[]): string {
  switch (inline.t) {
    case 'text':
      return wrapMarks(escapeText(inline.text, tokens), inline.marks);
    case 'code':
      // No marks, and the text escaped: a `<` inside a code block is still markup to Telegram's
      // parser, which is the half of "nothing nested inside" that is easy to forget.
      return `<code>${escapeTelegramText(inline.text)}</code>`;
    case 'link':
      return renderLink(inline, tokens);
    case 'mention':
      return renderMention(inline, context, tokens);
    case 'time':
      // `06` §3.5.3: `<tg-time unix="…" format="wDt">fallback</tg-time>`. The fallback is the
      // child, so a client that does not know the tag shows the pre-rendered text.
      return `<tg-time unix="${unixOf(inline.at)}" format="${TG_TIME_FORMAT}">${escapeTelegramText(
        inline.fallback,
      )}</tg-time>`;
    case 'br':
      return '\n';
  }
}

function renderLink(inline: Extract<Inline, { t: 'link' }>, tokens: readonly string[]): string {
  const label = inline.c.map((run) => wrapMarks(escapeText(run.text, tokens), run.marks)).join('');
  // The link is the outermost tag (`06` §3.5.3's `a > b > i > s > tg-spoiler`), so the marks are
  // applied to each run **inside** it rather than around the anchor.
  return `<a href="${escapeTelegramAttribute(inline.url)}">${label}</a>`;
}

/**
 * A mention (`06` §3.5.3, §3.6).
 *
 * Three outcomes, and the order matters: an unpingable mention is plain text **before** anything
 * else is considered, because `06` §3.6 makes that a product rule rather than a fallback —
 * `canPing` is false when the constitution forbids a ping on a proactive message, and a renderer
 * that reached for `tg://user?id=` anyway would ping somebody the group said not to.
 */
function renderMention(
  inline: Extract<Inline, { t: 'mention' }>,
  context: RenderContext,
  tokens: readonly string[],
): string {
  if (inline.target.kind === 'platform_user') {
    // An inbound mention echoed back. No identity to resolve, so the fallback is all there is.
    return escapeText(inline.fallback, tokens);
  }
  const resolved = context.mentions[inline.target.memberId];
  if (resolved === undefined || !resolved.canPing) return escapeText(inline.fallback, tokens);
  // `@username` when the member has a public one: it pings, it survives a forward, and it is
  // shorter than the anchor — which matters against a 4 096-character budget.
  if (resolved.username !== undefined && resolved.username !== '') {
    return escapeText(`@${resolved.username}`, tokens);
  }
  if (resolved.platformUserId === undefined) return escapeText(inline.fallback, tokens);
  return `<a href="tg://user?id=${escapeTelegramAttribute(resolved.platformUserId)}">${escapeTelegramText(
    resolved.displayName,
  )}</a>`;
}

/** Escape, then break the platform's mass-mention tokens. */
function escapeText(text: string, tokens: readonly string[]): string {
  return neutraliseMassMentions(escapeTelegramText(text), tokens);
}

/** Wrap `html` in the mark tags, outermost first, per `06` §3.5.3's order. */
function wrapMarks(html: string, marks: TextInline['marks']): string {
  if (marks === undefined || marks.length === 0) return html;
  let out = html;
  // Innermost first as we build outwards, so the result reads `b > i > s > tg-spoiler`.
  for (const mark of [...MARK_ORDER].reverse()) {
    if (!marks.includes(mark)) continue;
    const tag = MARK_TAGS[mark];
    out = `<${tag}>${out}</${tag}>`;
  }
  return out;
}

/**
 * An ISO instant as whole seconds since the epoch.
 *
 * Seconds, because `tg-time`'s attribute is `unix`.
 *
 * `Temporal`, not `Date.parse`. The first version used `Date.parse` and argued that it reads no
 * clock, so the purity rule did not apply — but `eslint.config.ts` bans the `Date` global outright
 * in this package, and `CLAUDE.md` §2 says to fix the design rather than weaken the rule. The rule
 * also says what to use instead ("Temporal types are fine"), and `@comvivo/core` — the strictest
 * package in the repository — already parses this very field with `Temporal.Instant.from`. So the
 * two agree about the format by construction rather than by coincidence.
 *
 * The `catch` is unreachable: `RichTextSchema` validates `at` with the same call before the node
 * can be stored. It is here because a renderer is the wrong place to throw — a malformed timestamp
 * should cost the reader a `tg-time` attribute, not the whole message.
 */
function unixOf(at: string): string {
  try {
    return String(Math.floor(Temporal.Instant.from(at).epochMilliseconds / 1000));
  } catch {
    return '0';
  }
}

/**
 * The visible length of a rendered fragment — tags stripped, entities decoded.
 *
 * Here as well as in `measure.ts` because the quote's `expandable` threshold is about what a
 * reader sees, not about how much markup it took.
 */
function visibleLength(html: string): number {
  return html.replaceAll(/<[^>]*>/g, '').replaceAll(/&(amp|lt|gt|quot);/g, 'x').length;
}
