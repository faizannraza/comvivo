/**
 * The egress manifest matches `08` §3.11.1 (`M2-T16`).
 *
 * The AC is "manifest matches `08` §3.11.1", and the only way to assert that rather than assert
 * that *something* exists is to parse the table out of the plan and compare. `08` SD-15 promises a
 * group honest minimization, and the honesty is entirely in whether this list stays true: the
 * wizard, `doctor`, the dashboard and the privacy disclosure all render from it, so a row that
 * drifted would tell four surfaces the same wrong thing.
 *
 * Lives under `test/plan/` for the same reason the built-in catalogue's cross-check does: reading
 * the plan needs `node:fs`, and this is a code-versus-`docs/plan` consistency check rather than a
 * test of the package.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EGRESS_MANIFEST,
  EGRESS_SURFACES,
  type EgressRow,
  type EgressSurface,
  egressRow,
  PROVIDER_HYGIENE,
} from '../../packages/models/src/egress-manifest.js';

const SPEC = fileURLToPath(new URL('../../docs/plan/08-security-privacy.md', import.meta.url));

/** One row of `08` §3.11.1, all four columns. */
interface SpecRow {
  readonly route: string;
  readonly sends: string;
  readonly whose: string;
  readonly localAlternative: string;
}

/**
 * Parse `08` §3.11.1's table — **every column**, not just the first.
 *
 * The first version of this read column 1 only and compared a row **count**. The M2 independent
 * review proved it vacuous from both sides: renaming the `route` row and rewriting all three of its
 * data columns to "Nothing at all; this route no longer leaves the host / Nobody / Local" passed,
 * and so did making the same change in the manifest. A member could have been told "nothing leaves
 * the host" for a route that sends the recent window, with the only test that exists to prevent
 * exactly that green. `08` SD-15 promises honest minimization and four surfaces render from this
 * list, so the comparison has to be over the words.
 */
function parseSpecTable(): readonly SpecRow[] {
  const markdown = readFileSync(SPEC, 'utf8');
  const section = markdown.split('#### 3.11.1')[1];
  if (section === undefined) throw new Error('08 §3.11.1 not found; the heading moved');
  const table = section.split('\nProvider-specific hygiene')[0] ?? section;

  const rows: SpecRow[] = [];
  for (const line of table.split('\n')) {
    const cells = line.split('|');
    // A body row is `| a | b | c | d |` → six pieces with empty ends.
    if (cells.length !== 6) continue;
    const [, route, sends, whose, localAlternative] = cells.map((cell) => cell.trim());
    if (route === undefined || route === '' || route.startsWith('---') || route === 'Route') {
      continue;
    }
    rows.push({
      route,
      sends: sends ?? '',
      whose: whose ?? '',
      localAlternative: localAlternative ?? '',
    });
  }
  return rows;
}

/** Words that carry meaning, for comparing a manifest row against its spec row. */
function significantWords(text: string): readonly string[] {
  return (
    text
      .toLowerCase()
      // Markdown emphasis, backticks and punctuation are formatting, not content.
      .replaceAll(/[*`_()[\]{}.,;:!?"'’—–…/]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !STOP_WORDS.has(word))
  );
}

/**
 * Words too common to distinguish one row from another.
 *
 * Deliberately short. A long stop list would let a rewritten row pass by stripping away everything
 * that made it specific, which is the failure this whole function exists to prevent.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'that',
  'this',
  'with',
  'from',
  'they',
  'them',
  'their',
  'when',
  'what',
  'then',
  'than',
  'only',
  'also',
  'into',
  'each',
  'both',
  'more',
  'some',
  'such',
  'very',
  'will',
  'would',
  'been',
  'have',
  'does',
  'default',
]);

/**
 * How much of a spec **item**'s vocabulary a manifest row reproduces.
 *
 * Not an exact string match: the manifest's text is product copy and the spec's is a table, so
 * "Charter, tool catalog, …" has to match "Charter, tool catalogue, constitution charter, …".
 * What must hold is that the manifest names the same things.
 */
function overlap(specText: string, manifestText: string): number {
  const specWords = [...new Set(significantWords(specText))];
  if (specWords.length === 0) return 1;
  const manifestWords = new Set(significantWords(manifestText));
  const carries = (word: string): boolean =>
    manifestWords.has(word) ||
    (SYNONYMS.get(word)?.every((part) => manifestWords.has(part)) ?? false);
  return specWords.filter(carries).length / specWords.length;
}

/**
 * Plain-language renderings of the spec table's shorthand.
 *
 * Members read the manifest in the wizard and the dashboard, so it says "the person who asked"
 * where `08` §3.11.1's table says "Requester" — the same fact, in the register a member reads in.
 * Declared here rather than stop-worded away: one checkable translation keeps the comparison
 * strict for every other row, and a row rewritten to "Nobody" still carries neither form.
 */
const SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map([
  ['requester', ['person', 'asked']],
]);

/** How much of one spec item a manifest row must carry for that item to count as named. */
const MIN_ITEM_OVERLAP = 0.5;

/**
 * The things a spec cell names, one per item.
 *
 * The first version of this check compared a whole cell at once, and the M2 second-pass review
 * showed that lets **half a row's named items be deleted**: dropping "audience-readable memories"
 * from `chat.group` left the rest of a long cell scoring well over the threshold. A cell is a
 * list, so it is compared as a list — each item on its own, against its own floor.
 *
 * Split on `;`, `,` and `+`, which is how the table punctuates. Parenthesised asides stay with
 * their item ("Recent window (≤ 12 messages)"), and an item too short to carry meaning is dropped
 * rather than matched loosely.
 */
function specItems(cell: string): readonly string[] {
  return cell
    .split(/[;,+]|\band\b/)
    .map((part) => part.trim())
    .filter((part) => significantWords(part).length > 0);
}

/**
 * Phrases that turn a statement of what is sent into a statement that nothing is.
 *
 * The hole this closes is the one the second-pass review walked through four times: `overlap()` is
 * **one-directional**, so a row rewritten to "The recent window and the trigger **are never
 * sent**; this decision is made on your own machine" keeps every word the spec uses and scores
 * 1.00. Word overlap cannot see a negation, and a privacy manifest is exactly the document where
 * a negation is the lie somebody would tell.
 *
 * So negation is banned outright in `sends` and `whose` — not scored. `08` §3.11.1 has **no** row
 * that says nothing is sent: the three opt-ins say what goes when they are switched on, and
 * `embed`/`transcribe` say what goes if a host configures an API. A manifest row that reads as an
 * absence is therefore wrong whatever its vocabulary.
 *
 * This list is a denylist and a denylist is never complete — a determined rewrite in words nobody
 * thought of would still pass. What makes the check hard to defeat is the pairing: every spec item
 * must be *named* (below), and nothing may read as an absence (here). Saying less is caught by the
 * first and saying the opposite by the second.
 */
/**
 * Everything after a row's first sentence or colon.
 *
 * For an off-by-default or local-by-default row, the first clause is the absence a member should
 * read first ("Nothing unless switched on.", "Local by default: embedding runs on this host.") and
 * the rest is what actually goes. Only the rest is held to the negation ban.
 */
function afterOpeningClause(text: string): string {
  const cut = text.search(/[.:]/);
  return cut === -1 ? text : text.slice(cut + 1);
}

const NEGATIONS: readonly RegExp[] = [
  /\bnever\b/i,
  /\bnot sent\b/i,
  /\bno longer\b/i,
  // Not `\bnothing\b` alone: "reveals this machine's IP address **and nothing else**" is a
  // *limitation* on what goes, which is the reassurance a member wants after being told what does.
  // "Nothing leaves the host" and "Nothing at all" still match.
  /\bnothing\b(?!\s+else)/i,
  /\bnobody\b/i,
  /\bnone of\b/i,
  /\bare not\b/i,
  /\bis not\b/i,
  /\bstripped\b/i,
  /\bredacted\b/i,
  /\banonymi[sz]ed\b/i,
  /\bonly a count\b/i,
  /\bno [a-z]+ (?:data|members|memories|messages|text) /i,
  /^\s*(?:no|none)\b/i,
];

/**
 * Which manifest surfaces each `08` §3.11.1 row maps to, **in the table's order**.
 *
 * Declared rather than inferred from the first column: that column is prose (`media (vision/pdf)`,
 * `web search (opt-in)`) and matching it by pattern is a heuristic that fails silently. A declared
 * list is checkable — the test below asserts the spec has exactly this many rows, so a row added
 * to `08` §3.11.1 fails here until somebody maps it.
 *
 * Two rows map to two surfaces each. `chat` is two rows in the spec and two here. `extract` is
 * **one** spec row and two here, because §3.11.2 moves the DM half onto the local model in Hybrid
 * and leaves the group half in the cloud — one row cannot carry both.
 */
const ROW_SURFACES: readonly (readonly EgressSurface[])[] = [
  ['chat.group'],
  ['chat.dm'],
  ['route'],
  ['extract', 'extract.dm'],
  ['declassify'],
  ['guard'],
  ['consolidate'],
  ['embed'],
  ['transcribe'],
  ['media'],
  ['web_search'],
  ['mcp_remote'],
  ['update_check'],
];

describe('the manifest reproduces every column of 08 §3.11.1', () => {
  const spec = parseSpecTable();

  it('found the table with all four columns, so the comparisons are not comparing nothing', () => {
    expect(spec).toHaveLength(ROW_SURFACES.length);
    const first = spec[0];
    expect(first?.route).toContain('chat');
    // The positive control that matters: the data columns are populated, not empty strings. A
    // parser that silently returned blanks would make every overlap check below pass at 1.0.
    expect(first?.sends.length).toBeGreaterThan(40);
    expect(first?.whose.length).toBeGreaterThan(5);
    expect(first?.localAlternative.length).toBeGreaterThan(2);
  });

  /** The manifest rows a spec row maps to. */
  const mappedRows = (index: number) => (ROW_SURFACES[index] ?? []).map((s) => egressRow(s));

  /**
   * Every item of a spec cell is named by **one** of the rows it maps to — and every row names at
   * least one item.
   *
   * Two halves, and the second is the one the second-pass review needed. A spec row that maps to
   * two manifest rows has one cell covering both — `extract`'s "Group members; the DM owner" is
   * split across `extract` and `extract.dm` — so an item has to be allowed to land in either. But
   * comparing against the *union* alone means one half can say anything at all while the other
   * carries the vocabulary: the review rewrote `extract.sends` to "Only a count of how many
   * messages there were" and all thirteen tests passed. Requiring each row to carry at least one
   * item closes that.
   */
  /** Which mapped row names a spec item best, and how well. */
  const bestMatch = (
    rows: readonly EgressRow[],
    column: 'sends' | 'whose',
    item: string,
  ): { surface: EgressSurface; score: number } | undefined =>
    rows
      .map((row) => ({ surface: row.surface, score: overlap(item, row[column]) }))
      .toSorted((a, b) => b.score - a.score)[0];

  /**
   * A spec cell that carries no checkable vocabulary — `embed`'s "All", `update_check`'s "—".
   *
   * What *is* checkable is whether the two documents agree there is nothing to say: a dash on one
   * side must mean a dash on the other. The structural checks below carry these two rows.
   */
  const assertNothingToMatch = (
    specCell: string,
    route: string,
    column: 'sends' | 'whose',
    rows: readonly EgressRow[],
  ): void => {
    const specIsDash = /^[—–-]$/.test(specCell.trim());
    for (const row of rows) {
      expect(
        /^[—–-]$/.test(row[column].trim()),
        `"${route}" · ${column} · the spec says "${specCell}" and ${row.surface} says "${row[column]}"`,
      ).toBe(specIsDash);
      expect(row[column].trim().length).toBeGreaterThan(0);
    }
  };

  /**
   * Every item of a spec cell is named by **one** of the rows it maps to — and every row names at
   * least one item.
   *
   * Two halves, and the second is the one the second-pass review needed. A spec row that maps to
   * two manifest rows has one cell covering both — `extract`'s "Group members; the DM owner" is
   * split across `extract` and `extract.dm` — so an item has to be allowed to land in either. But
   * comparing against the *union* alone means one half can say anything at all while the other
   * carries the vocabulary: the review rewrote `extract.sends` to "Only a count of how many
   * messages there were" and all thirteen tests passed. Requiring each row to carry at least one
   * item closes that.
   */
  const assertItemsNamed = (column: 'sends' | 'whose'): void => {
    for (const [index, specRow] of spec.entries()) {
      const rows = mappedRows(index);
      const items = specItems(specRow[column]);
      if (items.length === 0) {
        assertNothingToMatch(specRow[column], specRow.route, column, rows);
        continue;
      }

      const naming = new Set<string>();
      for (const item of items) {
        const best = bestMatch(rows, column, item);
        expect(
          best?.score ?? 0,
          `"${specRow.route}" · ${column} · the spec names "${item}" and no mapped row does` +
            ` (best ${best?.surface ?? 'none'} at ${(best?.score ?? 0).toFixed(2)})\n` +
            rows.map((row) => `  ${row.surface}: ${row[column]}`).join('\n'),
        ).toBeGreaterThanOrEqual(MIN_ITEM_OVERLAP);
        if (best !== undefined) naming.add(best.surface);
      }

      // Every row earns its place. A split row whose other half carries all the vocabulary must
      // still say something the spec says.
      for (const row of rows) {
        expect(
          naming.has(row.surface),
          `"${specRow.route}" · ${column} · ${row.surface} names none of the spec's ` +
            `${String(items.length)} item(s)\n  it says: ${row[column]}`,
        ).toBe(true);
      }
    }
  };

  it('names every thing the spec says is sent, item by item', () => {
    assertItemsNamed('sends');
  });

  it('names every one of the people the spec says can be included', () => {
    assertItemsNamed('whose');
  });

  it('never reads as an absence, because no row of the spec is one', () => {
    // The hole word overlap cannot see. `overlap()` scores how much of the **spec's** vocabulary a
    // row reproduces, so "The recent window and the trigger **are never sent**; this decision is
    // made on your own machine" keeps every word and scores 1.00 while saying the opposite. The
    // second-pass review passed four such rewrites through the previous version of this file.
    //
    // No exemptions: `08` §3.11.1 has no row that says nothing is sent. The three opt-ins say what
    // goes when they are switched on, and `embed`/`transcribe` say what goes if a host configures
    // an API — so a manifest row reading as an absence is wrong whatever its vocabulary.
    for (const surface of EGRESS_SURFACES) {
      const row = egressRow(surface);
      // A row that is **off or local by default** may truthfully open with an absence —
      // `web_search` says "Nothing unless switched on. Then: the query strings", which is both
      // accurate and the right thing for a member to read first. So for those rows the opening
      // clause is set aside and the ban applies to what follows, which is where a lie about what
      // goes when the route *is* active would live. For a row that is on by default there is no
      // such clause and no exemption: those are the nine surfaces a group's data flows through
      // today, and they are where this check has to be absolute.
      const exempt = row.byDefault !== 'cloud';
      const sends = exempt ? afterOpeningClause(row.sends) : row.sends;
      for (const pattern of NEGATIONS) {
        expect(
          `${sends} ${row.whose}`,
          `${surface} · reads as an absence · ${String(pattern)}\n  sends: ${sends}\n  whose: ${row.whose}`,
        ).not.toMatch(pattern);
      }
    }
  });

  it('would catch a negation, which is the control for the rule above', () => {
    // The denylist is only worth what it matches, and a denylist nobody probes is the shape of
    // guard this whole file exists because of. These are the exact rewrites the review planted.
    const planted = [
      'The recent window (at most 12 messages) and the trigger **are never sent**; this decision is made on your own machine',
      '**No** group members are identifiable; everything is stripped first',
      'Only a count of how many messages there were',
      'Nothing leaves the host for this route',
      'Nobody',
    ];
    for (const text of planted) {
      expect(
        NEGATIONS.some((pattern) => pattern.test(text)),
        `nothing in NEGATIONS matches: ${text}`,
      ).toBe(true);
    }
  });

  it('maps every manifest surface to exactly one spec row', () => {
    const mapped = ROW_SURFACES.flat();
    expect(mapped.toSorted()).toEqual([...EGRESS_SURFACES].toSorted());
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  it('keeps the manifest in the spec table’s order', () => {
    expect(EGRESS_MANIFEST.map((row) => row.surface)).toEqual(ROW_SURFACES.flat());
  });

  it('marks as local-by-default exactly the two the spec does', () => {
    // `08` §3.11.1 writes "**Local by default.**" for `embed` and `transcribe` and nothing else.
    const specLocal = spec.flatMap((row, index) =>
      /local by default/i.test(row.sends) ? (ROW_SURFACES[index] ?? []) : [],
    );
    expect(specLocal).toEqual(['embed', 'transcribe']);
    expect(
      EGRESS_MANIFEST.filter((row) => row.byDefault === 'local').map((r) => r.surface),
    ).toEqual(specLocal);
  });

  it('marks as off-by-default exactly the three opt-ins', () => {
    expect(EGRESS_MANIFEST.filter((row) => row.byDefault === 'off').map((r) => r.surface)).toEqual([
      'web_search',
      'mcp_remote',
      'update_check',
    ]);
  });

  it('keeps the DM warning the spec emphasises', () => {
    const dmExtract = EGRESS_MANIFEST.find((row) => row.surface === 'extract.dm');
    // `08` §3.11.1 bolds "**DM extraction sends DM text**", which is the sentence a member needs
    // to see before consenting.
    expect(dmExtract?.sends).toContain('DM extraction sends DM text');
  });

  it('splits extract because Hybrid moves only its DM half', () => {
    const group = EGRESS_MANIFEST.find((row) => row.surface === 'extract');
    const dm = EGRESS_MANIFEST.find((row) => row.surface === 'extract.dm');
    expect(group?.hybridMovesLocal).toBe(false);
    expect(dm?.hybridMovesLocal).toBe(true);
  });

  it('records the three provider-hygiene claims, and admits which one it cannot enforce', () => {
    expect(PROVIDER_HYGIENE).toHaveLength(3);
    expect(PROVIDER_HYGIENE[0]?.claim).toContain('store: false');
    expect(PROVIDER_HYGIENE[0]?.enforcedBy).toContain('openai');
    // The key-sharing one cannot be checked from inside the process, and saying so is the point.
    expect(PROVIDER_HYGIENE.filter((entry) => entry.enforcedBy === undefined)).toHaveLength(1);
  });
});

describe('Hybrid is not pre-selected anywhere (D-6)', () => {
  it('ships `sensitiveRoutesLocal` and `localOnly` off in the config schema', () => {
    // `15` §1 D-6 is the owner's decision and has not been made. Until it is, the wizard shows
    // Hybrid as an **unselected** option (`08` OQ-6), so nothing in the shipped defaults may turn
    // it on — and a default that flipped would pre-empt a decision that is not ours.
    const schema = readFileSync(
      fileURLToPath(new URL('../../packages/shared/src/config/schema.ts', import.meta.url)),
      'utf8',
    );
    expect(schema).toContain('localOnly: z.boolean().default(false)');
    expect(schema).toContain('sensitiveRoutesLocal: z.boolean().default(false)');
  });

  it('has no preset that turns either mode on', () => {
    const presets = readFileSync(
      fileURLToPath(new URL('../../packages/models/src/registry/presets.json', import.meta.url)),
      'utf8',
    );
    expect(presets).not.toContain('sensitiveRoutesLocal');
    expect(presets).not.toContain('localOnly');
  });
});
