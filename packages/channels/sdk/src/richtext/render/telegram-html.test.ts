/**
 * The `telegram-html` renderer, case by case (`06` §3.5.3; `M3-T4`).
 *
 * `injection.test.ts` asserts the property every output must have. This file asserts the mapping:
 * what each node *becomes*, which is the half a validator cannot check — `<i>` where `<b>` belongs
 * validates perfectly.
 *
 * The expectations are written out because there are forty of them, not a hundred and fifty: the
 * renderer's input is the AST, which `parse.corpus.test.ts` has already pinned, so this does not
 * need to re-enumerate markdown. What it needs to cover is every node kind, every mark combination
 * that changes the nesting, and the three mention outcomes.
 */
import type { Block, Inline, RichText } from '@comvivo/core';
import { BRAND, type MemberId } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import type { RenderContext } from '../../contract.js';
import { profiles } from '../../profiles.js';
import {
  renderTelegramHtml,
  TELEGRAM_EXPANDABLE_QUOTE_CHARS,
  TELEGRAM_RULE,
} from './telegram-html.js';
import {
  isValidTelegramHtml,
  telegramAttributes,
  validateTelegramHtml,
} from './telegram-validator.js';

const ANA = 'mbr_01jd0000000000000000000000' as MemberId;
const BEA = 'mbr_01jd0000000000000000000001' as MemberId;
const CAS = 'mbr_01jd0000000000000000000002' as MemberId;

/**
 * Three members, covering `06` §3.6's three mention outcomes.
 *
 * Ana has a public username, Bea has only a numeric id, and Cas cannot be pinged at all — which is
 * the case the constitution produces on a proactive message, and the one a renderer gets wrong by
 * reaching for the id anyway.
 */
const CONTEXT: RenderContext = {
  mentions: {
    [ANA]: { displayName: 'Ana', username: 'ana_g', platformUserId: '42', canPing: true },
    [BEA]: { displayName: 'Bea <Smith>', platformUserId: '43', canPing: true },
    [CAS]: { displayName: 'Cas', platformUserId: '44', canPing: false },
  },
  self: { platformUserId: '1', displayName: BRAND.displayName, flags: {} },
  linkPreview: false,
  locale: 'en',
};

function render(...blocks: Block[]): string {
  const document: RichText = { v: 1, blocks };
  const html = renderTelegramHtml(document, CONTEXT, { capabilities: profiles.telegram });
  // Every case is validated as well as compared, so a correct-looking expectation that Telegram
  // would reject cannot be written down by accident.
  expect(validateTelegramHtml(html), html).toEqual([]);
  return html;
}

const p = (...c: Inline[]): Block => ({ t: 'p', c });
const text = (
  value: string,
  ...marks: NonNullable<Extract<Inline, { t: 'text' }>['marks']>
): Inline => (marks.length === 0 ? { t: 'text', text: value } : { t: 'text', text: value, marks });

describe('marks (06 §3.5.3)', () => {
  it('maps each one to its tag', () => {
    expect(render(p(text('x', 'b')))).toBe('<b>x</b>');
    expect(render(p(text('x', 'i')))).toBe('<i>x</i>');
    expect(render(p(text('x', 's')))).toBe('<s>x</s>');
    expect(render(p(text('x', 'spoiler')))).toBe('<tg-spoiler>x</tg-spoiler>');
  });

  it('nests them in the order §3.5.3 fixes: b > i > s > tg-spoiler', () => {
    // Not alphabetical and not the order they were listed in: Telegram accepts some orders and
    // not others, and the failures are asymmetric. One fixed order answers the question once.
    expect(render(p(text('x', 'b', 'i')))).toBe('<b><i>x</i></b>');
    expect(render(p(text('x', 'b', 'i', 's', 'spoiler')))).toBe(
      '<b><i><s><tg-spoiler>x</tg-spoiler></s></i></b>',
    );
  });

  it('puts the link outside the marks', () => {
    // `06` §3.5.3's order is `a > b > i > s > tg-spoiler`, so the anchor wraps everything. An
    // `<a>` inside a `<b>` is accepted by the parser and loses the link on some clients.
    expect(
      render(p({ t: 'link', url: 'https://e.co', c: [{ t: 'text', text: 'l', marks: ['b'] }] })),
    ).toBe('<a href="https://e.co"><b>l</b></a>');
  });

  it('escapes the text inside a mark', () => {
    expect(render(p(text('a < b', 'b')))).toBe('<b>a &lt; b</b>');
  });
});

describe('inline nodes (06 §3.5.3)', () => {
  it('renders inline code with nothing nested inside', () => {
    expect(render(p({ t: 'code', text: '<b>x</b> & y' }))).toBe(
      '<code>&lt;b&gt;x&lt;/b&gt; &amp; y</code>',
    );
  });

  it('renders a link, escaping the URL as an attribute', () => {
    expect(
      render(p({ t: 'link', url: 'https://e.co/?a=1&b=2', c: [{ t: 'text', text: 'l' }] })),
    ).toBe('<a href="https://e.co/?a=1&amp;b=2">l</a>');
  });

  it('renders a line break as a newline, not a tag', () => {
    expect(render(p(text('a'), { t: 'br' }, text('b')))).toBe('a\nb');
  });

  it('renders a time node as `tg-time` with the fallback as its child', () => {
    // The child is what a client that does not know the tag shows, which is every client except
    // recent Telegram — so the fallback is not optional decoration.
    // 1794765600 is `2026-11-15T18:00:00Z` in whole seconds, round-tripped rather than worked out
    // by hand — the first version of this expectation was a day out.
    expect(render(p({ t: 'time', at: '2026-11-15T18:00:00Z', fallback: 'Sat 18:00' }))).toBe(
      '<tg-time unix="1794765600" format="wDt">Sat 18:00</tg-time>',
    );
    expect(new Date(1794765600 * 1000).toISOString()).toBe('2026-11-15T18:00:00.000Z');
  });

  it('escapes a time node’s fallback', () => {
    expect(render(p({ t: 'time', at: '2026-11-15T18:00:00Z', fallback: 'a & b' }))).toBe(
      '<tg-time unix="1794765600" format="wDt">a &amp; b</tg-time>',
    );
  });
});

describe('mentions (06 §3.5.3, §3.6)', () => {
  const mention = (memberId: MemberId, fallback: string): Inline => ({
    t: 'mention',
    target: { kind: 'member', memberId },
    fallback,
  });

  it('uses `@username` when the member has a public one', () => {
    // Shorter than the anchor, survives a forward, and still pings — which matters against a
    // 4 096-character budget.
    expect(render(p(mention(ANA, '@Ana')))).toBe('@ana_g');
  });

  it('falls back to `tg://user?id=` when there is no username', () => {
    expect(render(p(mention(BEA, '@Bea')))).toBe('<a href="tg://user?id=43">Bea &lt;Smith&gt;</a>');
  });

  it('renders plain text when the member cannot be pinged', () => {
    // `06` §3.6, and the reason the check comes first: `canPing` is false when the constitution
    // forbids a ping on a proactive message, so reaching for the id anyway would ping somebody the
    // group said not to.
    expect(render(p(mention(CAS, '@Cas')))).toBe('@Cas');
  });

  it('renders the fallback for a member who is not in the context', () => {
    // Composed while they were a member, sent after they left.
    const gone = 'mbr_01jd000000000000000000000z' as MemberId;
    expect(render(p(mention(gone, '@Gone')))).toBe('@Gone');
  });

  it('renders a platform-user mention as its fallback', () => {
    expect(
      render(
        p({
          t: 'mention',
          target: { kind: 'platform_user', platformUserId: '99' },
          fallback: '@Someone',
        }),
      ),
    ).toBe('@Someone');
  });

  it('escapes a display name that looks like markup', () => {
    expect(render(p(mention(BEA, '@Bea')))).toContain('Bea &lt;Smith&gt;');
  });
});

describe('blocks (06 §3.5.3)', () => {
  it('renders a heading as bold on its own line, whatever the level', () => {
    for (const level of [1, 2, 3] as const) {
      expect(render({ t: 'h', level, c: [text('T')] })).toBe('<b>T</b>');
    }
  });

  it('separates paragraphs with a blank line', () => {
    expect(render(p(text('a')), p(text('b')))).toBe('a\n\nb');
  });

  it('renders a thematic break as an em-dash rule', () => {
    expect(render({ t: 'hr' })).toBe(TELEGRAM_RULE);
  });

  it('renders a fenced block with its language class', () => {
    expect(render({ t: 'code', lang: 'js', text: 'let x = 1' })).toBe(
      '<pre><code class="language-js">let x = 1</code></pre>',
    );
  });

  it('renders a fenced block with no language and no empty class', () => {
    // `class="language-"` is an unknown language to Telegram rather than none, and it costs
    // attribute bytes for nothing.
    expect(render({ t: 'code', text: 'x' })).toBe('<pre><code>x</code></pre>');
  });

  it('escapes the contents of a fenced block', () => {
    expect(render({ t: 'code', text: '<b>&</b>' })).toBe(
      '<pre><code>&lt;b&gt;&amp;&lt;/b&gt;</code></pre>',
    );
  });

  it('renders a bullet list with a bullet per item', () => {
    expect(render({ t: 'list', ordered: false, items: [[p(text('a'))], [p(text('b'))]] })).toBe(
      '• a\n• b',
    );
  });

  it('numbers an ordered list, continuing from `start`', () => {
    expect(
      render({ t: 'list', ordered: true, start: 3, items: [[p(text('a'))], [p(text('b'))]] }),
    ).toBe('3. a\n4. b');
  });

  it('indents a nested list with non-breaking spaces', () => {
    // Telegram collapses ordinary leading spaces, so an indent made of them is no indent at all.
    const nested: Block = {
      t: 'list',
      ordered: false,
      items: [[p(text('a')), { t: 'list', ordered: false, items: [[p(text('b'))]] }]],
    };
    expect(render(nested)).toBe('• a\n  • b');
  });

  it('renders a quote, and flattens a nested one', () => {
    // `06` §3.5.3: "nested quotes flattened". Telegram has no nested `<blockquote>`, and emitting
    // one is a parse error rather than a rendering difference.
    expect(render({ t: 'quote', c: [p(text('a'))] })).toBe('<blockquote>a</blockquote>');
    expect(render({ t: 'quote', c: [p(text('a')), { t: 'quote', c: [p(text('b'))] }] })).toBe(
      '<blockquote>a\n\nb</blockquote>',
    );
  });

  it('marks a long quote expandable', () => {
    const short = render({ t: 'quote', c: [p(text('x'.repeat(TELEGRAM_EXPANDABLE_QUOTE_CHARS)))] });
    expect(short).toContain('<blockquote>');
    const long = render({
      t: 'quote',
      c: [p(text('x'.repeat(TELEGRAM_EXPANDABLE_QUOTE_CHARS + 1)))],
    });
    expect(long).toContain('<blockquote expandable>');
  });

  it('measures a quote’s length as what a reader sees, not as markup', () => {
    // 600 `&`s is 3 000 characters of HTML and 600 of text. A threshold applied to the markup
    // would collapse a quote nobody would call long.
    const html = render({ t: 'quote', c: [p(text('&'.repeat(400)))] });
    expect(html).toContain('<blockquote>');
    expect(html).not.toContain('expandable');
  });

  it('renders an empty document as an empty string', () => {
    expect(render()).toBe('');
  });

  it('renders an empty list item without a stray bullet line', () => {
    expect(render({ t: 'list', ordered: false, items: [[], [p(text('b'))]] })).toBe('• \n• b');
  });
});

describe('the validator (M3-T4 AC)', () => {
  it('passes the renderer’s own output for every shape above', () => {
    // Asserted inside `render`, so this is the statement of it rather than a second check.
    expect(isValidTelegramHtml(render(p(text('x', 'b', 'i', 's', 'spoiler'))))).toBe(true);
  });

  it('catches an unknown tag', () => {
    expect(validateTelegramHtml('<u>x</u>').map((problem) => problem.kind)).toContain(
      'unknown_tag',
    );
  });

  it('catches an unbalanced pair', () => {
    expect(validateTelegramHtml('<b><i>x</b></i>').map((problem) => problem.kind)).toContain(
      'unbalanced',
    );
    expect(validateTelegramHtml('<b>x').map((problem) => problem.kind)).toContain('unbalanced');
    expect(validateTelegramHtml('x</b>').map((problem) => problem.kind)).toContain('unbalanced');
  });

  it('catches a tag inside code', () => {
    expect(validateTelegramHtml('<code><b>x</b></code>').map((p2) => p2.kind)).toContain(
      'tag_inside_code',
    );
    // And allows the one legitimate pairing, `pre` wrapping `code`.
    expect(validateTelegramHtml('<pre><code>x</code></pre>')).toEqual([]);
  });

  it('catches an unknown attribute', () => {
    expect(validateTelegramHtml('<a onclick="x">y</a>').map((p2) => p2.kind)).toContain(
      'unknown_attribute',
    );
  });

  it('catches an entity Telegram does not have', () => {
    for (const entity of ['&nbsp;', '&mdash;', '&#60;', '&copy;']) {
      expect(
        validateTelegramHtml(`a${entity}b`).map((p2) => p2.kind),
        entity,
      ).toContain('unknown_entity');
    }
    expect(validateTelegramHtml('a&amp;&lt;&gt;&quot;b')).toEqual([]);
  });

  it('catches an unescaped angle bracket', () => {
    expect(validateTelegramHtml('a < b').map((p2) => p2.kind)).toContain('malformed');
  });

  it('is not fooled by a `>` inside an attribute value', () => {
    // The case a regex-based validator gets wrong, which matters because an escaping bug is
    // exactly what produces it.
    expect(validateTelegramHtml('<a href="https://e.co/?a=>">x</a>')).toEqual([]);
  });
});

describe('the validator’s malformed paths (M3-T4)', () => {
  it('rejects an unquoted attribute value', () => {
    // Telegram's parser accepts unquoted values in some positions and not others. The renderer
    // always quotes, so an unquoted value in its output would be a bug — and this is the shape an
    // injected attribute takes.
    expect(validateTelegramHtml('<a href=https://e.co>x</a>').map((p2) => p2.kind)).toContain(
      'malformed',
    );
  });

  it('rejects an unterminated attribute value', () => {
    expect(validateTelegramHtml('<a href="https://e.co>x</a>').map((p2) => p2.kind)).toContain(
      'malformed',
    );
  });

  it('rejects an unterminated tag', () => {
    expect(validateTelegramHtml('<a href="https://e.co"').map((p2) => p2.kind)).toContain(
      'malformed',
    );
    expect(validateTelegramHtml('<b').map((p2) => p2.kind)).toContain('malformed');
  });

  it('rejects a self-closing tag', () => {
    // Telegram has none, and a renderer emitting one would be guessing at HTML rather than at
    // Telegram's parse mode.
    expect(validateTelegramHtml('<b/>').map((p2) => p2.kind)).toContain('malformed');
  });

  it('rejects an unparseable tag', () => {
    expect(validateTelegramHtml('<a ="x">y</a>').map((p2) => p2.kind)).toContain('malformed');
  });

  it('accepts a bare attribute with no value', () => {
    // `expandable` is the one the renderer emits, and it has no value.
    expect(validateTelegramHtml('<blockquote expandable>x</blockquote>')).toEqual([]);
  });

  it('reads the attribute values off real tags only', () => {
    // The distinction the injection corpus depends on: a quote in *text* is a quote, so an
    // escaped `<a href="…">` is inert and must not be read as an attribute.
    expect(telegramAttributes('&lt;a href="tg://user?id=9"&gt;x&lt;/a&gt;')).toEqual([]);
    expect(telegramAttributes('<a href="https://e.co">x</a>')).toEqual([
      { tag: 'a', name: 'href', value: 'https://e.co' },
    ]);
  });

  it('tolerates a newline inside a tag', () => {
    // The renderer does not emit one, but a hand-written fixture might, and a scanner that
    // treated it as the end of the tag would report a false problem.
    expect(validateTelegramHtml('<a\nhref="https://e.co">x</a>')).toEqual([]);
  });
});
