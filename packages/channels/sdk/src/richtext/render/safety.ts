/**
 * Outbound content safety (`08` §3.12, §3.4's **S5** and **S6**; `M3-T10`).
 *
 * The escaping in `escape.ts` stops a message breaking a platform's parser. This module stops a
 * message doing something to a group that nobody asked for, and the two failure modes it exists for
 * are both loud:
 *
 * - **S6 — a mass mention.** `@everyone`, `@here`, `<!channel>`, `@room`. Village never *composes*
 *   one, and that is exactly why the renderer is where they have to be stopped: they arrive in
 *   **content**. A member quotes one, a model repeats one back, an email forwarded into a chat
 *   contains one. The result is a notification to a hundred people at two in the morning, sent by
 *   the thing a family installed to be considerate.
 * - **S5 — a link preview.** A preview is the linked page's content, rendered to everyone in the
 *   chat by the client, and fetched by the platform from a URL that may have come from a model or
 *   from a stranger's email. `08` §3.12 suppresses them unless something explicitly allows one.
 *
 * And one that is quieter and worse: **the mention cap**. `08` §3.12 allows at most five distinct
 * member mentions per message, because a reminder addressed to nine people is nine phones buzzing
 * for something one message could have said. The rule has no platform limit behind it — every
 * platform would happily send it — so nothing fails if it is missing.
 *
 * ## Where this sits
 *
 * `renderPart` calls it, so every markup gets the same treatment and a new renderer cannot forget.
 * {@link safetyFindings} is the audit the fuzz corpus asserts over, and `M3-T26`'s output pipeline
 * will run it again before the outbox: a check that only runs where the renderer chose to call it
 * is a check whose coverage is a reading of the code.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import type { ChannelCapabilities, Markup } from '../../contract.js';
import { TELEGRAM_ENTITIES, ZWSP } from './escape.js';

/** `08` §3.12: "At most **5** distinct member mentions per message." */
export const MAX_MENTIONS_PER_MESSAGE = 5;

/**
 * Tokens that are never emitted on **any** platform, whatever its profile says.
 *
 * `ChannelCapabilities.massMentionTokens` is the per-platform list, and it is the right thing for a
 * renderer to drive from — but it is also host-supplied for a third-party adapter (`06` §4.1), and
 * `08` §3.12's rule is absolute: "**No group-wide notification tokens** are ever emitted in 1.0."
 * So the union of every platform's tokens is checked as well, which means a profile that forgot one
 * cannot make it emittable.
 */
export const UNIVERSAL_MASS_MENTION_TOKENS: readonly string[] = Object.freeze([
  '@everyone',
  '@here',
  '@room',
  '@channel',
  '@all',
  '<!channel>',
  '<!here>',
  '<!everyone>',
]);

/** What the cap did, so a caller can log it and `M3-T26` can record it on the turn. */
export interface MentionCapResult {
  readonly document: RichText;
  /** Mentions turned into plain text. `0` on the common path. */
  readonly dropped: number;
}

/**
 * Keep the first `max` distinct members as mentions; flatten the rest to their fallback text.
 *
 * **Distinct** members, not mention nodes: a message that names Ana twice has mentioned one person,
 * and counting nodes would punish a reply that repeats a name naturally. And **flattened**, not
 * removed — the reader still sees who the message is about, which is the whole point of having
 * named them; what they lose is the notification.
 *
 * First `max` rather than a selection, because the order is the author's: `05`'s copy puts the
 * person the message is *for* first, and a cap that dropped by some other rule would silently
 * un-notify the one member who needed it.
 */
export function capMentions(document: RichText, max = MAX_MENTIONS_PER_MESSAGE): MentionCapResult {
  const kept = new Set<string>();
  let dropped = 0;

  const inline = (node: Inline): Inline => {
    if (node.t !== 'mention' || node.target.kind !== 'member') return node;
    const id = String(node.target.memberId);
    if (kept.has(id) || kept.size < max) {
      kept.add(id);
      return node;
    }
    dropped += 1;
    return { t: 'text', text: node.fallback };
  };

  const block = (node: Block): Block => {
    switch (node.t) {
      case 'p':
        return { ...node, c: node.c.map(inline) };
      case 'h':
        return { ...node, c: node.c.map(inline) };
      case 'quote':
        return { ...node, c: node.c.map(block) };
      case 'list':
        return { ...node, items: node.items.map((item) => item.map(block)) };
      case 'code':
      case 'hr':
        return node;
    }
  };

  const blocks = document.blocks.map(block);
  return { document: dropped === 0 ? document : { ...document, blocks }, dropped };
}

/** What a safety pass changed. */
export interface SanitisedDocument {
  readonly document: RichText;
  readonly mentionsDropped: number;
  /** How many text runs had a mass-mention token broken. */
  readonly massMentionsBroken: number;
}

/**
 * The whole outbound pass: cap the mentions, break the mass mentions.
 *
 * Applied to the **AST, before rendering**, and that order is not a preference. The `plain`
 * renderer emits Signal's style and mention ranges as offsets into the text it produced, so
 * inserting a zero-width space into the *output* would shift every range after it by one — a
 * mention highlight landing on the wrong word, or past the end of the message. Breaking the token
 * in the AST means the offsets are computed over the final text, which is the only way the two can
 * agree. `M3-T4` left a note that the mass-mention path was a no-op for Telegram and that `M3-T10`
 * owned proving it in a renderer that uses it; this is where that happens, and the order was the
 * part worth finding out.
 *
 * Mention **fallbacks** are swept too. A fallback is what a reader sees when the platform cannot
 * ping, and `06` §3.5.2 builds it from a display name — which a member chooses, so `@everyone` is a
 * display name somebody can set.
 */
export function sanitiseDocument(
  document: RichText,
  capabilities: ChannelCapabilities,
  max = MAX_MENTIONS_PER_MESSAGE,
): SanitisedDocument {
  const capped = capMentions(document, max);
  let broken = 0;
  const sweep = (text: string): string => {
    const out = neutraliseAllMassMentions(stripControls(text), capabilities);
    if (out !== text) broken += 1;
    return out;
  };

  const inline = (node: Inline): Inline => {
    switch (node.t) {
      case 'text':
        return { ...node, text: sweep(node.text) };
      case 'code':
        // A mass mention inside inline code is inert on every platform in `06` §3.2 — the markup
        // makes it literal — but Signal and the `plain` renderer have no code markup at all, so the
        // token reaches the chat as text. Swept for the platform that cannot protect it.
        return { ...node, text: sweep(node.text) };
      case 'link':
        return { ...node, c: node.c.map((run) => ({ ...run, text: sweep(run.text) })) };
      case 'mention':
      case 'time':
        return { ...node, fallback: sweep(node.fallback) };
      case 'br':
        return node;
    }
  };

  const block = (node: Block): Block => {
    switch (node.t) {
      case 'p':
        return { ...node, c: node.c.map(inline) };
      case 'h':
        return { ...node, c: node.c.map(inline) };
      case 'quote':
        return { ...node, c: node.c.map(block) };
      case 'list':
        return { ...node, items: node.items.map((item) => item.map(block)) };
      case 'code':
        return { ...node, text: sweep(node.text) };
      case 'hr':
        return node;
    }
  };

  const blocks = capped.document.blocks.map(block);
  return {
    document: broken === 0 ? capped.document : { ...capped.document, blocks },
    mentionsDropped: capped.dropped,
    massMentionsBroken: broken,
  };
}

/**
 * Remove the control characters a message has no use for.
 *
 * Tab, newline and carriage return stay — they are text. Everything else below `U+0020`, plus
 * `U+007F` and the C1 block, goes: a `NUL` in a Telegram HTML payload is a parse risk, in a Block
 * Kit string a truncation, and in a log line a terminal escape. Found by the `fuzz.render.*` corpus,
 * which fed one in as content and watched it come out the other side — `safetyFindings` reported it
 * and nothing removed it, which made the rule an observation rather than a guarantee.
 *
 * Not `U+200B` or `U+2060`: those are the zero-width characters this module *inserts* to break a
 * mass mention, and stripping them here would undo the sweep two lines later.
 */
export function stripControls(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point of the rule is to match them
  return text.replaceAll(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
}

/** What the renderer and the adapter each have to do about a preview (`08` §3.12, S5). */
export interface LinkPreviewPolicy {
  /** Whether the preview must be off for this message. */
  readonly suppress: boolean;
  /**
   * Whether the platform lets the sender decide per message.
   *
   * `false` for Matrix and Signal, where unfurling is the **client's** choice and no flag exists.
   * `08` §3.12's table says so in as many words, and the honest consequence is that S5 is a
   * provenance policy there rather than a switch: `03`'s guard has to decide whether the URL may be
   * in the message at all, because once it is, a client may render it.
   */
  readonly enforceable: boolean;
}

/**
 * Whether this message's preview is on, and whether the platform will listen.
 *
 * Default-off (`06` §4.1 types `OutboundMessage.linkPreview` as optional and documents the default
 * as false), because a preview is the linked page's content shown to everyone present — including
 * on a link a model produced or a stranger emailed in.
 */
export function linkPreviewPolicy(
  capabilities: ChannelCapabilities,
  requested: boolean | undefined,
): LinkPreviewPolicy {
  return {
    suppress: requested !== true,
    enforceable: capabilities.linkPreviewControl === 'per-message',
  };
}

/**
 * Break a mass-mention token, leaving it readable.
 *
 * A zero-width space after the first character: the member reads `@everyone` unchanged and the
 * platform does not match it. Removing the token would edit somebody's words, which a chat client
 * has no business doing — and `08` §3.12's own wording for Matrix is "broken with U+2060", the same
 * technique.
 *
 * Both the platform's list **and** the universal one, for the reason {@link
 * UNIVERSAL_MASS_MENTION_TOKENS} gives: a host-supplied profile that forgot a token must not make
 * it emittable. The cost of the extra pass is a `replaceAll` over a message.
 */
export function neutraliseAllMassMentions(text: string, capabilities: ChannelCapabilities): string {
  let out = text;
  for (const token of new Set([
    ...capabilities.massMentionTokens,
    ...UNIVERSAL_MASS_MENTION_TOKENS,
  ])) {
    if (token.length === 0) continue;
    out = out.replaceAll(token, `${token.slice(0, 1)}${ZWSP}${token.slice(1)}`);
  }
  return out;
}

/**
 * A button label, as a platform may be given one (`08` §3.12: "Labels never contain unescaped user
 * text").
 *
 * A label is plain text on every platform this product targets — Telegram's inline keyboard,
 * Discord's component, Slack's Block Kit all take a string and render it literally — so the risk is
 * not markup. It is the characters that *are* interpreted: a newline splits a Block Kit element, a
 * zero-width joiner or a bidirectional override reorders what the reader sees, and a mass-mention
 * token in a label is a mass mention.
 *
 * So: control characters and bidi overrides out, whitespace collapsed, mass mentions broken. Not
 * truncated — `interactions/buttons.ts` owns the length, and doing it twice in two places is how
 * two answers appear.
 */
export function sanitiseButtonLabel(label: string, capabilities: ChannelCapabilities): string {
  // Whitespace controls become a **space** before the rest are stripped, which is not fussiness:
  // deleting a newline turns `Approve\nReject` into `ApproveReject`, and a label that jams two
  // words together is a worse label than one with a space in it. Found by a test that expected the
  // readable answer.
  const spaced = label.replaceAll(/[\t\n\r\v\f\u0085\u2028\u2029]/gu, ' ');
  // The bidi overrides, which `stripControls` deliberately leaves alone in a message body: an
  // override in prose is somebody writing Hebrew, and in a one-line label it is a lie about the
  // order of what follows. A regex rather than a filter over spread characters — `[...text]`
  // iterates code points and is safe, but `no-misused-spread` cannot tell that from `.split('')`,
  // and this reads better anyway.
  const stripped = stripControls(spaced).replaceAll(/[\u202a-\u202e\u2066-\u2069]/gu, '');
  return neutraliseAllMassMentions(stripped.replaceAll(/\s+/gu, ' ').trim(), capabilities);
}

/** One thing wrong with a rendered part. */
export interface SafetyFinding {
  readonly rule: 'mass_mention' | 'unescaped_markup' | 'bad_entity' | 'control_character';
  readonly detail: string;
}

/**
 * Audit a rendered payload (S5, S6, `08` §3.12).
 *
 * The function the `fuzz.render.*` corpus asserts is empty for every input, and the reason it
 * returns findings rather than throwing is that it has two callers with different jobs: a fuzz test
 * wants to see all of them at once, and `M3-T26`'s output pipeline wants to refuse the send.
 *
 * Deliberately a check on the **output string**, not on the AST. An AST-level check would say what
 * the renderer intended; this says what the platform will receive, which is the only thing a group
 * experiences. It is the same reason `06` §3.5.4 measures by rendering.
 */
export function safetyFindings(
  payload: string,
  capabilities: ChannelCapabilities,
): readonly SafetyFinding[] {
  const out: SafetyFinding[] = [];
  for (const token of new Set([
    ...capabilities.massMentionTokens,
    ...UNIVERSAL_MASS_MENTION_TOKENS,
  ])) {
    if (token.length > 0 && payload.includes(token)) {
      out.push({ rule: 'mass_mention', detail: token });
    }
  }
  for (const character of payload) {
    const code = character.codePointAt(0) ?? 0;
    // Tab, newline and carriage return are legitimate in a message body; nothing else below 0x20
    // is, and a C1 control in Telegram HTML is a parse failure waiting to happen.
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      out.push({ rule: 'control_character', detail: `U+${code.toString(16).padStart(4, '0')}` });
      break;
    }
  }
  if (capabilities.markup === 'telegram-html') out.push(...telegramFindings(payload));
  return out;
}

/**
 * Telegram HTML's two output rules (`06` §3.5.3).
 *
 * An unescaped `<` or `&` is `400 can't parse entities`, which sends **nothing** — no partial
 * render, no platform fallback — and the input that triggers it is a message somebody else wrote.
 * `telegram-validator.ts` checks the structure (balanced, allowlisted, nothing inside `<code>`);
 * this checks the two characters, because a validator that accepted the tags can still have been
 * handed text with a raw `&` in it.
 */
function telegramFindings(html: string): readonly SafetyFinding[] {
  const out: SafetyFinding[] = [];
  // Every `&` must begin one of Telegram's four entities. `&nbsp;` is a parse error there, and a
  // bare `&` is the one an escaper misses.
  for (const match of html.matchAll(/&[^\s]{0,10}/g)) {
    const at = match.index;
    if (!TELEGRAM_ENTITIES.some((entity) => html.startsWith(entity, at))) {
      out.push({ rule: 'bad_entity', detail: match[0].slice(0, 12) });
      break;
    }
  }
  // A `<` that does not open a tag the renderer wrote. Checked by scanning rather than by regex for
  // the reason `measure.ts` gives: the case a regex gets wrong is a `>` inside an attribute value,
  // and an escaping bug is exactly what produces one.
  let at = 0;
  while (at < html.length) {
    const next = html.indexOf('<', at);
    if (next === -1) break;
    const end = skipTag(html, next);
    if (end === next) {
      out.push({ rule: 'unescaped_markup', detail: html.slice(next, next + 12) });
      break;
    }
    at = end;
  }
  return out;
}

/** Where the tag starting at `at` ends, or `at` if it is not one. Skips quoted attributes. */
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

/** The markups this module knows how to audit. The rest are refused by `renderPart` until M8. */
export const AUDITED_MARKUPS: readonly Markup[] = Object.freeze([
  'telegram-html',
  'plain',
  'web-md',
]);
