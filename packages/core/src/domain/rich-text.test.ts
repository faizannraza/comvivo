/**
 * `RichTextSchema` against `06` §3.5.1's four hard limits.
 *
 * Each limit gets a case at the boundary and one past it, because an off-by-one in a nesting depth
 * or a node budget is the failure mode these limits actually have — a document rejected at three
 * levels of list nesting breaks ordinary Markdown, and one accepted at five defeats the limit.
 */
import { idSchema } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import {
  type Block,
  type Inline,
  RICH_TEXT_MAX_LIST_DEPTH,
  RICH_TEXT_MAX_NODES,
  RICH_TEXT_MAX_QUOTE_DEPTH,
  RichTextSchema,
} from './rich-text.js';

/**
 * A valid member id for a mention target.
 *
 * Parsed rather than written as a string literal: `MemberId` is branded, so a bare literal is not
 * one and `tsconfig.test.json`'s typecheck says so — which `vitest run` alone does not.
 */
const MEMBER_ID = idSchema('mbr').parse('mbr_01jqw8z5h7e9r3t4y5v6k7p8q9');

/** A tab, a newline and a NUL, built from escapes so the source holds no control bytes. */
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);
const NUL = String.fromCharCode(0);

const document = (...blocks: Block[]) => ({ v: 1 as const, blocks });
const paragraph = (...inline: Inline[]): Block => ({ t: 'p', c: inline });
const textRun = (text: string): Inline => ({ t: 'text', text });

/** `depth` levels of nested list, each level holding one item. */
function nestedList(depth: number): Block {
  const leaf: Block = paragraph(textRun('leaf'));
  return Array.from({ length: depth }).reduce<Block>(
    (child) => ({ t: 'list', ordered: false, items: [[child]] }),
    leaf,
  );
}

/** `depth` levels of nested quote. */
function nestedQuote(depth: number): Block {
  const leaf: Block = paragraph(textRun('leaf'));
  return Array.from({ length: depth }).reduce<Block>((child) => ({ t: 'quote', c: [child] }), leaf);
}

const messagesOf = (value: unknown): string[] => {
  const outcome = RichTextSchema.safeParse(value);
  return outcome.success ? [] : outcome.error.issues.map((issue) => issue.message);
};

describe('a document the parser would produce', () => {
  it('accepts every block and inline kind of 06 §3.5.1', () => {
    const value = document(
      { t: 'h', level: 2, c: [textRun('Saturday')] },
      paragraph(
        { t: 'text', text: 'bring ', marks: ['b', 'i'] },
        { t: 'code', text: 'sunscreen' },
        { t: 'br' },
        { t: 'link', url: 'https://example.com/map', c: [{ t: 'text', text: 'the map' }] },
        { t: 'mention', target: { kind: 'member', memberId: MEMBER_ID }, fallback: '@Ada' },
        {
          t: 'mention',
          target: { kind: 'platform_user', platformUserId: '4711' },
          fallback: '@Bo',
        },
        { t: 'time', at: '2026-11-07T09:30:00Z', fallback: 'Saturday 09:30' },
      ),
      { t: 'list', ordered: true, start: 1, items: [[paragraph(textRun('towels'))]] },
      { t: 'code', lang: 'ts', text: 'const x = 1;' },
      { t: 'quote', c: [paragraph(textRun('see you there'))] },
      { t: 'hr' },
    );
    expect(RichTextSchema.parse(value)).toEqual(value);
  });

  it('accepts a document with no blocks', () => {
    // An empty body is what a message carrying only an attachment has.
    expect(RichTextSchema.parse(document())).toEqual({ v: 1, blocks: [] });
  });

  it('refuses a version it does not know', () => {
    // `v` exists so a stored row can be migrated (`12` §3.8); accepting `2` now would mean reading
    // a future document under this version's rules.
    expect(RichTextSchema.safeParse({ v: 2, blocks: [] }).success).toBe(false);
  });

  it('refuses an unknown block or mark', () => {
    expect(RichTextSchema.safeParse(document({ t: 'table' } as never)).success).toBe(false);
    expect(
      RichTextSchema.safeParse(document(paragraph({ t: 'text', text: 'x', marks: ['u'] } as never)))
        .success,
    ).toBe(false);
  });
});

describe('list nesting (06 §3.5.1: at most 3)', () => {
  it('accepts the maximum depth', () => {
    expect(messagesOf(document(nestedList(RICH_TEXT_MAX_LIST_DEPTH)))).toEqual([]);
  });

  it('refuses one level more, saying how deep it was', () => {
    const messages = messagesOf(document(nestedList(RICH_TEXT_MAX_LIST_DEPTH + 1)));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('a list is nested 4 deep');
  });

  it('counts depth per branch, not across siblings', () => {
    // Three sibling lists are not a list nested three deep. A single running counter instead of
    // per-branch depth is the easy way to get this wrong, and it would reject an ordinary message
    // with three separate bullet lists in it.
    expect(messagesOf(document(nestedList(1), nestedList(1), nestedList(1)))).toEqual([]);
  });

  it('counts list and quote depth independently', () => {
    // A list inside a quote is depth 1 of each, not depth 2 of something.
    expect(messagesOf(document({ t: 'quote', c: [nestedList(RICH_TEXT_MAX_LIST_DEPTH)] }))).toEqual(
      [],
    );
  });
});

describe('quote nesting (06 §3.5.1: at most 2)', () => {
  it('accepts the maximum depth', () => {
    expect(messagesOf(document(nestedQuote(RICH_TEXT_MAX_QUOTE_DEPTH)))).toEqual([]);
  });

  it('refuses one level more', () => {
    const messages = messagesOf(document(nestedQuote(RICH_TEXT_MAX_QUOTE_DEPTH + 1)));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('a quote is nested 3 deep');
  });
});

describe('node budget (06 §3.5.1: at most 5 000)', () => {
  /**
   * `count` line breaks in one paragraph.
   *
   * **Measured, and the reason this is not built from text runs.** A `{"t":"text","text":"x"}` run
   * is about 24 bytes of JSON, so 5 000 of them is ~120 KB and the 64 KiB column cap rejects the
   * document before the node budget is ever reached. `{"t":"br"}` is 11 bytes with its comma, so
   * ~5 950 of them fit inside the cap — which means the node budget binds only for the cheapest
   * node kinds, and those are exactly the ones it has to catch: a document of 6 000 line breaks
   * is 64 KiB of nothing that would still blow up a renderer's node count.
   */
  const breaks = (count: number) =>
    document(paragraph(...Array.from({ length: count }, (): Inline => ({ t: 'br' }))));

  it('accepts a document at exactly the budget', () => {
    // One paragraph block plus 4 999 line breaks.
    expect(messagesOf(breaks(RICH_TEXT_MAX_NODES - 1))).toEqual([]);
  });

  it('refuses one node more, saying the count', () => {
    const messages = messagesOf(breaks(RICH_TEXT_MAX_NODES));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('5001 nodes');
  });

  it('is reached before the byte cap only for cheap nodes', () => {
    // The interaction above, pinned: the same node count made of text runs is rejected by the cap
    // instead. If either limit moves, this says so.
    const runs = Array.from({ length: RICH_TEXT_MAX_NODES }, () => textRun('x'));
    const messages = messagesOf(document(paragraph(...runs)));
    expect(messages.some((message) => message.includes('65536-byte limit'))).toBe(true);
  });

  it("counts a link's text children", () => {
    // A link node holds its own text runs, so a document could otherwise smuggle unbounded nodes
    // past the budget by putting them all inside links.
    const children = Array.from({ length: RICH_TEXT_MAX_NODES }, () => ({
      t: 'text' as const,
      text: 'x',
    }));
    const value = document(paragraph({ t: 'link', url: 'https://example.com', c: children }));
    expect(messagesOf(value).some((message) => message.includes('nodes'))).toBe(true);
  });
});

describe('limits are reported together', () => {
  it('names every limit a document breaks, not only the first', () => {
    // A caller that fixed the nesting and resubmitted should not then learn about the node count.
    // Line breaks rather than text runs, so the byte cap is not a fourth violation (see the node
    // budget suite above).
    const runs = Array.from({ length: RICH_TEXT_MAX_NODES }, (): Inline => ({ t: 'br' }));
    const value = document(
      paragraph(...runs),
      nestedList(RICH_TEXT_MAX_LIST_DEPTH + 1),
      nestedQuote(RICH_TEXT_MAX_QUOTE_DEPTH + 1),
    );
    const messages = messagesOf(value);
    expect(messages).toHaveLength(3);
    expect(messages.some((message) => message.includes('nodes'))).toBe(true);
    expect(messages.some((message) => message.includes('a list is nested'))).toBe(true);
    expect(messages.some((message) => message.includes('a quote is nested'))).toBe(true);
  });
});

describe('link URLs (06 §3.5.1: https, http, mailto only)', () => {
  const link = (url: string) =>
    document(paragraph({ t: 'link', url, c: [{ t: 'text', text: 'here' }] }));

  it.each([
    'https://example.com',
    'http://example.com/a?b=c#d',
    'HTTPS://EXAMPLE.COM',
    'mailto:ada@example.com',
  ])('accepts %s', (url) => {
    expect(messagesOf(link(url))).toEqual([]);
  });

  it.each([
    // `no-script-url` exists to stop a script URL being *used*; asserting that the schema rejects
    // one is the opposite, and building the string from fragments to dodge the rule would hide the
    // single most important case in this file.
    // eslint-disable-next-line no-script-url -- the fixture that proves this scheme is refused
    'javascript:alert(1)',
    'data:text/html,<p>x</p>',
    'ftp://example.com/f',
    'file:///etc/passwd',
    '/relative/path',
    'example.com',
    'https://',
    'mailto:ada',
  ])('refuses %s', (url) => {
    expect(messagesOf(link(url))).not.toEqual([]);
  });

  it('refuses a URL with a control character smuggled into the scheme', () => {
    // The reason the control-character check is separate from the scheme patterns: some HTML
    // parsers read a tab-interrupted `javascript:` as the scheme, while a naive prefix test on the
    // literal string does not.
    const smuggled = [
      `java${TAB}script:alert(1)`,
      `java${NEWLINE}script:alert(1)`,
      `https://a${NUL}b.com`,
    ];
    for (const url of smuggled) {
      expect(messagesOf(link(url)), JSON.stringify(url)).not.toEqual([]);
    }
  });
});

describe('code fence language (06 §3.5.1)', () => {
  it.each(['ts', 'c++', 'f#', 'objective-c', 'html'])('accepts %s', (lang) => {
    expect(messagesOf(document({ t: 'code', lang, text: 'x' }))).toEqual([]);
  });

  it.each(['TypeScript', 'ts ', 'a'.repeat(21), ''])('refuses %s', (lang) => {
    expect(messagesOf(document({ t: 'code', lang, text: 'x' }))).not.toEqual([]);
  });

  it('accepts a fence with no language', () => {
    expect(messagesOf(document({ t: 'code', text: 'x' }))).toEqual([]);
  });
});

describe('mentions and times', () => {
  it('requires a member mention to carry a member id', () => {
    const bad = document(
      paragraph({
        t: 'mention',
        target: { kind: 'member', memberId: 'grp_01jqw8z5h7e9r3t4y5v6k7p8q9' as never },
        fallback: '@Ada',
      }),
    );
    expect(messagesOf(bad)).not.toEqual([]);
  });

  it('requires a time node to hold an ISO instant', () => {
    const at = (value: string) => document(paragraph({ t: 'time', at: value, fallback: 'then' }));
    expect(messagesOf(at('2026-11-07T09:30:00Z'))).toEqual([]);
    expect(messagesOf(at('2026-11-07T09:30:00+05:45'))).toEqual([]);
    expect(messagesOf(at('Saturday'))).not.toEqual([]);
    expect(messagesOf(at('2026-11-07'))).not.toEqual([]);
  });
});

describe('the 64 KiB column cap (02 §3.3.9)', () => {
  it('refuses a document whose JSON exceeds the cap', () => {
    // Two nodes, so the node budget cannot be what rejects this.
    const messages = messagesOf(document(paragraph(textRun('x'.repeat(70_000)))));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('65536-byte limit');
  });

  it('accepts a large but within-budget document', () => {
    expect(messagesOf(document(paragraph(textRun('x'.repeat(60_000)))))).toEqual([]);
  });
});
