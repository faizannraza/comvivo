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

/**
 * Tables whose `group_id` may never change, with the trigger that enforces it.
 *
 * ## The hole this closes
 *
 * `event_attendees.note_label_id`, `poll_votes.label_id` and `proposal_votes.label_id` reach their
 * group through a parent (`GROUP_VIA_PARENT`), so their I4 triggers watch the label column and the
 * parent key — not `group_id`, which those tables do not have. The parent's own trigger blocks a
 * bare `group_id` move, because the move would leave its label pointing at the old group. But
 * moving a parent **and** relabeling it in one statement satisfies that trigger:
 *
 * ```sql
 * UPDATE events SET group_id = 'grp_b', label_id = <a label in grp_b> WHERE id = ?;
 * ```
 *
 * Every attendee row of that event now carries a `note_label_id` belonging to `grp_a` while its
 * parent is in `grp_b`, and **no trigger fires** — a datum readable in the wrong group's context,
 * which is I4 failing. `guards.sql.ts` claimed a "complete guard". Found by the M1 independent
 * review.
 *
 * ## Why immutability rather than another trigger per child
 *
 * A per-child trigger would have to re-check every child on every parent update, which is a scan
 * per write for a case that should not exist. **Nothing in this product moves a row between
 * groups**: `02` D14 is explicit that there is no cross-group sharing, a purge deletes a group's
 * rows rather than reassigning them, and `01` §294's I4 reads "no datum with `groupId = g1` is ever
 * readable in a context for `g2`". A row belongs to one group for its lifetime, so saying that in
 * the schema is both cheaper and more honest than policing the consequences of it changing.
 *
 * `BEFORE UPDATE OF group_id` with `WHEN NEW.group_id IS NOT OLD.group_id`, so an ordinary update
 * that happens to list `group_id` in its `SET` without changing the value is untouched.
 */
export function groupImmutableTrigger(table: string): string {
  return `CREATE TRIGGER trg_${table}_group_immutable BEFORE UPDATE OF group_id ON ${table}
WHEN NEW.group_id IS NOT OLD.group_id
BEGIN SELECT RAISE(ABORT, 'I4_GROUP_IMMUTABLE'); END`;
}

/**
 * Every table carrying a `group_id` that a labeled row's group is derived from.
 *
 * The labeled tables themselves plus the three parents in `GROUP_VIA_PARENT`. A table with no
 * labeled row depending on it is left alone: this guard exists to protect the label-to-group
 * relationship, not to make the whole schema immutable.
 */
export function groupImmutableTables(): readonly string[] {
  const parents = Object.values(GROUP_VIA_PARENT).map((parent) => parent.table);
  const labeled = labeledColumns()
    .map((entry) => entry.table)
    .filter((table) => GROUP_VIA_PARENT[table] === undefined);
  return [...new Set([...labeled, ...parents])]
    .filter((table) => schemaColumns(table)?.includes('group_id') === true)
    .sort();
}

/** Every `group_id` immutability trigger, in table order. */
export function allGroupImmutableTriggers(): readonly string[] {
  return groupImmutableTables().map((table) => groupImmutableTrigger(table));
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

/* ─────────────────────────── Parent-group agreement (I4) ─────────────────────────── */

/**
 * A foreign key whose two sides must belong to the same group.
 *
 * ## The hole these close
 *
 * The I4 label triggers above compare a row's **label** against a group. They say nothing about
 * the row's other foreign keys, and the M1 exit gate's reviewer proved the consequence against the
 * committed migrations with `foreign_keys = ON`: twenty-two writes that attach a row in one group
 * to a parent in another, each refused by nothing. A message in `grp_A` pointing at a conversation
 * in `grp_B`; a turn in `grp_A` whose requester is a member of `grp_B`; a label in `grp_A` whose
 * reader set belongs to `grp_B`; an outbox row claiming no group at all while pointing into one.
 * A plain foreign key checks *existence*, not *agreement* — and agreement is what `I4` is.
 *
 * `02` §3.3 already had one relation doing it properly: `message_attachments` has a composite key
 * on `(group_id, blob_sha256)`, which the reviewer confirmed refuses the cross-group case outright.
 * Composite keys everywhere would be the better fix and belong to the next schema revision; this
 * is the same rule as a trigger, generated from the schema so a table added later gets it by
 * existing rather than by someone remembering.
 *
 * ## The two shapes
 *
 * **`direct`** — the child carries `group_id` and so does the parent: the parent's group must be
 * the child's. This is also what makes a denormalised `group_id` honest. Before it, eleven tables
 * carried a `group_id` with no foreign key to `groups` and a derivable true group, so the I4 label
 * trigger compared a label against a group **the row itself supplied** — `turn_traces` could claim
 * another group while pointing at its own group's turn, and the trace the dashboard renders would
 * appear in the wrong group's view. I4 failing through the trigger meant to prevent it.
 *
 * **`sibling`** — the child has no `group_id`, so its group is its owner's: every other
 * group-scoped parent must agree with the owner. `event_attendees` is the shape — an attendee row
 * joins an event to a member, and the member must be in the event's group.
 */
export interface GroupAgreement {
  readonly table: string;
  readonly kind: 'direct' | 'sibling';
  /** The column on the child pointing at the parent. */
  readonly via: string;
  readonly parent: string;
  readonly parentKey: string;
  /** For `sibling`: the owning parent whose group the others must match. */
  readonly owner?: { readonly via: string; readonly table: string; readonly parentKey: string };
}

/** One single-column foreign key of a child table, and whether its parent carries a group. */
interface ParentRef {
  readonly via: string;
  readonly parent: string;
  readonly parentKey: string;
  readonly parentHasGroup: boolean;
}

/** Does this table carry a `group_id` column? */
function hasGroupColumn(table: SQLiteTable): boolean {
  return Object.values(getTableColumns(table)).some((column) => column.name === 'group_id');
}

/**
 * The owning parent of a child with no `group_id`.
 *
 * `GROUP_VIA_PARENT` first, because those three are already stated there with their reasons. Then
 * the convention `02` §3.3 follows everywhere: the row belongs to the aggregate named by its
 * **first** declared foreign key, which is also the one its primary key is built from. Returning
 * `undefined` means "no owner we can prove", and such a table gets no sibling guard rather than a
 * guessed one.
 */
function owningParent(
  table: SQLiteTable,
  parents: readonly ParentRef[],
): { via: string; table: string; parentKey: string } | undefined {
  const named = GROUP_VIA_PARENT[getTableName(table)];
  if (named !== undefined) {
    return { via: named.via, table: named.table, parentKey: named.parentKey };
  }
  const first = parents.find((parent) => parent.parentHasGroup);
  return first === undefined
    ? undefined
    : { via: first.via, table: first.parent, parentKey: first.parentKey };
}

/** Every table in the schema, by its SQL name. */
function tablesByName(): ReadonlyMap<string, SQLiteTable> {
  const byName = new Map<string, SQLiteTable>();
  for (const value of Object.values(schema) as unknown[]) {
    if (is(value, SQLiteTable)) byName.set(getTableName(value), value);
  }
  return byName;
}

/** One table's single-column foreign keys, with whether each parent carries a group. */
function singleColumnParents(table: SQLiteTable): readonly ParentRef[] {
  const parents: ParentRef[] = [];
  for (const key of getTableConfig(table).foreignKeys) {
    const reference = key.reference();
    // A composite key that already includes `group_id` is the agreement, stated in the schema.
    if (reference.columns.some((column) => column.name === 'group_id')) continue;
    if (reference.columns.length !== 1) continue;
    const via = reference.columns[0]?.name;
    const parentKey = reference.foreignColumns[0]?.name;
    if (via === undefined || parentKey === undefined) continue;
    const parentTable = reference.foreignTable;
    parents.push({
      via,
      parent: getTableName(parentTable),
      parentKey,
      parentHasGroup: hasGroupColumn(parentTable),
    });
  }
  return parents;
}

/**
 * The agreements one table contributes.
 *
 * Two shapes, and the split is the point. A table with its own `group_id` must agree with every
 * grouped parent it points at (`direct`). A table without one inherits a group through its
 * **owning** parent, so the agreement to check is between that inherited group and every *other*
 * grouped parent (`sibling`) — the owner itself cannot disagree with the group it defines.
 */
function agreementsFor(name: string, table: SQLiteTable): readonly GroupAgreement[] {
  const parents = singleColumnParents(table);
  const grouped = parents.filter((parent) => parent.parentHasGroup);

  if (hasGroupColumn(table)) {
    return grouped.map((parent) => ({
      table: name,
      kind: 'direct' as const,
      via: parent.via,
      parent: parent.parent,
      parentKey: parent.parentKey,
    }));
  }

  const owner = owningParent(table, parents);
  if (owner === undefined) return [];
  return grouped
    .filter((parent) => parent.via !== owner.via)
    .map((parent) => ({
      table: name,
      kind: 'sibling' as const,
      via: parent.via,
      parent: parent.parent,
      parentKey: parent.parentKey,
      owner,
    }));
}

/** Every foreign key in the schema whose two sides must agree on a group. */
export function groupAgreements(): readonly GroupAgreement[] {
  const found: GroupAgreement[] = [];
  for (const [name, table] of tablesByName()) found.push(...agreementsFor(name, table));
  return found.sort(
    (left, right) => left.table.localeCompare(right.table) || left.via.localeCompare(right.via),
  );
}

/**
 * The two triggers for one agreement.
 *
 * `IS NOT` for the same reason the label triggers use it: `<>` yields `NULL` when either side is,
 * and a `WHEN` clause evaluating to `NULL` does not fire — so a row with `group_id IS NULL`
 * pointing into a real group would slip through. That exact case was one of the proven writes
 * (`outbox_messages`, whose `group_id` is nullable).
 */
export function groupAgreementTriggers(entry: GroupAgreement): readonly string[] {
  const own =
    entry.kind === 'direct'
      ? 'NEW.group_id'
      : `(SELECT group_id FROM ${entry.owner?.table ?? ''} WHERE ${entry.owner?.parentKey ?? 'id'} = NEW.${entry.owner?.via ?? ''})`;
  const condition = `NEW.${entry.via} IS NOT NULL
 AND (SELECT group_id FROM ${entry.parent} WHERE ${entry.parentKey} = NEW.${entry.via}) IS NOT ${own}`;
  const name = `trg_${entry.table}_${entry.via.replace(/_id$/, '')}_group`;
  const watched =
    entry.kind === 'direct' ? `${entry.via}, group_id` : `${entry.via}, ${entry.owner?.via ?? ''}`;
  return [
    `CREATE TRIGGER ${name}_ins BEFORE INSERT ON ${entry.table}
WHEN ${condition}
BEGIN SELECT RAISE(ABORT, 'I4_PARENT_GROUP_MISMATCH'); END`,
    `CREATE TRIGGER ${name}_upd BEFORE UPDATE OF ${watched} ON ${entry.table}
WHEN ${condition}
BEGIN SELECT RAISE(ABORT, 'I4_PARENT_GROUP_MISMATCH'); END`,
  ];
}

/** Every parent-group agreement trigger, in a stable order. */
export function allGroupAgreementTriggers(): readonly string[] {
  return groupAgreements().flatMap((entry) => groupAgreementTriggers(entry));
}
