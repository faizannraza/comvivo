/**
 * The golden corpus (`06` §3.5.2's acceptance criterion; `M3-T3`).
 *
 * 155 cases, one line each, in the notation `sketch.ts` documents. The criterion is "the §3.5.2
 * mapping holds on a ≥ 150-case golden corpus", and this is what that means in practice: every
 * construct in §3.5.2's mapping table, every limit in §3.5.1, both pieces of custom syntax, and
 * the inputs that are not markdown at all.
 *
 * ## Where the expectations came from
 *
 * **Measured, then reviewed line by line.** Each one was produced by running the parser and then
 * read against §3.5.2 — which is the only honest way to build a corpus this size, and is not the
 * same as a snapshot: a snapshot is re-recorded when it fails, so it agrees with whatever the code
 * now does. These are frozen. Four of them were wrong on first reading and the **code** changed:
 *
 *  - `[\`npm i\`](https://x)` produced a link with **no label**, because a link's children are
 *    `TextInline[]` and the inline code was being filtered out. The reply lost the words and kept
 *    a URL it could not show. Labels are now flattened to text.
 *  - `![a](i.png)` inside a link lost its label the same way, and `[](https://e.co)` produced an
 *    empty anchor. Both now fall back to something a reader can see.
 *  - `a <b>c</b> d` produced **five** adjacent text runs, because mdast hands one back per
 *    construct. Five nodes against a 5 000-node budget, and five tags where one belongs — which
 *    Telegram counts against the message length. Adjacent runs with equal marks now merge.
 *  - a table rendered as space-padded columns with **no way to tell the header from the data**.
 *    There is a rule under it now.
 *
 * ## The one case that documents a limitation rather than a behaviour
 *
 * `escaped-pipe`: `\|\|not spoiler\|\|` comes out as a **spoiler**. `06` §3.5.2 applies the custom
 * syntax "after parsing, to `text` nodes only", and by then CommonMark has already turned `\|` into
 * `|` — the information about which pipe was escaped is gone. So a model cannot write a literal
 * `||`. That follows from §3.5.2's own ordering rather than from this implementation, it affects
 * model output only (inbound text is parsed per adapter, `06` §3.5.2's last bullet), and it is
 * written down here so the next person reads it as a decision instead of a bug.
 */

import type { MemberId } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { parseModelOutput } from './parse.js';
import { sketch } from './sketch.js';

/**
 * The invisible characters three cases need, built from their code points.
 *
 * A control character written as a literal is invisible in a diff, in most editors and in a
 * review — and these are three inputs a model emits by accident: a stray BEL from a terminal
 * transcript, a NUL from a truncated byte stream, and a zero-width space from a copy-paste.
 * `REPLACEMENT` is what CommonMark requires a NUL to become (U+FFFD), which is micromark's
 * behaviour rather than ours and is pinned here so a change in it is visible.
 */
const BELL = String.fromCharCode(0x07);
const NUL = String.fromCharCode(0x00);
const ZWSP = String.fromCharCode(0x200b);
const REPLACEMENT = String.fromCharCode(0xfffd);

/** In the roster. */
const MBR = 'mbr_01jd0000000000000000000000' as MemberId;
/** A well-formed id that is **not** in the roster, so it takes `06` §3.5.2's `@?` path. */
const OTHER = 'mbr_01jd0000000000000000000001' as MemberId;

function parse(markdown: string): string {
  const result = parseModelOutput(markdown, {
    resolveMember: (id: MemberId) => (id === MBR ? { fallback: '@Ana' } : undefined),
  });
  return sketch(result.richText);
}

/** `[name, markdown, sketch]`. */
const CORPUS: readonly (readonly [string, string, string])[] = [
  // --- marks
  ['bold-star', '**bold**', 'p["bold"*b]'],
  ['bold-under', '__bold__', 'p["bold"*b]'],
  ['italic-star', '*it*', 'p["it"*i]'],
  ['italic-under', '_it_', 'p["it"*i]'],
  ['strike', '~~gone~~', 'p["gone"*s]'],
  ['strike-single', '~gone~', 'p["gone"*s]'],
  ['bold-italic', '***both***', 'p["both"*bi]'],
  ['nested-marks', '**a *b* c**', 'p["a "*b "b"*bi " c"*b]'],
  ['all-three', '**~~*x*~~**', 'p["x"*bis]'],
  ['mark-across-words', 'a **b c** d', 'p["a " "b c"*b " d"]'],
  ['unclosed-bold', '**bold', 'p["**bold"]'],
  ['empty-bold', '****', 'hr'],
  // --- inline code
  ['inline-code', '`x`', 'p[c("x")]'],
  ['inline-code-double', '``a`b``', 'p[c("a`b")]'],
  ['inline-code-marks-inside', '`**a**`', 'p[c("**a**")]'],
  ['code-in-bold', '**`x`**', 'p[c("x")]'],
  ['inline-code-empty', '``', 'p["``"]'],
  ['inline-code-spaces', '` x `', 'p[c("x")]'],
  // --- links, autolinks, images
  ['link', '[label](https://example.com)', 'p[a(https://example.com)["label"]]'],
  ['link-http', '[l](http://example.com)', 'p[a(http://example.com)["l"]]'],
  ['link-mailto', '[m](mailto:a@b.co)', 'p[a(mailto:a@b.co)["m"]]'],
  ['link-js', '[l](javascript:alert(1))', 'p["l"]'],
  ['link-data', '[l](data:text/html,x)', 'p["l"]'],
  ['link-ftp', '[l](ftp://x.co/a)', 'p["l"]'],
  ['link-title', '[l](https://e.co "t")', 'p[a(https://e.co)["l"]]'],
  ['link-bold-label', '[**l**](https://e.co)', 'p[a(https://e.co)["l"*b]]'],
  ['link-code-label', '[`l`](https://e.co)', 'p[a(https://e.co)["l"]]'],
  ['autolink-angle', '<https://example.com>', 'p[a(https://example.com)["https://example.com"]]'],
  [
    'autolink-literal',
    'see https://example.com now',
    'p["see " a(https://example.com)["https://example.com"] " now"]',
  ],
  [
    'autolink-www',
    'see www.example.com now',
    'p["see " a(http://www.example.com)["www.example.com"] " now"]',
  ],
  ['autolink-email', 'mail a@b.co now', 'p["mail " a(mailto:a@b.co)["a@b.co"] " now"]'],
  ['image', '![alt](https://e.co/i.png)', 'p[a(https://e.co/i.png)["alt"]]'],
  ['image-no-alt', '![](https://e.co/i.png)', 'p[a(https://e.co/i.png)["https://e.co/i.png"]]'],
  ['image-in-link', '[![a](https://e.co/i.png)](https://e.co)', 'p[a(https://e.co)["a"]]'],
  ['link-ref', '[l][ref]\n\n[ref]: https://e.co', 'p["l"]'],
  ['link-ref-missing', '[l][nope]', 'p["[l][nope]"]'],
  ['link-empty-label', '[](https://e.co)', 'p[a(https://e.co)["https://e.co"]]'],
  [
    'link-nested',
    '[a [b](https://e.co) c](https://f.co)',
    'p["[a " a(https://e.co)["b"] " c](" a(https://f.co)["https://f.co"] ")"]',
  ],
  // --- headings
  ['h1', '# One', 'h1["One"]'],
  ['h2', '## Two', 'h2["Two"]'],
  ['h3', '### Three', 'h3["Three"]'],
  ['h4', '#### Four', 'h3["Four"]'],
  ['h5', '##### Five', 'h3["Five"]'],
  ['h6', '###### Six', 'h3["Six"]'],
  ['h-setext', 'Title\n=====', 'h1["Title"]'],
  ['h-setext2', 'Title\n-----', 'h2["Title"]'],
  ['h-with-marks', '## **Bold** title', 'h2["Bold"*b " title"]'],
  // --- lists
  ['ul', '- a\n- b', 'ul[{p["a"]}{p["b"]}]'],
  ['ul-star', '* a\n* b', 'ul[{p["a"]}{p["b"]}]'],
  ['ul-plus', '+ a\n+ b', 'ul[{p["a"]}{p["b"]}]'],
  ['ol', '1. a\n2. b', 'ol[{p["a"]}{p["b"]}]'],
  ['ol-start-3', '3. a\n4. b', 'ol@3[{p["a"]}{p["b"]}]'],
  ['ol-paren', '1) a\n2) b', 'ol[{p["a"]}{p["b"]}]'],
  ['ul-nested-2', '- a\n  - b', 'ul[{p["a"] ul[{p["b"]}]}]'],
  ['ul-nested-3', '- a\n  - b\n    - c', 'ul[{p["a"] ul[{p["b"] ul[{p["c"]}]}]}]'],
  [
    'ul-nested-4',
    '- a\n  - b\n    - c\n      - d',
    'ul[{p["a"] ul[{p["b"] ul[{p["c"] p["d"]}]}]}]',
  ],
  [
    'ul-nested-5',
    '- a\n  - b\n    - c\n      - d\n        - e',
    'ul[{p["a"] ul[{p["b"] ul[{p["c"] p["d"] p["e"]}]}]}]',
  ],
  ['ol-in-ul', '- a\n  1. b', 'ul[{p["a"] ol[{p["b"]}]}]'],
  ['ul-loose', '- a\n\n- b', 'ul[{p["a"]}{p["b"]}]'],
  ['ul-multi-block', '- a\n\n  b', 'ul[{p["a"] p["b"]}]'],
  ['ul-with-code', '- a\n\n  ```\n  x\n  ```', 'ul[{p["a"] code("x")}]'],
  ['ul-empty-item', '- \n- b', 'ul[{}{p["b"]}]'],
  ['ul-task', '- [ ] a\n- [x] b', 'ul[{p["[ ] a"]}{p["[x] b"]}]'],
  ['ol-large-start', '99. a', 'ol@99[{p["a"]}]'],
  ['ul-single', '- only', 'ul[{p["only"]}]'],
  // --- code blocks
  ['fence', '```\nx\n```', 'code("x")'],
  ['fence-js', '```js\nlet x = 1\n```', 'code:js("let x = 1")'],
  ['fence-upper', '```JavaScript\nx\n```', 'code:javascript("x")'],
  ['fence-args', '```js {1,3}\nx\n```', 'code:js("x")'],
  ['fence-bad-lang', '```a b c!!!\nx\n```', 'code:a("x")'],
  ['fence-long-lang', '```abcdefghijklmnopqrstuvwxyz\nx\n```', 'code("x")'],
  ['fence-tilde', '~~~\nx\n~~~', 'code("x")'],
  ['indented-code', '    x\n    y', 'code("x\\ny")'],
  ['fence-empty', '```\n```', 'code("")'],
  ['fence-inner-backticks', '````\n```\n````', 'code("```")'],
  ['fence-lang-plus', '```c++\nx\n```', 'code:c++("x")'],
  ['fence-lang-hash', '```c#\nx\n```', 'code:c#("x")'],
  // --- quotes
  ['quote', '> a', 'q[p["a"]]'],
  ['quote-2', '> a\n> b', 'q[p["a" / "b"]]'],
  ['quote-nested-2', '> a\n> > b', 'q[p["a"] q[p["b"]]]'],
  ['quote-nested-3', '> a\n> > b\n> > > c', 'q[p["a"] q[p["b"] p["c"]]]'],
  ['quote-with-list', '> - a', 'q[ul[{p["a"]}]]'],
  ['quote-with-heading', '> # h', 'q[h1["h"]]'],
  ['quote-empty', '>', 'q[]'],
  ['quote-lazy', '> a\nb', 'q[p["a" / "b"]]'],
  // --- thematic breaks
  ['hr-dash', '---', 'hr'],
  ['hr-star', '***', 'hr'],
  ['hr-under', '___', 'hr'],
  ['hr-spaced', '- - -', 'hr'],
  // --- tables
  ['table', '| a | b |\n|---|---|\n| 1 | 2 |', 'code("a  b\\n─  ─\\n1  2")'],
  ['table-align', '| a | b |\n|:--|--:|\n| 1 | 2 |', 'code("a  b\\n─  ─\\n1  2")'],
  ['table-ragged', '| a | b |\n|---|---|\n| 1 |', 'code("a  b\\n─  ─\\n1")'],
  [
    'table-wide-cell',
    '| a | b |\n|---|---|\n| longer | 2 |',
    'code("a       b\\n──────  ─\\nlonger  2")',
  ],
  ['table-marks', '| **a** | b |\n|---|---|\n| 1 | 2 |', 'code("a  b\\n─  ─\\n1  2")'],
  ['table-header-only', '| a | b |\n|---|---|', 'code("a  b")'],
  ['table-emoji', '| 🙂 | b |\n|---|---|\n| 1 | 2 |', 'code("🙂  b\\n─  ─\\n1  2")'],
  ['table-link', '| [l](https://e.co) |\n|---|\n| 1 |', 'code("l\\n─\\n1")'],
  // --- raw HTML
  ['html-block', '<div>x</div>', 'p["<div>x</div>"]'],
  ['html-inline', 'a <b>c</b> d', 'p["a <b>c</b> d"]'],
  ['html-br', 'a<br>b', 'p["a<br>b"]'],
  ['html-script', '<script>alert(1)</script>', 'p["<script>alert(1)</script>"]'],
  ['html-comment', '<!-- hi -->', 'p["<!-- hi -->"]'],
  ['html-entity', 'a &amp; b', 'p["a & b"]'],
  // --- breaks
  ['soft-break', 'a\nb', 'p["a" / "b"]'],
  ['hard-break-spaces', 'a  \nb', 'p["a" / "b"]'],
  ['hard-break-backslash', 'a\\\nb', 'p["a" / "b"]'],
  ['three-lines', 'a\nb\nc', 'p["a" / "b" / "c"]'],
  ['blank-line-paras', 'a\n\nb', 'p["a"] p["b"]'],
  ['leading-newlines', '\n\na', 'p["a"]'],
  ['trailing-newlines', 'a\n\n', 'p["a"]'],
  ['crlf', 'a\r\nb', 'p["a\\r" / "b"]'],
  // --- spoilers
  ['spoiler', '||secret||', 'p["secret"*spoiler]'],
  ['spoiler-in-text', 'a ||b|| c', 'p["a " "b"*spoiler " c"]'],
  ['spoiler-bold', '**a ||b|| c**', 'p["a "*b "b"*bspoiler " c"*b]'],
  ['spoiler-in-code', '`a||b||c`', 'p[c("a||b||c")]'],
  ['spoiler-in-fence', '```\na||b||c\n```', 'code("a||b||c")'],
  ['spoiler-unclosed', '||a', 'p["||a"]'],
  ['spoiler-empty', '||||', 'p["||||"]'],
  ['spoiler-nested', '||a||b||', 'p["a"*spoiler "b||"]'],
  ['spoiler-newline', '||a\nb||', 'p["||a" / "b||"]'],
  ['spoiler-two', '||a|| and ||b||', 'p["a"*spoiler " and " "b"*spoiler]'],
  ['spoiler-pipe-inside', '||a|b||', 'p["||a|b||"]'],
  ['spoiler-link', '||[l](https://e.co)||', 'p["||" a(https://e.co)["l"] "||"]'],
  // --- mentions
  ['mention', `@{${MBR}}`, 'p[@(member:mbr_01jd0000000000000000000000|@Ana)]'],
  ['mention-unknown', `@{${OTHER}}`, 'p["@?"]'],
  [
    'mention-in-text',
    `hi @{${MBR}} there`,
    'p["hi " @(member:mbr_01jd0000000000000000000000|@Ana) " there"]',
  ],
  ['mention-bold', `**@{${MBR}}**`, 'p[@(member:mbr_01jd0000000000000000000000|@Ana)]'],
  [
    'mention-two',
    `@{${MBR}} and @{${MBR}}`,
    'p[@(member:mbr_01jd0000000000000000000000|@Ana) " and " @(member:mbr_01jd0000000000000000000000|@Ana)]',
  ],
  ['mention-in-code', `\`@{${MBR}}\``, 'p[c("@{mbr_01jd0000000000000000000000}")]'],
  [
    'mention-in-fence',
    '```\n@{mbr_01jd0000000000000000000000}\n```',
    'code("@{mbr_01jd0000000000000000000000}")',
  ],
  ['mention-bad-short', '@{mbr_123}', 'p["@{mbr_123}"]'],
  [
    'mention-bad-chars',
    '@{mbr_01jd000000000000000000000i}',
    'p["@{mbr_01jd000000000000000000000i}"]',
  ],
  [
    'mention-bad-prefix',
    '@{grp_01jd0000000000000000000000}',
    'p["@{grp_01jd0000000000000000000000}"]',
  ],
  ['mention-no-braces', `@${MBR}`, 'p["@mbr_01jd0000000000000000000000"]'],
  ['mention-in-link-label', `[@{${MBR}}](https://e.co)`, 'p[a(https://e.co)["@Ana"]]'],
  // --- limits and degradation
  ['empty', '', ''],
  ['whitespace', '   \n\t  ', ''],
  ['one-char', 'x', 'p["x"]'],
  ['deep-quote-5', '> > > > > x', 'q[q[p["x"]]]'],
  // --- escapes and oddities
  ['escaped-star', '\\*not bold\\*', 'p["*not bold*"]'],
  ['escaped-pipe', '\\|\\|not spoiler\\|\\|', 'p["not spoiler"*spoiler]'],
  ['backslash-end', 'a\\', 'p["a\\\\"]'],
  ['tab-indent', '\ta', 'code("a")'],
  ['nbsp', 'a b', 'p["a b"]'],
  ['zwsp', `a${ZWSP}b`, `p["a${ZWSP}b"]`],
  ['emoji', '🙂 ok', 'p["🙂 ok"]'],
  ['combining', 'é', 'p["é"]'],
  ['rtl', 'مرحبا', 'p["مرحبا"]'],
  ['control-char', `a${BELL}b`, 'p["a\\u0007b"]'],
  ['lone-surrogate', 'a\ud800b', 'p["a\\ud800b"]'],
  ['null-char', `a${NUL}b`, `p["a${REPLACEMENT}b"]`],
  ['front-matter', '---\ntitle: x\n---\n\nbody', 'hr h2["title: x"] p["body"]'],
  ['footnote', 'a[^1]\n\n[^1]: note', 'p["a^1"]'],
  ['definition-only', '[ref]: https://e.co', ''],
  ['bare-angle', 'a < b', 'p["a < b"]'],
];

describe('the 06 §3.5.2 mapping, on the golden corpus', () => {
  it('has at least the 150 cases the criterion asks for', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(150);
    // Unique names, because a duplicate is a case somebody meant to add and silently replaced.
    expect(new Set(CORPUS.map(([name]) => name)).size).toBe(CORPUS.length);
  });

  it.each(CORPUS)('%s', (_name, markdown, expected) => {
    expect(parse(markdown)).toBe(expected);
  });
});
