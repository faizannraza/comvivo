/**
 * One entry point for rendering (`06` §3.5.3–§3.5.4; `M3-T4`).
 *
 * `renderPart(ast, ctx, caps)` is what the splitter (`M3-T5`) and every adapter call: it picks the
 * renderer from `ChannelCapabilities.markup`, measures the result in
 * `ChannelCapabilities.lengthUnit`, and returns `06` §4.1's `RenderedPart`.
 *
 * ## Why the choice is made from the capabilities rather than by the caller
 *
 * `06` §3.5.4's splitter measures a part, decides whether it fits, and renders the next slice —
 * so the renderer and the measurement have to be the same choice every time. A caller that passed
 * a markup separately could pass `plain` to the renderer and Telegram's `utf16` to the measure,
 * and the symptom would be messages split in the wrong places on one platform only.
 *
 * ## The three markups that are not here yet
 *
 * `discord-md`, `slack-mrkdwn` and `matrix-html` arrive with their adapters (`M8`). Asking for one
 * now **throws**, and that is the honest answer: the alternative is falling back to `plain`, which
 * would mean a Discord adapter that silently sent unformatted text and passed every test that did
 * not look at the markup. `06` §3.5.3's markup-rejection fallback is a different thing — it is a
 * platform refusing markup it was offered, not us never offering any.
 */
import type { RichText } from '@comvivo/core';
import type { ChannelCapabilities, RenderContext, RenderedPart } from '../../contract.js';
import { measureTelegramHtml, measureText, visibleText } from './measure.js';
import { renderPlain } from './plain.js';
import { sanitiseDocument } from './safety.js';
import { renderTelegramHtml } from './telegram-html.js';
import { renderWeb } from './web.js';

/** The markups `M3-T4` implements. */
export const IMPLEMENTED_MARKUPS: readonly ChannelCapabilities['markup'][] = [
  'telegram-html',
  'plain',
  'web-md',
];

/**
 * Raised when a markup's renderer has not been written yet.
 *
 * Its own class so a composition root can fail at boot with a sentence a host can act on, rather
 * than a `TypeError` from somewhere inside the outbound path on the first message.
 */
export class MarkupNotImplemented extends Error {
  readonly markup: string;
  constructor(markup: string) {
    super(
      `No renderer for the "${markup}" markup yet. ` +
        `Implemented: ${IMPLEMENTED_MARKUPS.join(', ')}. ` +
        'The rest arrive with their adapters in M8 (06 §3.5.3).',
    );
    this.name = 'MarkupNotImplemented';
    this.markup = markup;
  }
}

/**
 * Render and measure one AST for one platform.
 *
 * `plainText` is on every part, whatever the markup: `06` §3.5.3's rejection fallback re-sends it,
 * Slack's notification `text` is it, and `11` §3.10's log line quotes it under
 * `COMVIVO_DEBUG_CONTENT`. Computing it once here means those three cannot disagree.
 */
export function renderPart(
  document: RichText,
  context: RenderContext,
  capabilities: ChannelCapabilities,
): RenderedPart {
  // `08` §3.12's outbound safety pass, applied **here** rather than in each renderer: S6's rule is
  // "no platform mass-mention token survives rendering", and a check each renderer chose to call
  // would have coverage that is a reading of the code. It runs on the AST, before rendering, so the
  // `plain` renderer's Signal offsets are computed over the final text — see `sanitiseDocument`.
  const safe = sanitiseDocument(document, capabilities).document;
  const plain = renderPlain(safe, context);
  switch (capabilities.markup) {
    case 'telegram-html': {
      const html = renderTelegramHtml(safe, context, { capabilities });
      // Telegram's own unit: visible UTF-16 with the tags stripped and the entities decoded. Not
      // `measureText(html, 'utf16')`, which would count the markup and split a message that fits.
      return { payload: html, measured: measureTelegramHtml(html), plainText: plain.text };
    }
    case 'plain':
      return {
        payload: plain,
        measured: measureText(plain.text, capabilities.lengthUnit),
        plainText: plain.text,
      };
    case 'web-md':
      return {
        payload: renderWeb(safe, context),
        // The visible text, not the JSON: the dashboard's limit is about how much there is to
        // read, and the JSON's size is an implementation detail of the transport. (Matrix is the
        // platform that genuinely caps the serialised event, and `06` §3.5.4 gives it both
        // numbers; that arrives with its adapter.)
        measured: measureText(visibleText(safe), capabilities.lengthUnit),
        plainText: plain.text,
      };
    case 'discord-md':
    case 'slack-mrkdwn':
    case 'matrix-html':
      throw new MarkupNotImplemented(capabilities.markup);
  }
}

export {
  escapeTelegramAttribute,
  escapeTelegramText,
  neutraliseMassMentions,
  TELEGRAM_ENTITIES,
  ZWSP,
} from './escape.js';
export {
  measureTelegramHtml,
  measureText,
  utf8Bytes,
  visibleText,
} from './measure.js';
export {
  PLAIN_RULE,
  type PlainMentionRange,
  type PlainRender,
  type PlainStyle,
  type PlainStyleRange,
  renderPlain,
} from './plain.js';
export {
  AUDITED_MARKUPS,
  capMentions,
  type LinkPreviewPolicy,
  linkPreviewPolicy,
  MAX_MENTIONS_PER_MESSAGE,
  type MentionCapResult,
  neutraliseAllMassMentions,
  type SafetyFinding,
  type SanitisedDocument,
  safetyFindings,
  sanitiseButtonLabel,
  sanitiseDocument,
  UNIVERSAL_MASS_MENTION_TOKENS,
} from './safety.js';
export {
  renderTelegramHtml,
  TELEGRAM_EXPANDABLE_QUOTE_CHARS,
  TELEGRAM_RULE,
  type TelegramRenderOptions,
  TG_TIME_FORMAT,
} from './telegram-html.js';
export {
  isValidTelegramHtml,
  TELEGRAM_TAGS,
  type TelegramHtmlProblem,
  validateTelegramHtml,
} from './telegram-validator.js';
export {
  renderWeb,
  type WebBlock,
  type WebInline,
  type WebMention,
  type WebRender,
} from './web.js';
