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
 * How much of the spec row's vocabulary the manifest row reproduces.
 *
 * Not an exact string match: the manifest's text is **product copy** and the spec's is a table —
 * "Charter, tool catalog, …" against "Charter, tool catalogue, constitution charter, …". What must
 * hold is that the manifest says the same *things*, so this is the share of the spec row's
 * significant words that appear somewhere in the manifest row.
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

/**
 * How much of a spec row's vocabulary a manifest row must carry.
 *
 * Calibrated by measurement, not taste: the real rows score 0.62–1.00 (printed by the test below
 * when it fails), and the review's planted rewrite — three columns replaced with "Nothing at all /
 * Nobody / Local" — scores near zero. 0.5 sits well clear of both, so the check fails on a
 * rewrite and does not fail on the ordinary copy-editing the manifest's text is.
 */
const MIN_OVERLAP = 0.5;

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

  /**
   * The mapped rows' text for one column, joined.
   *
   * A spec row that maps to two manifest rows has **one** cell per column covering both — `extract`
   * says "Group members; the DM owner" once, and the manifest splits that across `extract` and
   * `extract.dm`. Comparing the cell against each row on its own would fail by construction, so
   * the comparison is against the union, which is what the cell actually describes.
   */
  const mappedText = (index: number, column: 'sends' | 'whose' | 'localAlternative'): string =>
    (ROW_SURFACES[index] ?? []).map((surface) => egressRow(surface)[column]).join(' ');

  it('says the same things in "sent to the provider" as the spec does', () => {
    // Word overlap rather than string equality: the manifest's text is product copy and the
    // spec's is a table. What must hold is that it names the same things.
    for (const [index, row] of spec.entries()) {
      const manifest = mappedText(index, 'sends');
      const score = overlap(row.sends, manifest);
      expect(
        score,
        `"${row.route}" · sends · ${score.toFixed(2)} overlap\n  spec:     ${row.sends}\n  manifest: ${manifest}`,
      ).toBeGreaterThanOrEqual(MIN_OVERLAP);
    }
  });

  it('says the same things in "whose data" as the spec does', () => {
    // The column a member actually cares about, and the one the review's planted rewrite replaced
    // with "Nobody".
    for (const [index, row] of spec.entries()) {
      const manifest = mappedText(index, 'whose');
      const score = overlap(row.whose, manifest);
      expect(
        score,
        `"${row.route}" · whose · ${score.toFixed(2)} overlap\n  spec:     ${row.whose}\n  manifest: ${manifest}`,
      ).toBeGreaterThanOrEqual(MIN_OVERLAP);
    }
  });

  it('never reads as an absence, because no row of the spec is one', () => {
    // The specific lie the review planted, asserted directly rather than relying on the overlap
    // threshold to catch it. No exemptions: every row of `08` §3.11.1 names data that is sent —
    // the three opt-ins name what goes when they are switched on, and `embed`/`transcribe` name
    // what goes if a host configures an API. So no manifest row may read as "nothing happens".
    const absences = [/nothing leaves/i, /nothing at all/i, /\bnobody\b/i, /no longer leaves/i];
    for (const surface of EGRESS_SURFACES) {
      const row = egressRow(surface);
      for (const pattern of absences) {
        expect(
          `${row.sends} ${row.whose} ${row.localAlternative}`,
          `${surface} · ${String(pattern)}`,
        ).not.toMatch(pattern);
      }
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
