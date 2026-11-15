/**
 * What `parse` does when it cannot do its job (`06` §3.5.2; `M3-T3`).
 *
 * The golden corpus in `parse.corpus.test.ts` covers the mapping. This file covers the parts a
 * corpus line cannot express: which **reason** a failure is attributed to, what gets counted, what
 * gets logged, and what reaches a member when the limits are hit.
 *
 * The reason labels matter more than they look. `comvivo_richtext_degraded_total{reason}` is what
 * an operator reads, and the four values point in different directions — two at the prompt's
 * output budget, two at a bug in this repository. A failure filed under the wrong one sends
 * somebody to the wrong place, which is the same class of mistake as a misleading error message.
 */
import {
  type Block,
  RICH_TEXT_MAX_BYTES,
  RICH_TEXT_MAX_LIST_DEPTH,
  type RichText,
  RichTextSchema,
} from '@comvivo/core';
import type { MemberId } from '@comvivo/shared';
import {
  type MetricsBackend,
  type RecordingMetrics,
  recordingMetrics,
  setMetricsBackend,
} from '@comvivo/shared/observability';
import { recordingLogger } from '@comvivo/shared/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { type ParseResult, parseModelOutput } from './parse.js';
import { sketch } from './sketch.js';

const MBR = 'mbr_01jd0000000000000000000000' as MemberId;

function parse(
  markdown: string,
  logger?: Parameters<typeof parseModelOutput>[1]['logger'],
): ParseResult {
  return parseModelOutput(markdown, {
    resolveMember: (id: MemberId) => (id === MBR ? { fallback: '@Ana' } : undefined),
    ...(logger === undefined ? {} : { logger }),
  });
}

/**
 * Install a recorder as the metrics backend.
 *
 * `recordingMetrics()` is a `Metrics`, not a `MetricsBackend` — it has no `shutdown`. Wrapping it
 * here rather than at each call site keeps the two places that count observations identical.
 */
function recording(): RecordingMetrics {
  const recorder = recordingMetrics();
  const backend: MetricsBackend = { ...recorder, shutdown: () => Promise.resolve() };
  setMetricsBackend(backend);
  return recorder;
}

afterEach(() => {
  setMetricsBackend(undefined);
});

describe('the degradation reasons (06 §3.5.2)', () => {
  it('reports `too_large` for an input over 64 KiB, without parsing it', () => {
    // Checked before `fromMarkdown`, so a 10 MB reply costs one length scan rather than a parse.
    // `02` §3.3.9's cap is on the stored JSON, and the markdown is always at least as long.
    const huge = 'a\n\n'.repeat(Math.ceil(RICH_TEXT_MAX_BYTES / 3) + 10);
    const result = parse(huge);
    expect(result.degraded).toBe('too_large');
    expect(RichTextSchema.safeParse(result.richText).success).toBe(true);
  });

  it('reports `node_limit` when the markdown is small and the tree is not', () => {
    // 3 000 soft breaks is one mdast `text` node and 5 999 AST nodes. This is the case that used
    // to be filed as `schema_invalid` — "the parser produced a tree its own schema rejects" —
    // because the walk counted the nodes it *visited* rather than the ones it built.
    const result = parse('a\n'.repeat(3000));
    expect(result.degraded).toBe('node_limit');
  });

  it('reports `node_limit` for too many blocks, too', () => {
    const result = parse('- a\n'.repeat(3000));
    expect(result.degraded).toBe('node_limit');
  });

  it('does not degrade a document that is merely large', () => {
    // A thousand paragraphs: 2 000 nodes and about 30 KB of JSON, so comfortably inside both
    // limits. A guard that rejected this would cost a reply for nothing.
    const large = Array.from({ length: 1000 }, (_, index) => `p${String(index)}`).join('\n\n');
    const result = parse(large);
    expect(result.degraded).toBeUndefined();
    expect(result.richText.blocks).toHaveLength(1000);
  });

  it('reports `output_too_large` when the markdown fits and the AST’s JSON does not', () => {
    // The limit that is easy to miss: `02` §3.3.9's 64 KiB is on the **stored JSON**, and the AST
    // costs about 30 bytes of structure per node. 2 500 short lines is 10 KB of markdown and 90 KB
    // of document, so the input check passes and the column would have refused the row.
    const manyShortParagraphs = Array.from(
      { length: 2400 },
      (_, index) => `p${String(index)}`,
    ).join('\n\n');
    expect(manyShortParagraphs.length).toBeLessThan(RICH_TEXT_MAX_BYTES);
    const result = parse(manyShortParagraphs);
    expect(result.degraded).toBe('output_too_large');
    expect(RichTextSchema.safeParse(result.richText).success).toBe(true);
  });

  it('counts every degradation on the metric, by reason', () => {
    const metrics = recording();
    parse('a\n'.repeat(3000));
    parse('x'.repeat(RICH_TEXT_MAX_BYTES + 1));
    expect(metrics.of('richtext_degraded_total').map((entry) => entry.labels['reason'])).toEqual([
      'node_limit',
      'too_large',
    ]);
  });

  it('counts nothing when the document parsed', () => {
    const metrics = recording();
    parse('**fine**');
    expect(metrics.of('richtext_degraded_total')).toEqual([]);
  });

  it('logs the reason and the size, and never the text', () => {
    const { logger, lines } = recordingLogger();
    parse('secret words\n'.repeat(3000), logger);
    const written = lines();
    const line = written.find((entry) => entry.event === 'channel.richtext_degraded');
    expect(line?.level).toBe('warn');
    expect(line?.fields?.detail).toMatchObject({ reason: 'node_limit' });
    // `01` §11.7: the one event whose temptation is to log the input that broke it.
    expect(JSON.stringify(written)).not.toContain('secret words');
  });
});

describe('the parse terminates (M3-T3)', () => {
  it('refuses pathological block nesting unparsed, in milliseconds', () => {
    // `mdast-util-from-markdown` is quadratic in container nesting: measured at 9.9 s for 6 000
    // levels and about **five minutes** extrapolated to the 64 KiB input cap — inside every other
    // limit, and on the turn's critical path, where it means the member gets nothing while a
    // worker is still busy. "Parsing never throws" was true of that input; "parsing answers" was
    // not, and the second is what a member experiences.
    // The timing bound survives here where it could not above: the work this allows is one scan,
    // measured at 1.0 ms against the 5 minutes the parse would have taken, so 2 s is a margin of
    // three orders of magnitude rather than the 4× a loaded runner costs.
    const started = Date.now();
    const result = parse('- '.repeat(32_000));
    expect(result.degraded).toBe('nesting_limit');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses pathological emphasis nesting unparsed, in milliseconds', () => {
    // The second super-linear shape, and not the same cause: 8 000 emphasis pairs took 27.9 s and
    // then overflowed the walk's own stack. Capping the delimiter runs bounds it at about 230 ms.
    const started = Date.now();
    const result = parse(`${'*a '.repeat(8000)}b${' a*'.repeat(8000)}`);
    expect(result.degraded).toBe('nesting_limit');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('answers at all for every pathological 64 KiB shape measured', () => {
    // Twenty shapes were measured at the input cap and the table is in `STATUS` → `M3-T3`; the
    // slowest that is *not* refused unparsed is `[a](` repeated, at 1.25 s on an idle machine.
    //
    // **No timing assertion here, deliberately.** The first version asserted 5 s and failed at
    // 5 145 ms under a full `pnpm verify` — four times the isolated figure, because the runner was
    // loaded. That is the same trap the bench harness's own `nanos` comment records: wall-clock
    // work has a lower bound and no upper one, since the OS may deschedule it, so every patch to
    // such an assertion makes it weaker until it asserts nothing. What is deterministic is that
    // each shape **terminates and is storable**, which is what this checks; the milliseconds are a
    // measurement and live in the bench and in `STATUS`, where a measurement belongs.
    const cap = 64 * 1024;
    const sized = (unit: string): string => unit.repeat(Math.floor(cap / unit.length) - 1);
    for (const unit of ['[a](', '| a |\n', '```\n', '<a>', '||', '**a *b ~~c `d ']) {
      const result = parse(sized(unit));
      expect(RichTextSchema.safeParse(result.richText).success, unit).toBe(true);
    }
  }, 60_000);

  it('allows the deepest nesting `06` §3.5.1 actually permits', () => {
    // The guard must not refuse a legitimate reply: three lists inside two quotes is the maximum
    // the AST can hold, and a cap that caught it would be worse than the hang it prevents.
    const result = parse('> > - a\n> >   - b\n> >     - c');
    expect(result.degraded).toBeUndefined();
    expect(sketch(result.richText)).toContain('"c"');
  });
});

describe('the newly reachable branches (M3-T3)', () => {
  it('shows an image reference’s alt, and nothing when it has none', () => {
    expect(sketch(parse('![alt][ref]\n\n[ref]: https://e.co/i.png').richText)).toBe('p["alt"]');
    expect(sketch(parse('![][ref]\n\n[ref]: https://e.co/i.png').richText)).toBe('p[]');
  });

  it('joins a link label that spans two lines with a space', () => {
    // A `br` inside a label would split the anchor on every platform that has one.
    expect(sketch(parse('[a  \nb](https://e.co)').richText)).toBe('p[a(https://e.co)["a b"]]');
  });

  it('puts a mention’s fallback in a table cell, and a break as a space', () => {
    // A table becomes a `code` block of plain text, so every inline has to have a plain form —
    // and a newline inside a cell would break the column alignment the block exists for.
    const table = parse(`| @{${MBR}} | a<br>c |\n|---|---|\n| 1 | 2 |`);
    expect(sketch(table.richText)).toContain('@Ana');
    expect(sketch(table.richText)).not.toContain('@{');
  });
});

describe('the degraded document (06 §3.5.2)', () => {
  it('is plain paragraphs split on blank lines', () => {
    const result = parse(`${'a\n'.repeat(3000)}\n\nsecond`);
    expect(result.degraded).toBe('node_limit');
    // The paragraphs of the **input**, not of the half-built tree: the fallback starts from the
    // string, so it cannot inherit whatever went wrong.
    expect(result.richText.blocks.every((block) => block.t === 'p')).toBe(true);
  });

  it('is storable even when the input is pathological', () => {
    for (const input of [
      'x'.repeat(RICH_TEXT_MAX_BYTES * 2),
      '\n\n'.repeat(100_000),
      `${'a\n\n'.repeat(5000)}end`,
      '🙂'.repeat(20_000),
    ]) {
      const result = parse(input);
      const parsed = RichTextSchema.safeParse(result.richText);
      expect(parsed.success, `${input.slice(0, 12)}… (${String(input.length)} chars)`).toBe(true);
    }
  });

  it('leaves an all-whitespace reply as an empty document, for the caller to notice', () => {
    // Not one empty paragraph. Whitespace is valid markdown that means nothing, so `parse` says
    // "nothing" — and the output pipeline (`M3-T26`) is where "the model replied with silence"
    // gets decided. Inventing a paragraph here would hide that from it.
    const result = parse('   \n\t ');
    expect(result.degraded).toBeUndefined();
    expect(result.richText.blocks).toEqual([]);
  });
});

describe('the limits that clamp rather than degrade (06 §3.5.1)', () => {
  it('flattens a list deeper than three levels instead of losing the reply', () => {
    const deep = '- a\n  - b\n    - c\n      - d\n        - e';
    const result = parse(deep);
    expect(result.degraded).toBeUndefined();
    // Three levels of `list`, and the deeper items spliced into the third.
    expect(depthOf(result.richText, 'list')).toBe(RICH_TEXT_MAX_LIST_DEPTH);
    expect(sketch(result.richText)).toContain('"e"');
  });

  it('flattens a quote deeper than two levels', () => {
    const result = parse('> > > > deep');
    expect(result.degraded).toBeUndefined();
    expect(depthOf(result.richText, 'quote')).toBe(2);
    expect(sketch(result.richText)).toContain('"deep"');
  });

  it('keeps the text of every level it flattened', () => {
    // The whole point of clamping: one over-nested list must not cost a member the other 99% of
    // the reply. A degrade-instead would have turned this into five plain paragraphs with no
    // heading, no link and no mention.
    const result = parse('# Title\n\n- a\n  - b\n    - c\n      - d\n\n[l](https://e.co)');
    const printed = sketch(result.richText);
    for (const fragment of ['h1["Title"]', '"a"', '"b"', '"c"', '"d"', 'a(https://e.co)']) {
      expect(printed, fragment).toContain(fragment);
    }
  });
});

/**
 * The deepest nesting of one block kind, for the clamp assertions.
 *
 * Two mutually recursive functions rather than one, because `06` §3.5.1's two limits count
 * different things: a list inside a quote is still a list at depth 1. One function doing both took
 * a nested `if` per kind and read as complexity 22 — over Biome's 20, and over what a reader can
 * follow.
 */
function depthOf(document: RichText, kind: 'list' | 'quote'): number {
  return deepest(document.blocks, kind, 0);
}

function deepest(blocks: readonly Block[], kind: 'list' | 'quote', depth: number): number {
  let found = depth;
  for (const block of blocks) {
    const here = block.t === kind ? depth + 1 : depth;
    if (block.t === 'quote') found = Math.max(found, deepest(block.c, kind, here));
    else if (block.t === 'list') {
      for (const item of block.items) found = Math.max(found, deepest(item, kind, here));
      // A list with no items still counts as a level of nesting.
      found = Math.max(found, here);
    } else found = Math.max(found, here);
  }
  return found;
}

describe('a reply that is long but valid', () => {
  it('parses 5 000 characters of prose without degrading', () => {
    const result = parse('x'.repeat(5000));
    expect(result.degraded).toBeUndefined();
    expect(result.richText.blocks).toHaveLength(1);
  });
});
