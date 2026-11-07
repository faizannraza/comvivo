/**
 * Lists and their items (`02` §3.3.5; `07` §3.4).
 *
 * Two things here are worth more than they look.
 *
 * **`lists_group_name_uq` is an expression index** — unique on `(group_id, lower(name))` where the
 * list is not archived. Case-insensitive, because "Groceries" and "groceries" are one list to
 * everybody in the group and two rows would silently split a shopping trip. Partial on
 * `archived_at IS NULL`, so archiving a list frees its name for reuse rather than reserving it
 * forever. This is the only expression index in the schema at `M1-T12`, and `02` §3.12's
 * acceptance criterion names expression indexes specifically because `drizzle-kit` has to emit
 * `lower("name")` into the DDL rather than treating it as a column.
 *
 * **`position` is a fractional index**, a base-62 string rather than an integer. Inserting between
 * two items picks a string between theirs, so a reorder writes **one** row — with integers it
 * would renumber everything after the insertion point, which on a shared list means a write storm
 * every time two people reorder at once.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  bool,
  boolCheckSql,
  createdAt,
  instantMs,
  labelRef,
  tid,
  updatedAt,
  version,
} from './_columns.js';
import { groups, members } from './groups.js';

export const lists = sqliteTable(
  'lists',
  {
    id: tid('lst')('id').primaryKey(),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['grocery', 'packing', 'to_buy', 'generic'] })
      .notNull()
      .default('generic'),
    /** The list "add milk" lands on when nobody said which list. One per kind, per group. */
    isDefault: bool('is_default').notNull().default(false),
    categoriesEnabled: bool('categories_enabled').notNull().default(true),
    planId: tid('pln')('plan_id'),
    labelId: labelRef().notNull(),
    createdByMemberId: tid('mbr')('created_by_member_id').references(() => members.id),
    archivedAt: instantMs('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    // The expression index: case-insensitive names, and only among live lists.
    uniqueIndex('lists_group_name_uq')
      .on(t.groupId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} IS NULL`),
    uniqueIndex('lists_default_kind_uq')
      .on(t.groupId, t.kind)
      .where(sql`${t.isDefault} = 1 AND ${t.archivedAt} IS NULL`),
    check('lists_is_default_bool_ck', boolCheckSql(t.isDefault)),
    check('lists_categories_enabled_bool_ck', boolCheckSql(t.categoriesEnabled)),
  ],
);

export const listItems = sqliteTable(
  'list_items',
  {
    rid: integer('rid').primaryKey({ autoIncrement: true }),
    id: tid('lsti')('id').notNull().unique(),
    listId: tid('lst')('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** Normalised for dedupe: "2 pints of milk" and "milk" collide on `list_items_key_idx`. */
    normalizedKey: text('normalized_key').notNull(),
    quantity: text('quantity'),
    category: text('category'),
    note: text('note'),
    checked: bool('checked').notNull().default(false),
    checkedByMemberId: tid('mbr')('checked_by_member_id').references(() => members.id),
    checkedAt: instantMs('checked_at'),
    addedByMemberId: tid('mbr')('added_by_member_id').references(() => members.id),
    /** `auto_capture` marks an item the agent inferred, so it can be shown as a suggestion. */
    addedVia: text('added_via', { enum: ['explicit', 'auto_capture', 'button'] })
      .notNull()
      .default('explicit'),
    sourceMessageId: tid('msg')('source_message_id'),
    /** A fractional index (base-62), so an insert or reorder writes one row. */
    position: text('position').notNull(),
    labelId: labelRef().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: version(),
  },
  (t) => [
    // Q-COO-3: the list as displayed — unchecked first, then by position.
    index('list_items_list_idx').on(t.listId, t.checked, t.position),
    index('list_items_key_idx').on(t.listId, t.normalizedKey),
    check('list_items_checked_bool_ck', boolCheckSql(t.checked)),
  ],
);

/**
 * A group's own answer to "which aisle is this in" (`07`).
 *
 * Per group, because categorisation is local knowledge: tofu is produce in one household and
 * protein in another, and a shared default that keeps being corrected is worse than one that
 * learns. Keyed by `(group, list kind, normalized key)` so the override applies to the item
 * wherever it is re-added.
 */
export const listCategoryOverrides = sqliteTable(
  'list_category_overrides',
  {
    groupId: tid('grp')('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    listKind: text('list_kind').notNull(),
    normalizedKey: text('normalized_key').notNull(),
    category: text('category').notNull(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.listKind, t.normalizedKey] })],
);
