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
      if (table === '' || column.includes('*')) continue;
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
  'chat_bindings',
  'interaction_tokens',
  'channel_state',
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

  it.each([...new Set(catalog)].sort())('%s has its size cap enforced somewhere', (entry) => {
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
