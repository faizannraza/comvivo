/**
 * `02` §3.3.9's JSON column catalog, read from the spec as **data** (`M1-T12`).
 *
 * The acceptance criterion is that "the JSON column catalog matches `02` §3.3.9 (test iterates
 * `jsonOf` tags)". Both halves are here: the tags come from the schema through
 * `jsonColumnTag`, and the catalog comes from the spec by parsing §3.3.9's table — so neither
 * side is a restatement of the other and a drift in either direction fails.
 *
 * What a drift would actually cost is worth stating, because it is not cosmetic. The catalog's
 * right-hand column is a **size cap**, and `jsonOf` enforces it on write *and* on read. A column
 * that lost its entry would lose its bound, and an unbounded JSON column is one that can be grown
 * until it breaks a context window, a backup, or the 3 ms ingestion budget.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { jsonColumnTag } from './_columns.js';
import * as schema from './index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SPEC = resolve(REPO_ROOT, 'docs/plan/02-domain-model-and-storage.md');

/** A newline, built from its code point so this source holds no literal control character. */
const LF = String.fromCharCode(10);

const dialect = new SQLiteSyncDialect();

/** Every `jsonOf` column in the schema, as `table.column`. */
const jsonColumns = (Object.values(schema) as unknown[])
  .filter((value): value is SQLiteTable => is(value, SQLiteTable))
  .flatMap((table) =>
    Object.values(getTableColumns(table)).flatMap((column) => {
      const tag = jsonColumnTag(column);
      return tag === undefined ? [] : [{ table: getTableName(table), column: column.name, tag }];
    }),
  );

const declaredTags = new Set(jsonColumns.map((entry) => entry.tag));

/**
 * The `table.column` references in §3.3.9's left-hand column.
 *
 * The section lists several columns per row (`memory_items.content` / `.provenance`), so a bare
 * `.name` continues the table named earlier in the same cell.
 */
function parseCatalog(markdown: string): readonly string[] {
  const start = markdown.indexOf('#### 3.3.9 JSON column catalog');
  expect(start, '02 §3.3.9 is in the spec').toBeGreaterThan(-1);
  const section = markdown.slice(start, markdown.indexOf('#### 3.3.10', start));

  const columns: string[] = [];
  for (const line of section.split(LF)) {
    if (!line.startsWith('|') || line.startsWith('|---') || line.includes('Max size')) continue;
    const left = line.split('|')[1] ?? '';
    let table = '';
    for (const match of left.matchAll(/`([a-z0-9_]*)\.([a-z0-9_*]+)`/g)) {
      const named = match[1] ?? '';
      const column = match[2] ?? '';
      if (named !== '') table = named;
      if (table === '') continue;
      // **Wildcards are kept**, not skipped. §3.3.9 writes the `06` row as "`chat_bindings.*`,
      // `interaction_tokens.*`, `channel_state.value_json`" — a deliberate wildcard, because `06`
      // owns those schemas and their set changes with `06` rather than with `02`. Dropping them
      // here made `chat_bindings.last_probe` look uncatalogued the moment `M3-T1` created the
      // table, which is the opposite of what the catalog says. `covered()` below expands them.
      columns.push(`${table}.${column}`);
    }
  }
  return columns;
}

const catalog = parseCatalog(readFileSync(SPEC, 'utf8'));
/** Whether `table.column` is bounded by a `length(...) <= n` CHECK rather than by a `jsonOf`. */
function cappedByCheck(table: string, column: string): boolean {
  const found = (Object.values(schema) as unknown[])
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .find((candidate) => getTableName(candidate) === table);
  if (found === undefined) return false;
  return getTableConfig(found).checks.some((check) => {
    const rendered = dialect.sqlToQuery(check.value).sql;
    return rendered.includes(`length("${table}"."${column}")`) && rendered.includes('<=');
  });
}

/**
 * Catalog entries whose table a later milestone creates.
 *
 * §3.3.9 covers the whole schema, including `06`, `09`, `10` and `11` tables that are not part of
 * M1. Keyed by table so one entry covers all of that table's JSON columns.
 */
const TABLES_SCHEDULED_LATER = new Set([
  // `chat_bindings`, `interaction_tokens` and `channel_state` left this set at `M3-T1`, which is
  // what the "defers no table that already exists" case below is for.
  'pairings',
  'domain_events',
  'group_extensions',
  'plugin_delegations',
  'mcp_tokens',
  'feedback_items',
]);

describe('02 §3.3.9 JSON column catalog', () => {
  it('parses a meaningful number of entries out of the spec', () => {
    // The guard against a parser that matches nothing and makes everything below vacuous.
    expect(catalog.length).toBeGreaterThan(30);
    expect(catalog).toContain('messages.rich_text');
    expect(catalog).toContain('memory_items.provenance');
  });

  it('finds a tag on every jsonOf column and on no other column', () => {
    expect(jsonColumns.length).toBeGreaterThan(90);
    // The negative half: `tid`, `instantMs`, `tzText` and `plainDate*` are `customType`s too, so a
    // reader keyed on `columnType` alone would sweep them up as JSON columns.
    expect(jsonColumnTag(getTableColumns(schema.groups).id)).toBeUndefined();
    expect(jsonColumnTag(getTableColumns(schema.groups).createdAt)).toBeUndefined();
  });

  it.each(jsonColumns)('$tag names its own column', ({ table, column, tag }) => {
    // The tag is what a `STORAGE_JSON_INVALID` error prints and what `doctor --deep` reports, so a
    // tag naming no column sends a host looking for something that does not exist. `02` §3.3.2
    // wrote `labels.co_owners` for `co_owner_member_ids`; this assertion is why that was found.
    expect(tag).toBe(`${table}.${column}`);
  });

  // Wildcards are excluded: `chat_bindings.*` is a statement about a *table*, and a cap belongs to
  // a column. Each concrete column on those tables is still checked — it appears in `jsonColumns`
  // and goes through the cases above and below.
  it.each([...new Set(catalog)].filter((entry) => !entry.endsWith('.*')).sort())(
    '%s has its size cap enforced somewhere',
    (entry) => {
      // §3.3.9's requirement is the **cap**, and there are two legitimate ways to hold it. Almost
      // every column uses `jsonOf`, whose schema carries the bound. `jobs.payload` cannot: its
      // schema is per-kind and known only at dispatch, so §3.3.8 declares it as plain `text` and
      // the cap is a `length()` CHECK instead. Accepting either mechanism is what makes this test
      // about the guarantee rather than about the spelling.
      if (declaredTags.has(entry)) return;
      const [table = '', column = ''] = entry.split('.');
      if (cappedByCheck(table, column)) return;
      expect(
        TABLES_SCHEDULED_LATER.has(table),
        `${entry} is in 02 §3.3.9 with no jsonOf schema, no length CHECK, and no owning milestone`,
      ).toBe(true);
    },
  );

  /**
   * `jsonOf` columns that `02` §3.3.9 does not list.
   *
   * The test above checks **spec → schema**: every catalog entry has its cap enforced. Nothing
   * checked the other direction, so a new `jsonOf` column missing from §3.3.9 passed silently —
   * and `STATUS.md` described this file as checking "all 99 `jsonOf` tags against it", which it
   * did not. Found by the M1 independent review.
   *
   * Measured: **49 catalog entries, 99 `jsonOf` columns, 57 absent.** The *guarantee* is intact —
   * each of these carries its cap in its own `jsonOf` schema, which is where `capped()` lives — so
   * this is a spec-coverage gap rather than an unbounded column. Pinning the list is what keeps it
   * from growing: a new JSON column must either appear in §3.3.9 or be added here on purpose, and
   * a column that gets a catalog entry must be removed from here.
   *
   * **Shrank from 57 to 19 at `M3-T1`.** The parser used to drop §3.3.9's `<table>.*` wildcard
   * entries, so thirty-eight columns on thirteen tables looked uncatalogued when the catalog
   * covers their table explicitly — `confirmation_requests.action_request` against
   * `confirmation_requests.*`, and so on. A gap list that lists non-gaps is a list nobody reads,
   * and these nineteen are the real ones.
   */
  const ABSENT_FROM_CATALOG: ReadonlySet<string> = new Set([
    'calendar_subscriptions.last_error',
    'calendar_subscriptions.lead_times',
    'constitution_versions.adopted_by',
    'constraint_records.approved_by',
    'constraint_records.owner_member_ids',
    'constraint_records.sealed_source_refs',
    'declassifications.subject_refs',
    'deletions.requested_by',
    'jobs.last_error',
    'labels.co_owner_member_ids',
    'memory_events.actor',
    'outbox_messages.last_error',
    'outbox_messages.manifest_label_ids',
    'poll_counts.counts',
    'poll_votes.option_ids',
    'proposals.ballot_refs',
    'proposals.electorate',
    'reminder_firings.outbox_ids',
    'standing_approvals.action_patterns',
  ]);

  it('lists every jsonOf column in 02 §3.3.9, or declares the gap', () => {
    const inCatalog = new Set(catalog);
    /**
     * `<table>.*` in the catalog covers every `jsonOf` column on that table.
     *
     * §3.3.9 writes the `06` row as "`chat_bindings.*`, `interaction_tokens.*`,
     * `channel_state.value_json`" — a deliberate wildcard, because `06` owns those schemas and
     * their set changes with `06` rather than with `02`. Read literally, `chat_bindings.*` matched
     * no column and `chat_bindings.last_probe` looked uncatalogued. Added at `M3-T1`, when those
     * tables arrived.
     */
    const covered = (tag: string): boolean => {
      if (inCatalog.has(tag)) return true;
      const table = tag.slice(0, tag.indexOf('.'));
      return inCatalog.has(`${table}.*`);
    };
    const absent = jsonColumns
      .map((column) => column.tag)
      .filter((tag) => !covered(tag))
      .toSorted();
    expect(
      absent.filter((tag) => !ABSENT_FROM_CATALOG.has(tag)),
      'these JSON columns are in neither `02` §3.3.9 nor the declared-gap list. Add the column to ' +
        'the spec catalog, or add it here with a reason.',
    ).toEqual([]);
    // The other direction, so the list cannot keep entries that have since been catalogued.
    expect(
      [...ABSENT_FROM_CATALOG].filter((tag) => covered(tag)),
      'these are now in `02` §3.3.9 and should come off the declared-gap list',
    ).toEqual([]);
    // Pinned, so a parser that stopped finding anything would fail here rather than make both
    // comparisons trivially empty. The three moved together at `M3-T1`: the catalog gained its
    // thirteen `<table>.*` wildcards (49 → 62) once the parser stopped dropping them, the schema
    // gained three JSON columns on the new channel tables (99 → 102), and the gap list shrank to
    // the columns genuinely absent from §3.3.9 (57 → 19).
    //
    // 107 since `M3-T20`, which added `05` §3.10.1's five sections to `turn_traces`. The catalog
    // count and the gap list are unchanged because §3.3.9 covers that table with a `turn_traces.*`
    // wildcard — which is the wildcard mechanism working as intended: a table whose columns are
    // one subsystem's own gets one row in the catalog, and §3.3.9's row was updated to name the
    // five new schemas in the same commit.
    expect(inCatalog.size).toBe(62);
    expect(jsonColumns).toHaveLength(107);
    expect(absent).toHaveLength(19);
  });

  it('defers no table that already exists', () => {
    // Keeps the allowlist honest: once `M3-T1` adds `chat_bindings`, this fails until its entry
    // is removed, so the list cannot become a permanent excuse.
    const existing = (Object.values(schema) as unknown[])
      .filter((value): value is SQLiteTable => is(value, SQLiteTable))
      .map((table) => getTableName(table));
    const premature = [...TABLES_SCHEDULED_LATER].filter((table) => existing.includes(table));
    expect(premature, 'these tables now exist and should leave the deferred set').toEqual([]);
  });

  it('returns undefined for things that are not columns at all', () => {
    for (const value of [undefined, null, 42, 'messages.rich_text', {}, { config: {} }]) {
      expect(jsonColumnTag(value)).toBeUndefined();
    }
    expect(jsonColumnTag({ config: { fieldConfig: null } })).toBeUndefined();
    expect(jsonColumnTag({ config: { fieldConfig: { jsonTag: 7 } } })).toBeUndefined();
    expect(jsonColumnTag({ config: { fieldConfig: { jsonTag: 'x.y' } } })).toBe('x.y');
  });
});
