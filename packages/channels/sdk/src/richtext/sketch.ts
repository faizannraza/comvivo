/**
 * A one-line rendering of a RichText document, for the golden corpus (`06` §3.5.2; `M3-T3`).
 *
 * `06` §3.5.2's acceptance criterion is "the mapping holds on a ≥ 150-case golden corpus", and the
 * question is what a case's expectation looks like. Three options, and only one of them is
 * reviewable:
 *
 *  - **a literal AST per case** — correct and unreadable. 150 nested object literals is a diff
 *    nobody checks, and the one place a reviewer must be able to see "this input produces that
 *    tree" becomes the place they skim;
 *  - **a snapshot** — `hygiene:check`'s `snapshots-only-in-renderers` refuses it, and rightly:
 *    a snapshot records what the code did, so it agrees with a regression the moment somebody
 *    re-records it;
 *  - **a compact notation**, which is this. `p["hi"*b]` fits on one line, says exactly one thing,
 *    and is wrong in a way a reader notices.
 *
 * It is deliberately **lossless** for everything `06` §3.5.1's AST can hold — marks, list starts,
 * fence languages, link URLs, mention targets — so a case cannot pass by the notation throwing
 * away the field that changed. `sketch.test.ts` asserts that by round-tripping every AST shape.
 *
 * Shipped in `src/` rather than hidden in a test file because `M3-T4`'s renderers and `M3-T5`'s
 * splitter need the same notation for their own corpora, and a second copy of it would be a second
 * notation.
 */
import type { Block, Inline, RichText } from '@comvivo/core';

/**
 * The notation, by example:
 *
 * ```text
 * p["plain"]                        a paragraph of text
 * p["bold"*b "and"*bi]              marks, in canonical order, suffixed after the run
 * h2["Title"]                       a level-2 heading
 * ul[{p["a"]}{p["b"]}]              a bullet list of two items, each one paragraph
 * ol@3[{p["c"]}]                    an ordered list starting at 3
 * code:js("let x = 1")              a fenced block with a language
 * code("plain")                     a fenced block without one
 * q[p["quoted"]]                    a blockquote
 * hr                                a thematic break
 * c("inline")                       inline code
 * a(https://x)["label"]             a link
 * @(member:mbr_…|@Ana)              a member mention and its fallback
 * @(user:U123|@Ana)                 a platform-user mention
 * t(2026-01-01T00:00:00Z|soon)      a time node
 * /                                 a line break
 * ```
 */
export function sketch(document: RichText): string {
  return document.blocks.map(sketchBlock).join(' ');
}

export function sketchBlock(node: Block): string {
  switch (node.t) {
    case 'p':
      return `p[${node.c.map(sketchInline).join(' ')}]`;
    case 'h':
      return `h${String(node.level)}[${node.c.map(sketchInline).join(' ')}]`;
    case 'list': {
      const kind = node.ordered ? 'ol' : 'ul';
      const start = node.start === undefined ? '' : `@${String(node.start)}`;
      const items = node.items.map((item) => `{${item.map(sketchBlock).join(' ')}}`).join('');
      return `${kind}${start}[${items}]`;
    }
    case 'code':
      return `code${node.lang === undefined ? '' : `:${node.lang}`}(${quote(node.text)})`;
    case 'quote':
      return `q[${node.c.map(sketchBlock).join(' ')}]`;
    case 'hr':
      return 'hr';
  }
}

export function sketchInline(node: Inline): string {
  switch (node.t) {
    case 'text':
      return `${quote(node.text)}${node.marks === undefined || node.marks.length === 0 ? '' : `*${node.marks.join('')}`}`;
    case 'code':
      return `c(${quote(node.text)})`;
    case 'link':
      return `a(${node.url})[${node.c.map(sketchInline).join(' ')}]`;
    case 'mention':
      // The **kind** as well as the id, because `06` §3.5.1's two targets can carry the same
      // string — an adapter that reported a platform user id that happened to look like a member
      // id would have sketched identically, and `sketch.test.ts` caught exactly that.
      return `@(${node.target.kind === 'member' ? `member:${node.target.memberId}` : `user:${node.target.platformUserId}`}|${node.fallback})`;
    case 'time':
      return `t(${node.at}|${node.fallback})`;
    case 'br':
      return '/';
  }
}

/**
 * A string in double quotes, with the characters that would make the notation ambiguous escaped.
 *
 * `JSON.stringify` rather than hand-rolled quoting, so a newline in a text run shows as `\n` and a
 * case holding one is still a single line — which is the whole point of the notation.
 */
function quote(text: string): string {
  return JSON.stringify(text);
}
