/**
 * Escaping, per markup (`06` §3.5.3; `M3-T4`).
 *
 * The one module in this package where being approximately right is the same as being wrong. A
 * missed `<` in Telegram HTML is not a cosmetic bug: Telegram rejects the whole message with
 * `400 can't parse entities`, so a member gets nothing, and the one input that triggers it is a
 * message somebody else wrote. A missed `&` is worse — it does not fail, it silently renders
 * `&lt;` where the member typed `<`.
 *
 * ## Why each table is written out rather than derived
 *
 * `06` §3.5.3 gives a different escape set per markup, and the differences are not arbitrary:
 * Telegram HTML has **four** named entities and "never emit others"; Slack mrkdwn has no
 * backslash escape at all, so it needs a zero-width space instead; `plain` escapes nothing,
 * because there is no markup to break. A shared "escape HTML" helper would have to be configured
 * per markup anyway, and the configuration is the part worth reading.
 */

/**
 * Telegram HTML text content (`06` §3.5.3).
 *
 * Exactly three replacements, and `&` **first** — otherwise the `&` of an `&lt;` this function
 * just produced is escaped again and the member sees `&amp;lt;`. That ordering is the single
 * easiest thing to get wrong in an escaper and the reason this is not a chain of `.replace` calls
 * in a renderer.
 *
 * `'` and `"` are deliberately **not** escaped here: Telegram's own documentation lists
 * `&lt; &gt; &amp; &quot;` as the entities that exist, and an apostrophe in text is text. The
 * quote matters only inside an attribute value, which is `escapeTelegramAttribute`'s job.
 */
export function escapeTelegramText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * A Telegram HTML attribute value — `href`, `unix`, `class` (`06` §3.5.3).
 *
 * The text set plus `"`. Attribute values are always double-quoted in this renderer, so a `"` in a
 * URL would close the attribute and turn the rest of it into markup: the one place in this module
 * where a missed escape is an injection rather than a parse failure.
 */
export function escapeTelegramAttribute(value: string): string {
  return escapeTelegramText(value).replaceAll('"', '&quot;');
}

/**
 * The entities Telegram HTML may contain (`06` §3.5.3: "never emit others").
 *
 * Exported so `telegram-html.test.ts` can assert that no renderer output holds any other `&…;`
 * sequence — which is the check that catches a future renderer reaching for `&nbsp;` or `&mdash;`.
 * Telegram's parser rejects an unknown entity, so that would be a 400 on a message nobody could
 * reproduce without the exact text.
 */
export const TELEGRAM_ENTITIES: readonly string[] = ['&amp;', '&lt;', '&gt;', '&quot;'];

/** A zero-width space, which is how a markup with no escape character gets one. */
export const ZWSP = String.fromCharCode(0x200b);

/**
 * Break the platform's mass-mention tokens, leaving them readable (`06` §3.6, §3.5.3).
 *
 * `06` §3.6: `@everyone`, `@here`, `<!channel>`, `<!here>`, `<!everyone>` and `@room` are **never
 * produced**. They are never produced by the *engine* either, and that is exactly why this exists:
 * the tokens arrive in **content** — a member quotes one, or a model repeats one back — so the
 * place to stop them is the renderer, not the thing that composed the message.
 *
 * A zero-width space after the first character, rather than removing the token: the member reads
 * `@everyone` unchanged and the platform does not match it. Removing it would edit somebody's
 * words, which a chat client has no business doing.
 *
 * Driven by `ChannelCapabilities.massMentionTokens` rather than by a fixed list, so a platform that
 * has no such token (Telegram's list is empty) pays nothing and a new platform declares its own.
 * `M3-T10` owns the corpus that proves each one is actually broken.
 */
export function neutraliseMassMentions(text: string, tokens: readonly string[]): string {
  let out = text;
  for (const token of tokens) {
    if (token.length === 0) continue;
    out = out.replaceAll(token, `${token.slice(0, 1)}${ZWSP}${token.slice(1)}`);
  }
  return out;
}
