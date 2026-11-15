/**
 * The `web-md` renderer (`06` §3.5.3; `M3-T4`).
 *
 * The one renderer whose payload is not a string. `06` §3.5.3: "none (AST JSON; the dashboard
 * renders React elements, **never** `innerHTML`)", with "resolved mentions embedded".
 *
 * ## Why there is a renderer at all, if the payload is the AST
 *
 * Two things have to happen before the dashboard sees it, and neither belongs in a React
 * component.
 *
 * **Mentions are resolved here.** The AST stores a `memberId` and a `fallback` written when the
 * message was composed; the display name can have changed since, and `canPing` is a property of
 * *this* send (`06` §3.6: it is false when the constitution forbids a ping on a proactive
 * message). A component reading `RenderContext` itself would be a component that needs the group's
 * roster, which is how a dashboard screen ends up fetching members to draw a message.
 *
 * **Nothing is escaped, and that is the point.** There is no markup to break, because the
 * dashboard never builds a string: it walks this tree into elements. That is the whole security
 * argument for the web channel, and it only holds if the payload stays a tree all the way to the
 * component — so this function returns one, and `measure` counts its visible text rather than its
 * JSON.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import type { MemberId } from '@comvivo/shared';
import type { RenderContext, ResolvedMention } from '../../contract.js';

/** A mention with the names this send resolved, embedded for the dashboard (`06` §3.5.3). */
export interface WebMention {
  readonly memberId?: MemberId;
  readonly platformUserId?: string;
  readonly displayName: string;
  /**
   * Whether this mention is a ping on this send.
   *
   * Carried into the payload rather than dropped, because the dashboard shows the two differently:
   * a mention that pings is a link to the member, and one that does not is the name in plain
   * weight. A component that could not tell them apart would have to choose one, and either choice
   * misreports what the group's constitution decided.
   */
  readonly canPing: boolean;
}

/** The AST, with each `mention` node's resolution attached. Otherwise `06` §3.5.1's tree. */
export type WebInline =
  | Exclude<Inline, { t: 'mention' }>
  | { readonly t: 'mention'; readonly fallback: string; readonly resolved: WebMention };

export type WebBlock =
  | { readonly t: 'p'; readonly c: readonly WebInline[] }
  | { readonly t: 'h'; readonly level: 1 | 2 | 3; readonly c: readonly WebInline[] }
  | {
      readonly t: 'list';
      readonly ordered: boolean;
      readonly start?: number | undefined;
      readonly items: readonly (readonly WebBlock[])[];
    }
  | { readonly t: 'code'; readonly lang?: string | undefined; readonly text: string }
  | { readonly t: 'quote'; readonly c: readonly WebBlock[] }
  | { readonly t: 'hr' };

export interface WebRender {
  readonly v: 1;
  readonly blocks: readonly WebBlock[];
}

/** Render for the dashboard: the AST with mentions resolved. */
export function renderWeb(document: RichText, context: RenderContext): WebRender {
  return { v: 1, blocks: document.blocks.map((block) => webBlock(block, context)) };
}

function webBlock(block: Block, context: RenderContext): WebBlock {
  switch (block.t) {
    case 'p':
      return { t: 'p', c: block.c.map((inline) => webInline(inline, context)) };
    case 'h':
      return { t: 'h', level: block.level, c: block.c.map((inline) => webInline(inline, context)) };
    case 'list':
      return {
        t: 'list',
        ordered: block.ordered,
        ...(block.start === undefined ? {} : { start: block.start }),
        items: block.items.map((item) => item.map((child) => webBlock(child, context))),
      };
    case 'code':
      return {
        t: 'code',
        ...(block.lang === undefined ? {} : { lang: block.lang }),
        text: block.text,
      };
    case 'quote':
      // **Not** flattened, unlike Telegram: the dashboard can nest a blockquote, and `06` §3.5.1
      // allows two levels. Flattening here would lose a distinction the only client that can show
      // it is able to show.
      return { t: 'quote', c: block.c.map((child) => webBlock(child, context)) };
    case 'hr':
      return { t: 'hr' };
  }
}

function webInline(inline: Inline, context: RenderContext): WebInline {
  if (inline.t !== 'mention') return inline;
  return { t: 'mention', fallback: inline.fallback, resolved: resolve(inline, context) };
}

function resolve(inline: Extract<Inline, { t: 'mention' }>, context: RenderContext): WebMention {
  if (inline.target.kind === 'platform_user') {
    return {
      platformUserId: inline.target.platformUserId,
      displayName: stripAt(inline.fallback),
      // An inbound mention of somebody with no identity in this group. The dashboard has nobody to
      // link to, so it is a name, not a ping.
      canPing: false,
    };
  }
  const memberId = inline.target.memberId;
  const found: ResolvedMention | undefined = context.mentions[memberId];
  if (found === undefined) {
    // Composed when the member existed and sent after they left. The fallback is what the message
    // said at the time, which is the honest thing to show.
    return { memberId, displayName: stripAt(inline.fallback), canPing: false };
  }
  return {
    memberId,
    ...(found.platformUserId === undefined ? {} : { platformUserId: found.platformUserId }),
    displayName: found.displayName,
    canPing: found.canPing,
  };
}

/**
 * `"@Ana"` → `"Ana"`.
 *
 * The AST's `fallback` is `"@Display Name"` (`06` §3.5.1) and the dashboard renders the `@` itself,
 * as part of the mention chip. Leaving it in produces `@@Ana` on exactly the mentions that could
 * not be resolved — the ones nobody looks at until a member has left the group.
 */
function stripAt(fallback: string): string {
  return fallback.startsWith('@') ? fallback.slice(1) : fallback;
}
