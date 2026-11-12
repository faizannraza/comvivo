/**
 * `02` §3.3.13's entity → table checklist (`M1-T12`, moved here at `M1-T35`).
 *
 * The acceptance criterion is that the checklist "passes for every entity scheduled ≤ M1". A test
 * that restated the checklist would only prove this file agrees with itself, so `checklist.ts`
 * parses §3.3.13 out of `docs/plan/02-domain-model-and-storage.md` and compares it with the real
 * schema. A row added to the spec therefore shows up here on the next run.
 *
 * It lives beside the script rather than in `packages/storage`, because §3.3.13 assigns the check
 * to `scripts/schema-doc.ts` and a package may not import from `scripts/`
 * (`storage-only-core-shared`). The script runs the same audit in `pnpm verify`; this suite is
 * what makes the *parser* trustworthy — a regex that silently matched nothing would make every
 * assertion in both vacuously true.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from '../../packages/storage/src/schema/index.js';
import { auditChecklist, NO_TABLE, parseChecklist, SCHEDULED_LATER } from './checklist.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SPEC = resolve(REPO_ROOT, 'docs/plan/02-domain-model-and-storage.md');

/** Every table in the schema, by name, with its column names. */
const tables = new Map<string, ReadonlySet<string>>(
  (Object.values(schema) as unknown[])
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .map((table) => [
      getTableName(table),
      new Set(Object.values(getTableColumns(table)).map((column) => column.name)),
    ]),
);

const references = parseChecklist(readFileSync(SPEC, 'utf8'));

describe('02 §3.3.13 entity → table checklist', () => {
  it('parses a meaningful number of references out of the spec', () => {
    // The guard against a parser that silently matches nothing: a regex change that broke the
    // extraction would otherwise make every assertion below — and the script's audit — vacuously
    // true.
    expect(references.length).toBeGreaterThan(40);
    expect(references.map((reference) => reference.table)).toContain('constraint_records');
    expect(
      references.some(
        (reference) => reference.table === 'members' && reference.columns.includes('age_band'),
      ),
    ).toBe(true);
  });

  it('decodes all three spellings the section uses', () => {
    // `table`, `table.column` and `table.{a, b}` — a decision table, and the braced form is the
    // one a simpler regex would drop silently.
    const braced = parseChecklist(
      [
        '#### 3.3.13 Entity \u2192 table checklist',
        '| Entity | Table(s) |',
        '|---|---|',
        '| Something (02) | `outbox_messages.{guard_ref, seq}`, `turns`, `members.handle` |',
        '### 3.4 Full-text search',
      ].join(String.fromCharCode(10)),
    );
    expect(braced).toEqual([
      { table: 'outbox_messages', columns: ['guard_ref', 'seq'] },
      { table: 'turns', columns: [] },
      { table: 'members', columns: ['handle'] },
    ]);
  });

  it('finds no problem in the real schema', () => {
    // The whole audit in one assertion, with every problem in the failure message: a missing
    // table, a missing column, a deferral for a table that now exists, or a deferral with no
    // milestone. This is what `pnpm run schema:check` runs in CI.
    expect(auditChecklist(references, tables).map((problem) => problem.message)).toEqual([]);
  });

  it('keeps the deferral list honest in both directions', () => {
    // Non-vacuity for the audit above: a table that exists must not be excused, and the check
    // that enforces that has to be shown to fire.
    const pretend = new Map(tables).set('plugin_installations', new Set(['id']));
    expect(auditChecklist(references, pretend).map((problem) => problem.kind)).toContain(
      'premature-deferral',
    );
    // And a checklist entry nobody has scheduled is a failure, not a silent pass.
    const unscheduled = [...references, { table: 'invented_table', columns: [] }];
    expect(auditChecklist(unscheduled, tables).map((problem) => problem.kind)).toContain(
      'missing-table',
    );
  });

  it('names a milestone for every deferred table, and a reason for every entity with none', () => {
    for (const [table, owner] of Object.entries(SCHEDULED_LATER)) {
      expect(owner, `${table} needs an owning milestone`).toMatch(/^M\d+/);
    }
    // A "no table" row is a decision, so it carries the section that records it — the difference
    // between "nobody built it" and "we decided against it".
    for (const [entity, reason] of Object.entries(NO_TABLE)) {
      expect(reason, `${entity} needs the decision's source`).toMatch(/§/);
    }
  });
});
