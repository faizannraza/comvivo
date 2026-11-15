/**
 * Escaping and mass-mention neutralisation, directly (`06` §3.5.3, §3.6; `M3-T4`).
 *
 * `telegram-html.test.ts` exercises the escapers through the renderer, which is the right level
 * for "does a `<` in text come out as `&lt;`". This file is here for the two things that level
 * cannot reach.
 *
 * **The ordering of the replacements.** `&` has to be replaced first, or the `&` of an `&lt;` the
 * escaper just produced is escaped again and the reader sees `&amp;lt;`. Through the renderer that
 * shows up as a wrong-looking string in a handful of cases; here it is the one property stated
 * once.
 *
 * **`neutraliseMassMentions`, which the Telegram renderer never calls.** Telegram's
 * `massMentionTokens` is empty — it has no `@everyone` — so every mass-mention case in
 * `injection.test.ts` passes for Telegram without the function doing anything at all. The
 * platforms whose lists are non-empty (Discord, Slack, Matrix) have no renderer until M8. So the
 * function is tested on its own, and `M3-T10` owns proving it in a renderer that uses it. Worth
 * writing down rather than discovering later: a corpus can pass for a reason that has nothing to
 * do with the code it is meant to be covering.
 */
import { describe, expect, it } from 'vitest';
import { profiles } from '../../profiles.js';
import {
  escapeTelegramAttribute,
  escapeTelegramText,
  neutraliseMassMentions,
  TELEGRAM_ENTITIES,
  ZWSP,
} from './escape.js';

describe('escapeTelegramText (06 §3.5.3)', () => {
  it('replaces exactly the three characters', () => {
    expect(escapeTelegramText('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
  });

  it('replaces `&` first, so nothing is escaped twice', () => {
    // The single easiest thing to get wrong in an escaper. `&` last would turn `<` into `&amp;lt;`
    // and the member would read the escape sequence instead of the character they typed.
    expect(escapeTelegramText('<')).toBe('&lt;');
    expect(escapeTelegramText('&lt;')).toBe('&amp;lt;');
    expect(escapeTelegramText('&amp;')).toBe('&amp;amp;');
  });

  it('leaves a quote and an apostrophe alone in text', () => {
    // Telegram's four entities include `&quot;`, but a quote in *text* is a quote: escaping it
    // would cost two characters of a 4 096-character budget per quotation mark for nothing.
    expect(escapeTelegramText(`she said "hi" — it's fine`)).toBe(`she said "hi" — it's fine`);
  });

  it('leaves everything else alone', () => {
    for (const text of ['', 'plain', '🙂', 'مرحبا', 'a\nb', 'a\tb']) {
      expect(escapeTelegramText(text), JSON.stringify(text)).toBe(text);
    }
  });
});

describe('escapeTelegramAttribute (06 §3.5.3)', () => {
  it('adds the quote to the text set', () => {
    expect(escapeTelegramAttribute('a"b')).toBe('a&quot;b');
    expect(escapeTelegramAttribute('<&">')).toBe('&lt;&amp;&quot;&gt;');
  });

  it('is what stops an attribute being closed early', () => {
    // The one place in this module where a missed escape is an injection rather than a parse
    // failure: a `"` in a URL would close the attribute and turn the rest into markup.
    const url = 'https://e.co/" onmouseover="alert(1)';
    expect(escapeTelegramAttribute(url)).not.toContain('"');
    expect(escapeTelegramAttribute(url)).toContain('&quot;');
  });
});

describe('the entity list', () => {
  it('is the four Telegram has, and nothing else', () => {
    // `06` §3.5.3: "Only `&lt; &gt; &amp; &quot;` named entities exist; never emit others."
    expect([...TELEGRAM_ENTITIES]).toEqual(['&amp;', '&lt;', '&gt;', '&quot;']);
  });

  it('covers every entity the escapers can produce', () => {
    const produced = new Set<string>();
    for (const text of ['<', '>', '&', '"']) {
      for (const match of escapeTelegramAttribute(text).matchAll(/&[a-z]+;/g)) {
        produced.add(match[0]);
      }
    }
    expect([...produced].toSorted()).toEqual([...TELEGRAM_ENTITIES].toSorted());
  });
});

describe('neutraliseMassMentions (06 §3.6)', () => {
  it('breaks a token with a zero-width space after its first character', () => {
    // The member reads `@everyone` unchanged and the platform does not match it. Removing the
    // token would edit somebody's words, which a chat client has no business doing.
    expect(neutraliseMassMentions('@everyone read this', ['@everyone'])).toBe(
      `@${ZWSP}everyone read this`,
    );
  });

  it('breaks every occurrence, not only the first', () => {
    expect(neutraliseMassMentions('@here and @here', ['@here'])).toBe(
      `@${ZWSP}here and @${ZWSP}here`,
    );
  });

  it('breaks every token it is given', () => {
    const tokens = ['<!channel>', '<!here>', '<!everyone>'];
    const out = neutraliseMassMentions('<!channel> <!here> <!everyone>', tokens);
    for (const token of tokens) {
      expect(out, token).not.toContain(token);
    }
    expect(out.split(ZWSP)).toHaveLength(4);
  });

  it('leaves the text alone when the platform has no such token', () => {
    // Telegram's case, and the reason this function is tested here rather than only through a
    // renderer: with an empty list it is a no-op, so every mass-mention case in the injection
    // corpus passes for Telegram without this code running at all.
    expect(profiles.telegram.massMentionTokens).toEqual([]);
    expect(neutraliseMassMentions('@everyone', [])).toBe('@everyone');
  });

  it('ignores an empty token rather than inserting a space into every gap', () => {
    // A profile with `['']` in its list would otherwise have every character of every message
    // separated by a zero-width space.
    expect(neutraliseMassMentions('abc', [''])).toBe('abc');
  });

  it('does not match a token that is only a prefix of a word', () => {
    // `@hereabouts` is a word, not a mass mention — and `replaceAll` on the token would break it
    // too. That is accepted and documented: the zero-width space is invisible, so the cost of the
    // over-match is nothing a reader can see, while a word-boundary regex per token would be a
    // per-platform grammar this function has no business knowing.
    const out = neutraliseMassMentions('@hereabouts', ['@here']);
    expect(out).toBe(`@${ZWSP}hereabouts`);
    expect(out.replaceAll(ZWSP, '')).toBe('@hereabouts');
  });

  it('is applied to every profile’s own list', () => {
    // Each platform declares its own, so a new platform cannot forget to be covered by a
    // hard-coded list somewhere in a renderer.
    for (const [name, profile] of Object.entries(profiles)) {
      for (const token of profile.massMentionTokens) {
        expect(
          neutraliseMassMentions(token, profile.massMentionTokens),
          `${name}/${token}`,
        ).not.toBe(token);
      }
    }
  });
});
