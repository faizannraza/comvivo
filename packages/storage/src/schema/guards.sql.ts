/**
 * Structural guards: I4 label triggers, immutability and append-only (`02` §3.2 D5, §3.3).
 *
 * `02` D5 is the decision these implement: a `BEFORE INSERT`/`BEFORE UPDATE` trigger on **every**
 * labeled table aborts when `labels.group_id ≠ row.group_id`, raising `I4_LABEL_GROUP_MISMATCH`.
 * The rejected alternative was "repository checks only", and the reason given is worth repeating:
 * this is *structural* defense in depth, and it costs one primary-key lookup per write.
 *
 * Invariant **I4** is group isolation, and it is the one whose failure is least likely to be
 * noticed. A query that forgets a `WHERE group_id = ?` returns too much and someone sees it; a row
 * written with another group's `label_id` looks correct everywhere until the day that label's
 * audience is resolved and a private datum is shown to strangers. A trigger makes the write
 * impossible, which is the only defense that does not depend on remembering.
 *
 * ## Why the I4 triggers are generated
 *
 * There are 31 labeled columns across 28 tables, and two triggers each. Hand-writing 62 near
 * identical triggers guarantees that one of them is subtly different, and that a table added later
 * has none at all. `labeledColumns()` reads the schema, so a new `labelRef()` column gets its
 * triggers by existing — and `guards.int.test.ts` cross-checks the count against the number of
 * `labelRef(` call sites in the schema sources, which is what catches a label column named
 * outside the convention.
 */
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from './index.js';

/**
 * How a table's own group is reached from a row being written.
 *
 * Most labeled tables carry `group_id`, so the comparison is direct. Three do not, and their group
 * has to be read through the parent that owns them — `02` §3.3 gives them no `group_id` because
 * the parent already scopes them, and skipping them would leave three holes in I4 rather than a
 * complete guard. Each entry names the parent and the column that points at it.
 */
const GROUP_VIA_PARENT: Readonly<
  Record<string, { table: string; via: string; parentKey: string }>
> = {
  event_attendees: { table: 'events', via: 'event_id', parentKey: 'id' },
  poll_votes: { table: 'polls', via: 'poll_id', parentKey: 'id' },
  proposal_votes: { table: 'proposals', via: 'proposal_id', parentKey: 'id' },
};

/** A column holding an interned `label_id`, found by `02`'s naming convention. */
export interface LabeledColumn {
  readonly table: string;
  readonly column: string;
}

/**
 * Every labeled column in the schema.
 *
 * Detected by name — `label_id` or `*_label_id` — because `labelRef()` produces a plain
 * `integer()` column and drizzle keeps no marker on it. The convention is uniform across `02`
 * §3.3, and `guards.int.test.ts` asserts the detected count equals the number of `labelRef(` call
 * sites, so a column named outside the convention fails rather than silently losing its guard.
 */
export function labeledColumns(): readonly LabeledColumn[] {
  const found: LabeledColumn[] = [];
  for (const value of Object.values(schema) as unknown[]) {
    if (!is(value, SQLiteTable)) continue;
    const table = getTableName(value);
    for (const column of Object.values(getTableColumns(value))) {
      if (column.name === 'label_id' || column.name.endsWith('_label_id')) {
        found.push({ table, column: column.name });
      }
    }
  }
  return found.sort(
    (left, right) =>
      left.table.localeCompare(right.table) || left.column.localeCompare(right.column),
  );
}

/** The SQL expression giving a row's own group, for a table that may not carry `group_id`. */
function ownGroupSql(table: string): string {
  const parent = GROUP_VIA_PARENT[table];
  if (parent === undefined) return 'NEW.group_id';
  return `(SELECT group_id FROM ${parent.table} WHERE ${parent.parentKey} = NEW.${parent.via})`;
}

/**
 * The two I4 triggers for one labeled column.
 *
 * `IS NOT` rather than `<>` is load-bearing: `<>` yields `NULL` when either side is `NULL`, and a
 * `WHEN` clause that evaluates to `NULL` does **not** fire. So a row whose `group_id` is `NULL`
 * paired with a label belonging to a real group would slip through a `<>` comparison. `IS NOT` is
 * the null-safe form and treats that as the mismatch it is.
 *
 * The `BEFORE UPDATE` trigger watches the label column and `group_id` together, because either
 * one moving can break the pairing.
 */
export function i4Triggers(entry: LabeledColumn): readonly string[] {
  const suffix = entry.column === 'label_id' ? '' : `_${entry.column.replace(/_label_id$/, '')}`;
  const name = `trg_${entry.table}${suffix}_label_group`;
  const condition = `NEW.${entry.column} IS NOT NULL
 AND (SELECT group_id FROM labels WHERE id = NEW.${entry.column}) IS NOT ${ownGroupSql(entry.table)}`;
  const watched =
    GROUP_VIA_PARENT[entry.table] === undefined
      ? `${entry.column}, group_id`
      : `${entry.column}, ${GROUP_VIA_PARENT[entry.table]?.via ?? ''}`;
  return [
    `CREATE TRIGGER ${name}_ins BEFORE INSERT ON ${entry.table}
WHEN ${condition}
BEGIN SELECT RAISE(ABORT, 'I4_LABEL_GROUP_MISMATCH'); END`,
    `CREATE TRIGGER ${name}_upd BEFORE UPDATE OF ${watched} ON ${entry.table}
WHEN ${condition}
BEGIN SELECT RAISE(ABORT, 'I4_LABEL_GROUP_MISMATCH'); END`,
  ];
}

/** Every I4 trigger, in table order. */
export function allI4Triggers(): readonly string[] {
  return labeledColumns().flatMap((entry) => i4Triggers(entry));
}

/**
 * A table (or set of columns) that may never be updated, and the code a write raises.
 *
 * Each of these has a reason that is not "tidiness":
 *
 *  - **`memory_items`** content (`01` §5, `02` §563) — a memory is never hard-updated in place. A
 *    correction creates a new row and supersedes the old, which is what makes "what did we think
 *    before?" answerable and what lets the FTS update trigger watch only `status`.
 *  - **`constitution_versions`** (`02` §1043) — every `audit_events` row and every
 *    `turn_traces.replay` records the `constitution_version_id` it acted under. Editing a version
 *    in place rewrites the rules past decisions were made by, so the audit log would describe a
 *    world that never existed.
 *  - **`audit_events`** (`02` §3.3.7) — the chain is `hash = sha256(prevHash ‖ JCS(event))`.
 *    `verifyChain` detects a tampered row, and this trigger stops the write that would need
 *    detecting.
 *  - **`labels`** (`02` §204) — label rows are immutable; relabeling points a datum at a *different*
 *    `label_id`. Mutating a label would silently change the audience of every row already carrying
 *    it, which is **I1** failing retroactively and invisibly.
 *  - **`reader_sets`** (`02` §3.2) — interned and append-only for the same reason one step down: a
 *    mutated reader set changes what every label built on it means.
 *
 * `labels` and `reader_sets` are not named as triggers by `02`, which states their immutability as
 * prose. They are included because the prose is load-bearing for I1 and because neither table has
 * an `updated_at` column — nothing in the schema expects them to change. Recorded in
 * `STATUS.md` → Plan changes.
 */
export interface ImmutableGuard {
  readonly table: string;
  /** `undefined` means the whole row: any `UPDATE` is refused. */
  readonly columns?: readonly string[];
  readonly code: string;
  readonly triggerName: string;
}

export const IMMUTABLE_GUARDS: readonly ImmutableGuard[] = [
  {
    table: 'memory_items',
    columns: ['content', 'statement', 'search_terms', 'kind', 'group_id', 'provenance'],
    code: 'MEMORY_CONTENT_IMMUTABLE',
    triggerName: 'trg_memory_items_immutable',
  },
  {
    table: 'constitution_versions',
    code: 'CONSTITUTION_VERSION_IMMUTABLE',
    triggerName: 'trg_constitution_versions_immutable',
  },
  {
    table: 'audit_events',
    code: 'AUDIT_APPEND_ONLY',
    triggerName: 'trg_audit_events_append_only',
  },
  { table: 'labels', code: 'LABEL_IMMUTABLE', triggerName: 'trg_labels_immutable' },
  {
    table: 'reader_sets',
    code: 'READER_SET_IMMUTABLE',
    triggerName: 'trg_reader_sets_immutable',
  },
];

/** The `BEFORE UPDATE` trigger for one immutability guard. */
export function immutabilityTrigger(guard: ImmutableGuard): string {
  const target =
    guard.columns === undefined
      ? `ON ${guard.table}`
      : `OF ${guard.columns.join(', ')} ON ${guard.table}`;
  return `CREATE TRIGGER ${guard.triggerName} BEFORE UPDATE ${target}
BEGIN SELECT RAISE(ABORT, '${guard.code}'); END`;
}

/** Every immutability trigger. */
export function allImmutabilityTriggers(): readonly string[] {
  return IMMUTABLE_GUARDS.map((guard) => immutabilityTrigger(guard));
}

/** The tables this module generates guards for, so a test can assert the inventory. */
export function guardedTables(): readonly string[] {
  return [
    ...new Set([
      ...labeledColumns().map((entry) => entry.table),
      ...IMMUTABLE_GUARDS.map((guard) => guard.table),
    ]),
  ].sort();
}

/** Assert every `GROUP_VIA_PARENT` entry still names a real table and columns. */
export function parentLookups(): readonly { table: string; parent: string; via: string }[] {
  return Object.entries(GROUP_VIA_PARENT).map(([table, parent]) => ({
    table,
    parent: parent.table,
    via: parent.via,
  }));
}

/**
 * Every table in the schema, by name.
 *
 * Its docstring said "used by the guard tests to validate the lookups" and **no test used it** —
 * which is the kind of claim that stops a reviewer looking. Found by the M1 independent review.
 * Kept rather than deleted, because `parentLookups()` names three tables and their parents as
 * string literals, and a typo in one of those is a silently missing I4 guard; `guards.int.test.ts`
 * now checks every name against this list, which is the use the docstring always claimed.
 */
export function schemaTableNames(): readonly string[] {
  return (Object.values(schema) as unknown[])
    .filter((value): value is SQLiteTable => is(value, SQLiteTable))
    .map((table) => getTableName(table))
    .sort();
}

/** Column names of one table, or `undefined` when the table does not exist. */
export function schemaColumns(table: string): readonly string[] | undefined {
  for (const value of Object.values(schema) as unknown[]) {
    if (!is(value, SQLiteTable)) continue;
    if (getTableName(value) !== table) continue;
    return getTableConfig(value).columns.map((column) => column.name);
  }
  return undefined;
}
