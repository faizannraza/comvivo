/**
 * The injection corpus (`06` §3.5.3; `M3-T4`'s AC: "the injection corpus passes"; `08` §3.10).
 *
 * Every input here is **content**: something a member typed, or a model repeated back from a
 * member's message. That is what makes this the corpus that matters rather than the golden one —
 * the golden corpus asks "does the mapping hold", and this asks "can a member who writes a message
 * change what the platform does with it".
 *
 * Three ways they can, and all three have happened to real products:
 *
 *  1. **break the markup**, so the platform rejects the whole message and the group gets silence
 *     from an assistant that was working a minute ago;
 *  2. **inject markup**, so their text becomes a link, a mention or a formatting tag;
 *  3. **ping everybody**, by writing a mass-mention token the renderer passes through.
 *
 * The assertion for every case is the same and is deliberately not "the output equals this
 * string": it is that the output **validates** and that the hostile substring does not survive as
 * markup. An expectation per case would be 60 strings nobody re-reads; a property over 60 inputs
 * is a property.
 */
import { BRAND, type MemberId } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import type { RenderContext } from '../../contract.js';
import { profiles } from '../../profiles.js';
import { parseModelOutput } from '../parse.js';
import { renderPlain } from './plain.js';
import { renderTelegramHtml } from './telegram-html.js';
import { telegramAttributes, validateTelegramHtml } from './telegram-validator.js';
import { renderWeb } from './web.js';

/**
 * The invisible characters some cases need, built from their code points.
 *
 * A NUL or a bidi override written as a literal is invisible in a diff and in most editors, and
 * these are exactly the characters an attacker reaches for: `RLO` reverses the apparent order of
 * what follows it, which is how a URL is made to read as something else.
 */
/**
 * The schemes that must never reach a payload the dashboard turns into an `href`.
 *
 * In one place with one suppression rather than spelled out at each assertion: `no-script-url`
 * exists to stop a `javascript:` URL being *used*, and here the literal is the thing being
 * forbidden. Assembling it from fragments to dodge the rule would make the one list a reader needs
 * to check unreadable, which is a worse trade in a security test than a named exception.
 */
// eslint-disable-next-line no-script-url -- these are test expectations, not URLs being used.
const DANGEROUS_SCHEMES: readonly string[] = ['javascript:', 'vbscript:', 'data:text/html'];

const NUL = String.fromCharCode(0x00);
const RLO = String.fromCharCode(0x202e);
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);
const ZWJ = String.fromCharCode(0x200d);
const LS = String.fromCharCode(0x2028);

const MBR = 'mbr_01jd0000000000000000000000' as MemberId;

const CONTEXT: RenderContext = {
  mentions: {
    [MBR]: { displayName: 'Ana', platformUserId: '42', canPing: true },
  },
  self: { platformUserId: '1', displayName: BRAND.displayName, flags: {} },
  linkPreview: false,
  locale: 'en',
};

/**
 * What a member can type.
 *
 * Grouped by what each group is trying to do, because the groups fail differently: a broken tag is
 * a 400, an injected tag is a formatting change, and a mass mention is a notification to a hundred
 * people. The HTML group is the longest because Telegram's parse mode is the only markup here that
 * rejects rather than degrades.
 */
const HOSTILE: readonly (readonly [string, string])[] = [
  // --- breaking the markup
  ['bare lt', 'a < b'],
  ['bare gt', 'a > b'],
  ['bare amp', 'Tom & Jerry'],
  ['ampersand entity', 'a &amp; b'],
  ['nbsp entity', 'a &nbsp; b'],
  ['numeric entity', 'a &#60; b'],
  ['unterminated entity', 'a &amp b'],
  ['close tag', 'a </b> b'],
  ['open tag', 'a <b> b'],
  ['unbalanced pair', '<b>a</i>'],
  ['pre close', 'x </code></pre> y'],
  ['blockquote close', 'x </blockquote> y'],
  ['tg-spoiler close', 'x </tg-spoiler> y'],
  ['quote in text', 'she said "hi"'],
  ['quote and angle', '"<a href=\'x\'>"'],
  // --- injecting markup
  ['anchor', '<a href="https://evil.example">click</a>'],
  ['anchor single quotes', "<a href='https://evil.example'>click</a>"],
  ['tg user link', '<a href="tg://user?id=99">Ana</a>'],
  ['script', '<script>alert(1)</script>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['svg onload', '<svg onload=alert(1)>'],
  ['iframe', '<iframe src="https://evil.example"></iframe>'],
  ['style', '<style>body{display:none}</style>'],
  ['tg-time', '<tg-time unix="0" format="wDt">now</tg-time>'],
  ['pre code class', '<pre><code class="language-js">x</code></pre>'],
  ['attribute break', '" onmouseover="alert(1)'],
  ['href break', 'x" href="https://evil.example'],
  ['comment', '<!-- hi -->'],
  ['cdata', '<![CDATA[x]]>'],
  ['doctype', '<!DOCTYPE html>'],
  ['processing instruction', '<?php echo 1; ?>'],
  ['nested angle', '<<b>>'],
  ['tag in tag', '<b<b>>'],
  ['newline in tag', '<b\n>x'],
  ['null in tag', `<b${NUL}>x`],
  // --- mass mentions
  ['everyone', '@everyone please read'],
  ['here', 'hey @here'],
  ['slack channel', '<!channel> urgent'],
  ['slack here', '<!here> urgent'],
  ['slack everyone', '<!everyone> urgent'],
  ['matrix room', '@room please read'],
  ['everyone in bold', '**@everyone**'],
  ['everyone in code', '`@everyone`'],
  ['everyone in a link', '[@everyone](https://e.co)'],
  // --- schemes and URLs
  ['javascript link', '[x](javascript:alert(1))'],
  ['data link', '[x](data:text/html,<script>alert(1)</script>)'],
  ['vbscript link', '[x](vbscript:msgbox)'],
  ['file link', '[x](file:///etc/passwd)'],
  ['tg link', '[x](tg://user?id=99)'],
  ['tab in scheme', '[x](java\tscript:alert(1))'],
  ['url with quote', '[x](https://e.co/"onmouseover="alert(1))'],
  ['url with angle', '[x](https://e.co/<script>)'],
  ['url with amp', '[x](https://e.co/?a=1&b=2)'],
  // --- the custom syntax, written by a member
  ['fake mention', '@{mbr_01jd0000000000000000000000}'],
  ['fake mention unknown', '@{mbr_01jd0000000000000000000009}'],
  ['spoiler', '||hidden||'],
  // --- control characters and direction
  ['rtl override', `a${RLO}b`],
  ['bidi isolate', `a${LRI}b${PDI}c`],
  ['zero width joiner', `a${ZWJ}b`],
  ['line separator', `a${LS}b`],
];

describe('telegram-html survives hostile content (06 §3.5.3)', () => {
  it.each(HOSTILE)('%s', (_name, input) => {
    const parsed = parseModelOutput(input, { resolveMember: () => ({ fallback: '@Ana' }) });
    const html = renderTelegramHtml(parsed.richText, CONTEXT, { capabilities: profiles.telegram });
    // The whole point: Telegram answers `400 can't parse entities` and sends **nothing**, so an
    // output that does not validate is a message the group never receives.
    expect(validateTelegramHtml(html), html).toEqual([]);
  });

  it('never lets content become a tag', () => {
    // Stronger than validation: a validator is happy with `<b>` that the *renderer* chose. This
    // asserts that no tag in the output came from the input.
    for (const [name, input] of HOSTILE) {
      const parsed = parseModelOutput(input, { resolveMember: () => undefined });
      const html = renderTelegramHtml(parsed.richText, CONTEXT, {
        capabilities: profiles.telegram,
      });
      for (const forbidden of ['<script', '<img', '<svg', '<iframe', '<style', '<!--', '<!']) {
        expect(html.toLowerCase(), `${name}: ${html}`).not.toContain(forbidden);
      }
    }
  });

  it('never lets content become a link or a ping', () => {
    // The first version of this banned the substring `tg://` anywhere in the output, and it
    // failed on `<a href="tg://user?id=99">Ana</a>` typed as content — which the renderer escapes
    // to visible text, so the characters survive and mean nothing. The assertion was wrong, not
    // the renderer: what matters is not whether a scheme appears, it is whether it appears **in an
    // attribute the platform acts on**.
    //
    // So: every `href` in the output has to be one the renderer chose. `https:`, `http:` and
    // `mailto:` come from `RichTextSchema`'s allowlist; `tg://user?id=<digits>` is the mention
    // primitive and may appear only for a mention this send resolved — and the resolver below
    // returns nothing, so there must be none at all.
    for (const [name, input] of HOSTILE) {
      const parsed = parseModelOutput(input, { resolveMember: () => undefined });
      const html = renderTelegramHtml(parsed.richText, CONTEXT, {
        capabilities: profiles.telegram,
      });
      for (const attribute of telegramAttributes(html)) {
        if (attribute.name !== 'href') continue;
        const url = attribute.value ?? '';
        expect(
          /^https?:\/\//.test(url) || url.startsWith('mailto:'),
          `${name}: href="${url}" in ${html}`,
        ).toBe(true);
      }
      // And no attribute value holds a quote that could close it early, which is the other half of
      // an injected attribute.
      for (const attribute of telegramAttributes(html)) {
        expect((attribute.value ?? '').includes('"'), `${name}: ${attribute.name}`).toBe(false);
      }
    }
  });

  it('writes a `tg://user?id=` href only for a mention it resolved', () => {
    // The complement of the test above: with a roster, the one `tg://` the renderer may emit does
    // appear — and only in the shape `06` §3.5.3 specifies, with a numeric id.
    const parsed = parseModelOutput(`hi @{${MBR}}`, {
      resolveMember: () => ({ fallback: '@Ana' }),
    });
    const html = renderTelegramHtml(parsed.richText, CONTEXT, { capabilities: profiles.telegram });
    expect(html).toContain('<a href="tg://user?id=42">Ana</a>');
    for (const attribute of telegramAttributes(html)) {
      if (attribute.name !== 'href' || !(attribute.value ?? '').startsWith('tg:')) continue;
      expect(attribute.value, html).toMatch(/^tg:\/\/user\?id=\d+$/);
    }
  });

  it('emits only the four entities Telegram has', () => {
    // `06` §3.5.3: "Only `&lt; &gt; &amp; &quot;` named entities exist; never emit others."
    // Telegram rejects an unknown entity, so `&nbsp;` is a 400 on every message containing it.
    for (const [name, input] of HOSTILE) {
      const parsed = parseModelOutput(input, { resolveMember: () => undefined });
      const html = renderTelegramHtml(parsed.richText, CONTEXT, {
        capabilities: profiles.telegram,
      });
      for (const match of html.matchAll(/&[a-zA-Z#][a-zA-Z0-9#]*;/g)) {
        expect(['&amp;', '&lt;', '&gt;', '&quot;'], `${name}: ${match[0]}`).toContain(match[0]);
      }
    }
  });
});

describe('plain survives hostile content', () => {
  it.each(HOSTILE)('%s', (_name, input) => {
    const parsed = parseModelOutput(input, { resolveMember: () => ({ fallback: '@Ana' }) });
    const plain = renderPlain(parsed.richText, CONTEXT);
    // Plain text has no markup to break, so the property is about the **ranges**: every one has to
    // land inside the text it describes, because on Signal a range that runs past the end is a
    // malformed message and a range over the wrong offsets styles somebody else's words.
    for (const range of plain.styles) {
      expect(range.start, input).toBeGreaterThanOrEqual(0);
      expect(range.start + range.length, input).toBeLessThanOrEqual(plain.text.length);
    }
    for (const range of plain.mentions) {
      expect(range.start, input).toBeGreaterThanOrEqual(0);
      expect(range.start + range.length, input).toBeLessThanOrEqual(plain.text.length);
    }
  });
});

describe('web-md survives hostile content', () => {
  it.each(HOSTILE)('%s', (_name, input) => {
    const parsed = parseModelOutput(input, { resolveMember: () => ({ fallback: '@Ana' }) });
    const web = renderWeb(parsed.richText, CONTEXT);
    // The web payload is a tree, so there is no string to inject into — and the one thing that
    // *could* go wrong is a URL the dashboard turns into an `href`. `RichTextSchema` already
    // refuses a scheme outside the allowlist; this asserts the renderer did not reintroduce one.
    const payload = JSON.stringify(web);
    for (const scheme of DANGEROUS_SCHEMES) {
      expect(payload, scheme).not.toContain(scheme);
    }
  });
});
