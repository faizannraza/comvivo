/**
 * `02` §3.3.13's entity → table checklist, read from the spec as **data** (`M1-T12`).
 *
 * The acceptance criterion is that the checklist "passes for every entity scheduled ≤ M1". A test
 * that restated the checklist would only prove this file agrees with itself, so this one parses
 * §3.3.13 out of `docs/plan/02-domain-model-and-storage.md` and checks every table it names
 * against the real schema. A row added to the spec therefore shows up here on the next run.
 *
 * `02` §3.3.13 says `scripts/schema-doc.ts` (`M1-T26`) is what finally fails CI on this; that
 * script will own the complete check, including the "no table" rows. What this suite adds now is
 * the part `M1-T12` can be held to: every table the checklist names either exists, or is listed
 * below with the milestone that creates it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from './index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SPEC = resolve(REPO_ROOT, 'docs/plan/02-domain-model-and-storage.md');

/**
 * Tables the checklist names that a later milestone creates.
 *
 * Each is here with the milestone that owns it, so the list shrinks as those land and a table that
 * arrives early stops being excused. `M1-T12` is the last schema task of M1, so everything not
 * listed here must exist now.
 */
const SCHEDULED_LATER: Readonly<Record<string, string>> = {
  // 06 — channels and onboarding (M3).
  chat_bindings: 'M3-T1',
  channel_chat_aliases: 'M3-T1',
  dm_contexts: 'M3-T1',
  claim_codes: 'M3-T1',
  link_codes: 'M3-T1',
  interaction_tokens: 'M3-T1',
  channel_state: 'M3-T1',
  rate_limits: 'M3-T1',
  // 09 — dashboard, API and CLI (M9).
  sessions: 'M9',
  login_tokens: 'M9',
  pairings: 'M9',
  invite_codes: 'M9',
  step_up_challenges: 'M9',
  idempotency_keys: 'M9',
  ha_links: 'M9',
  domain_events: 'M9',
  exports: 'M9',
  // 10 — extensibility (M10).
  plugin_installations: 'M10',
  plugin_versions: 'M10',
  group_extensions: 'M10',
  plugin_delegations: 'M10',
  plugin_store_entries: 'M10',
  plugin_egress_log: 'M10',
  mcp_tokens: 'M10',
  mcp_access_log: 'M10',
  mcp_idempotency: 'M10',
  mcp_client_servers: 'M10',
  mcp_tool_snapshots: 'M10',
  skill_records: 'M10',
  // 11 — quality (M11).
  feedback_items: 'M11',
};

/** Every table in the schema, by name, with its column names. */
const tables = new Map<string, ReadonlySet<string>>(
  (Object.values(schema) as unknown[])
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .map((table) => [
      getTableName(table),
      new Set(Object.values(getTableColumns(table)).map((column) => column.name)),
    ]),
);

/** A newline, built from its code point so this source holds no literal control character. */
const LF = String.fromCharCode(10);

interface Reference {
  readonly table: string;
  /** Present for a `table.column` or `table.{a, b}` reference. */
  readonly columns: readonly string[];
}

/**
 * Parse one backticked token into a table and column reference, or `undefined` if it is neither.
 *
 * Split out from `parseChecklist` because that function was doing two jobs — locating the section
 * and decoding each token — and scored 23 against biome's cognitive-complexity limit of 20. The
 * same signal split `rotateData` in `M1-T6` and `auditPermissions` in `M1-T7`, and the same thing
 * was true each time: the three spellings `02` §3.3.13 uses are a decision table, so they read
 * better as one.
 */
function parseReference(token: string): Reference | undefined {
  const braced = /^([a-z0-9_]+)\.\{([^}]*)\}$/.exec(token);
  if (braced) {
    return {
      table: braced[1] ?? '',
      columns: (braced[2] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    };
  }
  const dotted = /^([a-z0-9_]+)\.([a-z0-9_]+)$/.exec(token);
  if (dotted) return { table: dotted[1] ?? '', columns: [dotted[2] ?? ''] };
  if (/^[a-z][a-z0-9_]*$/.test(token)) return { table: token, columns: [] };
  return undefined;
}

/** Slice §3.3.13 out of the spec and decode every table reference in its right-hand column. */
function parseChecklist(markdown: string): readonly Reference[] {
  const start = markdown.indexOf('#### 3.3.13 Entity \u2192 table checklist');
  expect(start, '02 \u00a73.3.13 is in the spec').toBeGreaterThan(-1);
  const section = markdown.slice(start, markdown.indexOf('### 3.4 Full-text search', start));

  const references: Reference[] = [];
  for (const line of section.split(LF)) {
    if (!line.startsWith('|') || line.startsWith('|---')) continue;
    const right = line.split('|')[2] ?? '';
    for (const match of right.matchAll(/`([^`]+)`/g)) {
      const reference = parseReference((match[1] ?? '').trim());
      if (reference !== undefined) references.push(reference);
    }
  }
  return references;
}

const references = parseChecklist(readFileSync(SPEC, 'utf8'));

describe('02 §3.3.13 entity → table checklist', () => {
  it('parses a meaningful number of references out of the spec', () => {
    // The guard against a parser that silently matches nothing: a regex change that broke the
    // extraction would otherwise make every assertion below vacuously true.
    expect(references.length).toBeGreaterThan(40);
    expect(references.map((reference) => reference.table)).toContain('constraint_records');
    expect(
      references.some(
        (reference) => reference.table === 'members' && reference.columns.includes('age_band'),
      ),
    ).toBe(true);
  });

  it.each([...new Set(references.map((reference) => reference.table))].sort())(
    '%s exists, or is scheduled for a named later milestone',
    (table) => {
      if (tables.has(table)) return;
      const owner = SCHEDULED_LATER[table];
      expect(
        owner,
        `${table} is named by 02 §3.3.13 but is neither in the schema nor scheduled`,
      ).toBeDefined();
    },
  );

  it('resolves every column the checklist names on a table that exists', () => {
    const missing: string[] = [];
    for (const { table, columns } of references) {
      const known = tables.get(table);
      if (known === undefined) continue;
      for (const column of columns) {
        if (!known.has(column)) missing.push(`${table}.${column}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('names a milestone for every deferred table, and defers nothing that already exists', () => {
    // The second half is what keeps the allowlist honest: once `M3-T1` adds `chat_bindings`, this
    // fails until the entry is removed, so the list cannot rot into a permanent excuse.
    const premature = Object.keys(SCHEDULED_LATER).filter((table) => tables.has(table));
    expect(premature, 'these tables now exist and should leave SCHEDULED_LATER').toEqual([]);
    for (const [table, owner] of Object.entries(SCHEDULED_LATER)) {
      expect(owner, `${table} needs an owning milestone`).toMatch(/^M\d+/);
    }
  });
});
