/**
 * `plain`, `web-md`, measurement and the entry point (`06` §3.5.3–§3.5.4; `M3-T4`).
 *
 * The three things here that a reviewer cannot check by reading:
 *
 *  - **the plain renderer's offsets.** On Signal a `start:length:STYLE` range *is* the formatting,
 *    and a range that is one character out styles the wrong word. They are only knowable while
 *    walking, so they are asserted against the text they describe rather than against a literal;
 *  - **what each platform counts.** Telegram counts visible UTF-16 after tags and entities; Signal
 *    counts UTF-8 bytes. `06` §3.5.4 sets the safety factor at 1.0 "because measurement is exact",
 *    so there is no slack: an over-count splits a message that fitted, and an under-count is a
 *    rejected send;
 *  - **that `renderPart` pairs the renderer with the right measure.** The splitter asks one and
 *    then the other, so a mismatch is messages split in the wrong place on one platform only.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import { BRAND, type MemberId } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import type { RenderContext } from '../../contract.js';
import { profiles } from '../../profiles.js';
import { MarkupNotImplemented, renderPart } from './index.js';
import { measureTelegramHtml, measureText, utf8Bytes, visibleText } from './measure.js';
import { PLAIN_RULE, type PlainRender, renderPlain } from './plain.js';
import { renderTelegramHtml } from './telegram-html.js';
import { renderWeb, type WebRender } from './web.js';

const ANA = 'mbr_01jd0000000000000000000000' as MemberId;
const CAS = 'mbr_01jd0000000000000000000002' as MemberId;

const CONTEXT: RenderContext = {
  mentions: {
    [ANA]: { displayName: 'Ana', username: 'ana_g', platformUserId: '42', canPing: true },
    [CAS]: { displayName: 'Cas', platformUserId: '44', canPing: false },
  },
  self: { platformUserId: '1', displayName: BRAND.displayName, flags: {} },
  linkPreview: false,
  locale: 'en',
};

const doc = (...blocks: Block[]): RichText => ({ v: 1, blocks });
const p = (...c: Inline[]): Block => ({ t: 'p', c });
const text = (
  value: string,
  ...marks: NonNullable<Extract<Inline, { t: 'text' }>['marks']>
): Inline => (marks.length === 0 ? { t: 'text', text: value } : { t: 'text', text: value, marks });

function plain(...blocks: Block[]): PlainRender {
  return renderPlain(doc(...blocks), CONTEXT);
}

/** The substring a range describes, which is the only way to check an offset. */
function sliceOf(rendered: PlainRender, index: number): string {
  const range = rendered.styles[index];
  if (range === undefined) throw new Error(`no style range at ${String(index)}`);
  return rendered.text.slice(range.start, range.start + range.length);
}

describe('the plain renderer (06 §3.5.3)', () => {
  it('drops the markup and keeps the words', () => {
    expect(plain(p(text('a'), text('b', 'b'), text('c', 'i'))).text).toBe('abc');
  });

  it('renders a heading as a line, not a decoration', () => {
    // `#` would read as the markup it is on a platform that has none.
    expect(plain({ t: 'h', level: 1, c: [text('T')] }, p(text('x'))).text).toBe('T\n\nx');
  });

  it('renders lists with markers and nesting', () => {
    expect(plain({ t: 'list', ordered: false, items: [[p(text('a'))], [p(text('b'))]] }).text).toBe(
      '• a\n• b',
    );
    expect(
      plain({ t: 'list', ordered: true, start: 3, items: [[p(text('a'))], [p(text('b'))]] }).text,
    ).toBe('3. a\n4. b');
  });

  it('renders a quote with `> ` on every line', () => {
    expect(plain({ t: 'quote', c: [p(text('a')), p(text('b'))] }).text).toBe('> a\n>\n> b');
  });

  it('renders a rule as an em-dash line', () => {
    expect(plain({ t: 'hr' }).text).toBe(PLAIN_RULE);
  });

  it('renders a link as `label (url)`, or as the URL alone when they match', () => {
    expect(plain(p({ t: 'link', url: 'https://e.co', c: [{ t: 'text', text: 'l' }] })).text).toBe(
      'l (https://e.co)',
    );
    // A bare URL written twice is the most common way a plain fallback looks broken.
    expect(
      plain(p({ t: 'link', url: 'https://e.co', c: [{ t: 'text', text: 'https://e.co' }] })).text,
    ).toBe('https://e.co');
    expect(plain(p({ t: 'link', url: 'https://e.co', c: [] })).text).toBe('https://e.co');
  });

  it('renders a mention as `@DisplayName`', () => {
    expect(
      plain(p({ t: 'mention', target: { kind: 'member', memberId: ANA }, fallback: '@A' })).text,
    ).toBe('@Ana');
  });

  it('renders a time node as its pre-rendered fallback', () => {
    expect(plain(p({ t: 'time', at: '2026-11-15T18:00:00Z', fallback: 'Sat 18:00' })).text).toBe(
      'Sat 18:00',
    );
  });
});

describe('the plain renderer’s style ranges (06 §3.5.3, Signal)', () => {
  it('describes exactly the text it covers', () => {
    const rendered = plain(p(text('plain '), text('bold', 'b'), text(' tail')));
    expect(rendered.text).toBe('plain bold tail');
    expect(rendered.styles).toHaveLength(1);
    expect(sliceOf(rendered, 0)).toBe('bold');
    expect(rendered.styles[0]?.style).toBe('BOLD');
  });

  it('emits one range per mark on a run that has several', () => {
    // signal-cli accepts overlapping ranges, so a bold-and-italic run is two of them rather than a
    // choice between them.
    const rendered = plain(p(text('x', 'b', 'i')));
    expect(rendered.styles.map((range) => range.style).toSorted()).toEqual(['BOLD', 'ITALIC']);
    for (let index = 0; index < rendered.styles.length; index += 1) {
      expect(sliceOf(rendered, index)).toBe('x');
    }
  });

  it('maps each mark to its Signal style', () => {
    expect(plain(p(text('x', 'b'))).styles[0]?.style).toBe('BOLD');
    expect(plain(p(text('x', 'i'))).styles[0]?.style).toBe('ITALIC');
    expect(plain(p(text('x', 's'))).styles[0]?.style).toBe('STRIKETHROUGH');
    expect(plain(p(text('x', 'spoiler'))).styles[0]?.style).toBe('SPOILER');
  });

  it('covers inline code and fenced blocks with MONOSPACE', () => {
    const inline = plain(p(text('a '), { t: 'code', text: 'x' }));
    expect(sliceOf(inline, 0)).toBe('x');
    expect(inline.styles[0]?.style).toBe('MONOSPACE');
    const fenced = plain({ t: 'code', text: 'let x = 1' });
    expect(sliceOf(fenced, 0)).toBe('let x = 1');
  });

  it('emits no range for an empty code node', () => {
    // A zero-length range is malformed on Signal rather than merely useless.
    expect(plain(p({ t: 'code', text: '' })).styles).toEqual([]);
  });

  it('keeps every range inside the text, through a quote’s prefixes', () => {
    // The hard case: `> ` is added to every line *after* the children are rendered, so each range
    // shifts by two per preceding newline. An offset computed before the prefix would point two
    // characters earlier per line — invisible on a one-line quote and wrong on every other.
    const rendered = plain({
      t: 'quote',
      c: [p(text('first', 'b')), p(text('second'), text('bold', 'b'))],
    });
    expect(rendered.text).toBe('> first\n>\n> secondbold');
    for (const range of rendered.styles) {
      expect(range.start, rendered.text).toBeGreaterThanOrEqual(0);
      expect(range.start + range.length, rendered.text).toBeLessThanOrEqual(rendered.text.length);
    }
    // And they describe the right words, which is the assertion a bounds check alone would miss:
    // the first version of the shift over-counted the blank line's one-character prefix, so both
    // ranges were one character off and the second ran past the end.
    expect(rendered.styles.map((_, index) => sliceOf(rendered, index)).toSorted()).toEqual([
      'bold',
      'first',
    ]);
  });

  it('emits a mention range only when the member may be pinged', () => {
    // On Signal the range **is** the ping, so `06` §3.6's "a mention that cannot ping renders as
    // the plain fallback" is implemented by not emitting one.
    const pingable = plain(
      p({ t: 'mention', target: { kind: 'member', memberId: ANA }, fallback: '@A' }),
    );
    expect(pingable.mentions).toEqual([{ start: 0, length: 4, platformUserId: '42' }]);
    const silent = plain(
      p({ t: 'mention', target: { kind: 'member', memberId: CAS }, fallback: '@C' }),
    );
    expect(silent.mentions).toEqual([]);
    expect(silent.text).toBe('@Cas');
  });

  it('counts offsets in UTF-16, which is what signal-cli counts', () => {
    // An emoji is two UTF-16 units and one code point. A range counted in code points would be
    // one short for every emoji before it.
    const rendered = plain(p(text('🙂'), text('x', 'b')));
    expect(rendered.text).toBe('🙂x');
    expect(rendered.styles[0]?.start).toBe(2);
    expect(sliceOf(rendered, 0)).toBe('x');
  });
});

describe('the web renderer (06 §3.5.3)', () => {
  it('returns the AST, not a string', () => {
    const web: WebRender = renderWeb(doc(p(text('x', 'b'))), CONTEXT);
    expect(web).toEqual({
      v: 1,
      blocks: [{ t: 'p', c: [{ t: 'text', text: 'x', marks: ['b'] }] }],
    });
  });

  it('embeds each mention’s resolution', () => {
    const web = renderWeb(
      doc(p({ t: 'mention', target: { kind: 'member', memberId: ANA }, fallback: '@A' })),
      CONTEXT,
    );
    expect(web.blocks[0]).toEqual({
      t: 'p',
      c: [
        {
          t: 'mention',
          fallback: '@A',
          resolved: { memberId: ANA, platformUserId: '42', displayName: 'Ana', canPing: true },
        },
      ],
    });
  });

  it('carries `canPing` so the dashboard can show the difference', () => {
    const web = renderWeb(
      doc(p({ t: 'mention', target: { kind: 'member', memberId: CAS }, fallback: '@C' })),
      CONTEXT,
    );
    const mention = web.blocks[0]?.t === 'p' ? web.blocks[0].c[0] : undefined;
    expect(mention?.t === 'mention' ? mention.resolved.canPing : undefined).toBe(false);
  });

  it('strips the `@` from an unresolved fallback, so the chip is not `@@Ana`', () => {
    const gone = 'mbr_01jd000000000000000000000z' as MemberId;
    const web = renderWeb(
      doc(p({ t: 'mention', target: { kind: 'member', memberId: gone }, fallback: '@Gone' })),
      CONTEXT,
    );
    const mention = web.blocks[0]?.t === 'p' ? web.blocks[0].c[0] : undefined;
    expect(mention?.t === 'mention' ? mention.resolved.displayName : undefined).toBe('Gone');
  });

  it('keeps a nested quote, unlike Telegram', () => {
    // The dashboard can nest a blockquote and `06` §3.5.1 allows two levels, so flattening here
    // would lose a distinction the only client that can show it is able to show.
    const web = renderWeb(doc({ t: 'quote', c: [{ t: 'quote', c: [p(text('x'))] }] }), CONTEXT);
    expect(web.blocks[0]?.t).toBe('quote');
    expect(web.blocks[0]?.t === 'quote' ? web.blocks[0].c[0]?.t : undefined).toBe('quote');
  });
});

describe('measurement (06 §3.5.4)', () => {
  it('counts UTF-8 bytes where a platform counts bytes', () => {
    // Signal's limit is bytes, so a family writing in Arabic reaches it at a third of the
    // characters an English-speaking one does.
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('é')).toBe(2);
    expect(utf8Bytes('中')).toBe(3);
    expect(utf8Bytes('🙂')).toBe(4);
    expect(measureText('🙂', 'utf8-bytes')).toBe(4);
    expect(measureText('🙂', 'utf16')).toBe(2);
  });

  it('counts Telegram’s visible length, with tags stripped and entities decoded', () => {
    // `06` §3.5.4: Telegram's 4 096 is "characters after entities parsing". `<b>a &amp; b</b>` is
    // five visible characters, not sixteen.
    expect(measureTelegramHtml('<b>a &amp; b</b>')).toBe(5);
    expect(measureTelegramHtml('a&lt;b')).toBe(3);
    expect(measureTelegramHtml('<a href="https://e.co">l</a>')).toBe(1);
    expect(measureTelegramHtml('')).toBe(0);
  });

  it('is not fooled by a `>` inside an attribute value', () => {
    // The case that makes this a scanner rather than a regex: the renderer escapes `>` in text but
    // a URL may hold one, and a naive strip would end the tag early and count the rest as text.
    expect(measureTelegramHtml('<a href="https://e.co/?a=>">l</a>')).toBe(1);
  });

  it('counts a `tg-time` as the fallback a reader sees', () => {
    // Its attributes are not visible and its child is. An AST-based estimate would get both wrong.
    expect(measureTelegramHtml('<tg-time unix="0" format="wDt">Sat 18:00</tg-time>')).toBe(9);
  });

  it('counts an unescaped angle bracket as a character rather than skipping it', () => {
    // An escaping bug, which the validator reports — but the measure must not under-count and
    // produce a message the platform then rejects for length as well.
    expect(measureTelegramHtml('a < b')).toBe(5);
  });

  it('agrees with the renderer about what a reader sees', () => {
    // The property that matters: the number the splitter budgets against has to be the length of
    // the text in the bubble, for an AST with every node kind in it.
    const document = doc(
      { t: 'h', level: 2, c: [text('Title')] },
      p(text('a & b'), { t: 'br' }, text('c', 'b')),
      { t: 'code', lang: 'js', text: 'let x = 1' },
      { t: 'list', ordered: true, items: [[p(text('one'))], [p(text('two'))]] },
      { t: 'quote', c: [p(text('q'))] },
      { t: 'hr' },
      p({ t: 'link', url: 'https://e.co', c: [{ t: 'text', text: 'l' }] }),
      p({ t: 'mention', target: { kind: 'member', memberId: ANA }, fallback: '@A' }),
    );
    const html = renderTelegramHtml(document, CONTEXT, { capabilities: profiles.telegram });
    const measured = measureTelegramHtml(html);
    // The visible text is the HTML with tags removed and entities decoded, which is what the
    // scanner counts — so this is a second, independent computation of the same number.
    const stripped = html
      .replaceAll(/<[^>]*>/g, '')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"');
    expect(measured).toBe(stripped.length);
  });

  it('gives the AST’s visible text for the payloads that have no string form', () => {
    expect(visibleText(doc(p(text('a')), p(text('b'))))).toBe('a\nb');
    expect(visibleText(doc({ t: 'code', text: 'x' }))).toBe('x');
    expect(visibleText(doc({ t: 'hr' }))).toBe('');
  });
});

describe('renderPart (06 §3.5.3–§3.5.4)', () => {
  const document = doc(p(text('a & b'), text('c', 'b')));

  it('pairs Telegram’s renderer with Telegram’s measure', () => {
    const part = renderPart(document, CONTEXT, profiles.telegram);
    expect(part.payload).toBe('a &amp; b<b>c</b>');
    // 6 visible characters, not the 17 of markup — which is the whole reason the pairing is made
    // here rather than by the caller.
    expect(part.measured).toBe(6);
    expect(part.plainText).toBe('a & bc');
  });

  it('measures Signal in bytes and the web in UTF-16', () => {
    const emoji = doc(p(text('🙂')));
    expect(renderPart(emoji, CONTEXT, profiles.signal).measured).toBe(4);
    expect(renderPart(emoji, CONTEXT, profiles.web).measured).toBe(2);
  });

  it('carries `plainText` on every markup', () => {
    // `06` §3.5.3's rejection fallback re-sends it, Slack's notification text is it, and the debug
    // log quotes it. Computing it once here is what stops the three from disagreeing.
    for (const profile of [profiles.telegram, profiles.signal, profiles.web]) {
      expect(renderPart(document, CONTEXT, profile).plainText, profile.markup).toBe('a & bc');
    }
  });

  it('gives the web channel a tree, not a string', () => {
    const part = renderPart(document, CONTEXT, profiles.web);
    expect(typeof part.payload).toBe('object');
    expect((part.payload as WebRender).v).toBe(1);
  });

  it('refuses a markup whose renderer is not written yet, by name', () => {
    // Not a fallback to `plain`: that would be a Discord adapter silently sending unformatted text
    // and passing every test that did not look at the markup.
    for (const profile of [profiles.discord, profiles.slack, profiles.matrix]) {
      expect(() => renderPart(document, CONTEXT, profile), profile.markup).toThrow(
        MarkupNotImplemented,
      );
      expect(() => renderPart(document, CONTEXT, profile), profile.markup).toThrow(profile.markup);
    }
  });
});

describe('the web renderer’s remaining node kinds', () => {
  it('carries every block kind through unchanged', () => {
    // The dashboard renders each of these as its own element, so a renderer that dropped one
    // would show a message with a gap — and the payload is a tree, so a missing kind is a missing
    // key rather than a visibly broken string.
    const document = doc(
      { t: 'h', level: 3, c: [text('T')] },
      { t: 'list', ordered: true, start: 2, items: [[p(text('a'))], [p(text('b'))]] },
      { t: 'code', lang: 'ts', text: 'let x = 1' },
      { t: 'code', text: 'no lang' },
      { t: 'quote', c: [p(text('q'))] },
      { t: 'hr' },
    );
    expect(renderWeb(document, CONTEXT)).toEqual({
      v: 1,
      blocks: [
        { t: 'h', level: 3, c: [{ t: 'text', text: 'T' }] },
        {
          t: 'list',
          ordered: true,
          start: 2,
          items: [
            [{ t: 'p', c: [{ t: 'text', text: 'a' }] }],
            [{ t: 'p', c: [{ t: 'text', text: 'b' }] }],
          ],
        },
        { t: 'code', lang: 'ts', text: 'let x = 1' },
        { t: 'code', text: 'no lang' },
        { t: 'quote', c: [{ t: 'p', c: [{ t: 'text', text: 'q' }] }] },
        { t: 'hr' },
      ],
    });
  });

  it('omits `start` and `lang` rather than carrying `undefined`', () => {
    // `exactOptionalPropertyTypes` makes an absent key and an explicit `undefined` different, and
    // the payload is compared for equality in the dashboard's cache.
    const web = renderWeb(doc({ t: 'list', ordered: false, items: [] }), CONTEXT);
    expect(web.blocks[0]).not.toHaveProperty('start');
    expect(renderWeb(doc({ t: 'code', text: 'x' }), CONTEXT).blocks[0]).not.toHaveProperty('lang');
  });

  it('resolves a mention inside a list, a quote and a heading', () => {
    // Mentions are resolved wherever they appear, which a walk that only handled paragraphs would
    // get wrong exactly where a reply puts a name: in a list of who is doing what.
    const mention: Inline = {
      t: 'mention',
      target: { kind: 'member', memberId: ANA },
      fallback: '@A',
    };
    const web = renderWeb(
      doc(
        { t: 'h', level: 1, c: [mention] },
        { t: 'list', ordered: false, items: [[p(mention)]] },
        { t: 'quote', c: [p(mention)] },
      ),
      CONTEXT,
    );
    const names = JSON.stringify(web).matchAll(/"displayName":"([^"]*)"/g);
    expect([...names].map((match) => match[1])).toEqual(['Ana', 'Ana', 'Ana']);
  });

  it('marks a platform-user mention unpingable, with the `@` stripped', () => {
    const web = renderWeb(
      doc(
        p({
          t: 'mention',
          target: { kind: 'platform_user', platformUserId: '99' },
          fallback: '@Someone',
        }),
      ),
      CONTEXT,
    );
    const mention = web.blocks[0]?.t === 'p' ? web.blocks[0].c[0] : undefined;
    expect(mention?.t === 'mention' ? mention.resolved : undefined).toEqual({
      platformUserId: '99',
      displayName: 'Someone',
      canPing: false,
    });
  });

  it('leaves a fallback with no `@` alone', () => {
    const gone = 'mbr_01jd000000000000000000000z' as MemberId;
    const web = renderWeb(
      doc(p({ t: 'mention', target: { kind: 'member', memberId: gone }, fallback: 'Gone' })),
      CONTEXT,
    );
    const mention = web.blocks[0]?.t === 'p' ? web.blocks[0].c[0] : undefined;
    expect(mention?.t === 'mention' ? mention.resolved.displayName : undefined).toBe('Gone');
  });
});

describe('visibleText covers every node kind', () => {
  it('reads a list, a quote, a link, a mention, a time and a break', () => {
    const document = doc(
      { t: 'list', ordered: false, items: [[p(text('a'))], [p(text('b'))]] },
      { t: 'quote', c: [p(text('q'))] },
      p({ t: 'link', url: 'https://e.co', c: [{ t: 'text', text: 'l' }] }),
      p({ t: 'mention', target: { kind: 'member', memberId: ANA }, fallback: '@A' }),
      p({ t: 'time', at: '2026-11-15T18:00:00Z', fallback: 'Sat' }),
      p(text('x'), { t: 'br' }, text('y')),
      p({ t: 'code', text: 'c' }),
    );
    expect(visibleText(document)).toBe('a\nb\nq\nl\n@A\nSat\nx\ny\nc');
  });

  it('is empty for an empty document', () => {
    expect(visibleText(doc())).toBe('');
  });
});

describe('the measure’s remaining shapes', () => {
  it('counts a `pre`/`code` block’s contents', () => {
    expect(measureTelegramHtml('<pre><code class="language-js">let x = 1</code></pre>')).toBe(9);
  });

  it('counts an expandable blockquote’s contents', () => {
    expect(measureTelegramHtml('<blockquote expandable>abc</blockquote>')).toBe(3);
  });

  it('counts a bare `&` that is not an entity as one character', () => {
    // An escaping bug produces this, and the measure must not under-count and let a message
    // through that the platform then rejects for length as well as for parsing.
    expect(measureTelegramHtml('a & b')).toBe(5);
    expect(measureTelegramHtml('&amp')).toBe(4);
  });

  it('counts an unterminated tag as text rather than skipping the rest', () => {
    expect(measureTelegramHtml('a <b')).toBe(4);
  });
});
