/**
 * Measurement (`06` §3.5.4; `M3-T4`).
 *
 * `06` §3.5.4: "`measure` renders and counts **the unit the platform counts**." That sentence is
 * the whole module, and every word of it earns its place.
 *
 * **Renders.** A length taken from the AST would be a guess: Telegram's 4 096 is "characters after
 * entities parsing", so `&amp;` is one character and `<b>` is none, and an AST-based estimate is
 * wrong by the amount of markup — in the direction that overshoots, which means a message the
 * platform rejects.
 *
 * **The unit the platform counts.** Telegram counts visible UTF-16 after the tags are stripped;
 * Signal counts UTF-8 **bytes** of the plain text; Discord counts the raw content including its
 * markup. Three different numbers for the same message, and `ChannelCapabilities.lengthUnit`
 * records which one a profile uses. `06` §3.5.4 sets the safety factor at 1.0 "because measurement
 * is exact", so there is no slack to absorb a wrong unit: an over-count splits a message that did
 * not need splitting, and an under-count is a rejected send.
 *
 * ## What is not here
 *
 * The splitter (`M3-T5`). This module answers "how long is this part" and nothing about where to
 * cut — which is why it takes a rendered part rather than an AST.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import type { ChannelCapabilities } from '../../contract.js';

/**
 * UTF-8 bytes of a string.
 *
 * Signal's limit is `MAX_MESSAGE_SIZE_BYTES`, so a family writing in Arabic or Japanese reaches it
 * at a third of the characters an English-speaking one does. Counted rather than taken from
 * `length`, because that is the bug this function exists to prevent.
 */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** A string in the unit a profile counts (`06` §3.5.4). */
export function measureText(text: string, unit: ChannelCapabilities['lengthUnit']): number {
  return unit === 'utf8-bytes' ? utf8Bytes(text) : text.length;
}

/**
 * Telegram's visible length: tags stripped, entities decoded (`06` §3.5.4).
 *
 * Decoded by **counting**, not by rewriting the string: each of the four entities is one visible
 * character, so the count is the length with the tags removed minus what each entity cost beyond
 * one. Rewriting would mean producing a string nobody uses, on the hot path, for every part.
 *
 * `tg-time` is the case that makes this more than arithmetic: its *child* is what the reader sees
 * when the client does not know the tag, and its attributes are not visible at all — which the
 * tag-stripping handles for free and an AST-based estimate would get wrong in both directions.
 */
export function measureTelegramHtml(html: string): number {
  let visible = 0;
  let at = 0;
  while (at < html.length) {
    const char = html[at] ?? '';
    if (char === '<') {
      const end = skipTag(html, at);
      if (end > at) {
        at = end;
        continue;
      }
      // Not a tag — an unescaped `<`, which is a bug the validator reports. Counted as a
      // character, because that is what Telegram would do with it if it accepted the message.
      visible += 1;
      at += 1;
      continue;
    }
    if (char === '&') {
      const entity = entityAt(html, at);
      if (entity > 0) {
        visible += 1;
        at += entity;
        continue;
      }
    }
    visible += 1;
    at += 1;
  }
  return visible;
}

/** Where the tag starting at `at` ends, or `at` if it is not a tag. Skips quoted attributes. */
function skipTag(html: string, at: number): number {
  let cursor = at + 1;
  if (html[cursor] === '/') cursor += 1;
  if (!/[a-zA-Z]/.test(html[cursor] ?? '')) return at;
  while (cursor < html.length) {
    const char = html[cursor];
    if (char === '"') {
      const close = html.indexOf('"', cursor + 1);
      if (close === -1) return at;
      cursor = close + 1;
      continue;
    }
    if (char === '>') return cursor + 1;
    cursor += 1;
  }
  return at;
}

/** The length of the Telegram entity at `at`, or 0. */
function entityAt(html: string, at: number): number {
  for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;']) {
    if (html.startsWith(entity, at)) return entity.length;
  }
  return 0;
}

/**
 * The visible text of an AST, for the `web-md` payload and for a plain measurement.
 *
 * A separate walk from `renderPlain`, and deliberately a cheap one: it answers "how much is there
 * to read" without the list markers, quote prefixes or style ranges that the plain renderer builds.
 * The splitter budgets against the **rendered** part (`06` §3.5.4), so this is for the payloads
 * that have no string form at all — the web channel's AST and the dashboard's preview.
 */
export function visibleText(document: RichText): string {
  return document.blocks.map(visibleBlock).join('\n');
}

function visibleBlock(block: Block): string {
  switch (block.t) {
    case 'p':
    case 'h':
      return block.c.map(visibleInline).join('');
    case 'list':
      return block.items.map((item) => item.map(visibleBlock).join('\n')).join('\n');
    case 'code':
      return block.text;
    case 'quote':
      return block.c.map(visibleBlock).join('\n');
    case 'hr':
      return '';
  }
}

function visibleInline(inline: Inline): string {
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
      return '\n';
  }
}
