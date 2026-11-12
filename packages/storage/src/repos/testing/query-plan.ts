/**
 * `EXPLAIN QUERY PLAN` assertions (`M1-T19` AC: "no `SCAN` of large tables").
 *
 * ## Why a plan assertion and not a benchmark
 *
 * `02` §3.3.10 justifies every index by naming the query that uses it, and the failure this guards
 * against is silent: a query that stops using its index still returns the right rows, just slowly
 * — and on a developer's 20-row fixture it is *faster* than the indexed plan, because SQLite's
 * planner correctly prefers a scan of a tiny table. So a timing test on a small database proves
 * nothing, and a timing test on a large one is `M1-T33`'s Pi run.
 *
 * The plan is the thing that can be checked cheaply and exactly: `SEARCH … USING INDEX x` means
 * the index was used, and `SCAN` means the whole table was read.
 *
 * ## The fixture has to be big enough to fool nobody
 *
 * SQLite's planner chooses a scan over an index when the table is small enough that the index is
 * not worth it, and it is **right** to. So these assertions run against a table with enough rows
 * that the planner prefers the index — otherwise the test would fail on correct code, get an
 * exception added, and stop checking anything. `ANALYZE` is run first for the same reason: without
 * statistics the planner guesses, and the guess is what a developer's machine happens to produce
 * rather than what a host's database will.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import { expect } from 'vitest';

/** One row of `EXPLAIN QUERY PLAN`. */
export interface PlanRow {
  readonly id: number;
  readonly parent: number;
  readonly detail: string;
}

/** The plan for a statement, as SQLite describes it. */
export function queryPlan(
  db: Database.Database,
  sql: string,
  parameters: readonly unknown[] = [],
): readonly PlanRow[] {
  return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as PlanRow[];
}

/** The plan as one string, for a failure message that shows the whole thing. */
export function planText(rows: readonly PlanRow[]): string {
  return rows.map((row) => row.detail).join('\n');
}

/**
 * Assert that a statement reaches `table` through `index` and never scans it.
 *
 * Both halves are needed. `SEARCH … USING INDEX` alone can appear beside a `SCAN` of the same
 * table in a compound query, and a `SCAN` alone can be harmless on a tiny lookup table — so the
 * assertion is about **this** table: it must be searched by **this** index, and not scanned.
 */
export function expectIndexUsed(
  db: Database.Database,
  sql: string,
  expectation: {
    readonly table: string;
    readonly index: string;
    readonly parameters?: readonly unknown[];
  },
): void {
  const rows = queryPlan(db, sql, expectation.parameters ?? []);
  const text = planText(rows);
  expect(text, `expected ${expectation.table} to use ${expectation.index}:\n${text}`).toContain(
    `USING INDEX ${expectation.index}`,
  );
  // `SCAN <table>` with nothing after it is a full scan; `SCAN <table> USING INDEX …` is a covering
  // index walk, which is not what the AC rules out. Matching the bare form is the distinction.
  const fullScan = new RegExp(`SCAN ${expectation.table}(?! USING)`);
  expect(fullScan.test(text), `expected no full scan of ${expectation.table}:\n${text}`).toBe(
    false,
  );
}

/**
 * Assert that a statement never fully scans any of `tables`.
 *
 * For a query that legitimately has several plans depending on its parameters — an `IN` list whose
 * length changes the shape — where the invariant is "nothing is scanned" rather than "this index
 * is used".
 */
export function expectNoFullScan(
  db: Database.Database,
  sql: string,
  tables: readonly string[],
  parameters: readonly unknown[] = [],
): void {
  const text = planText(queryPlan(db, sql, parameters));
  for (const table of tables) {
    const fullScan = new RegExp(`SCAN ${table}(?! USING)`);
    expect(fullScan.test(text), `expected no full scan of ${table}:\n${text}`).toBe(false);
  }
}

/**
 * Assert that a statement sorts with a temporary B-tree, or does not.
 *
 * `02` §3.7.3 makes a claim worth testing — Q-CTX-1 "has no `sent_at` sort, so no temp B-tree is
 * needed" — and a temp B-tree is how an `ORDER BY` that cannot use an index shows up in a plan. On
 * a context build that runs on every turn, the difference is a sort of the whole result set.
 */
export function expectNoTempBTree(
  db: Database.Database,
  sql: string,
  parameters: readonly unknown[] = [],
): void {
  const text = planText(queryPlan(db, sql, parameters));
  expect(text, `expected no temporary B-tree sort:\n${text}`).not.toContain('USE TEMP B-TREE');
}

/**
 * Run `ANALYZE`, so the planner decides with statistics rather than with a guess.
 *
 * Without it SQLite assumes every index is roughly equally selective, and the plan a test sees is
 * whatever that assumption produces — which is not the plan a host's database produces after its
 * first `PRAGMA optimize`. `02` §3.12's migration runner ends with `PRAGMA optimize`, so a real
 * instance always has statistics; a test without them is testing a state production never reaches.
 */
export function analyze(db: Database.Database): void {
  db.exec('ANALYZE');
}
