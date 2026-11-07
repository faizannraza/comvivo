/**
 * The schema's structure, read back from drizzle in process (`02` §3.3.1–§3.3.3, §3.3.8).
 *
 * `ddl.int.test.ts` is the other half of `M1-T11`'s review: it runs the real `drizzle-kit` and
 * executes the SQL. That evidence is the strongest available, and it has one gap — it comes from a
 * **child process**, so nothing in it exercises this package's own code. Drizzle invokes a table's
 * `(t) => [...]` extra-config callback lazily, which means the index and check declarations of six
 * schema files never run during a test that only shells out.
 *
 * `getTableConfig` invokes those callbacks and hands back the parsed inventory, so this suite
 * asserts the same facts in process, against rendered SQL rather than index names. The two suites
 * are complementary: this one proves the schema *declares* what `02` §3.3 specifies, and the other
 * proves SQLite *accepts* what drizzle generates from it.
 */
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { jsonColumnTag } from './_columns.js';
import * as schema from './index.js';

const dialect = new SQLiteSyncDialect();

/** See `ddl.int.test.ts` for why the values are widened before filtering. */
const exported: unknown[] = Object.values(schema);
const tables = exported.filter((value): value is SQLiteTable => is(value, SQLiteTable));

const render = (value: Parameters<typeof dialect.sqlToQuery>[0]): string =>
  dialect.sqlToQuery(value).sql;

interface Inventory {
  readonly name: string;
  readonly checks: readonly { readonly name: string; readonly sql: string }[];
  readonly indexes: readonly {
    readonly name: string;
    readonly unique: boolean;
    readonly where: string | undefined;
  }[];
}

const inventory = (table: SQLiteTable): Inventory => {
  const config = getTableConfig(table);
  return {
    name: config.name,
    checks: config.checks.map((check) => ({ name: check.name, sql: render(check.value) })),
    indexes: config.indexes.map((index) => ({
      name: index.config.name,
      unique: index.config.unique,
      where: index.config.where === undefined ? undefined : render(index.config.where),
    })),
  };
};

const byName = new Map(tables.map((table) => [getTableName(table), inventory(table)]));

const of = (name: string): Inventory => {
  const found = byName.get(name);
  if (found === undefined) throw new Error(`no table named ${name}`);
  return found;
};

describe('the tables 02 §3.3 specifies', () => {
  it('declares every table of 02 §3.3.1–§3.3.4 and §3.3.8, and nothing else', () => {
    expect([...byName.keys()].sort()).toEqual([
      'app_meta',
      'blobs',
      'channel_identities',
      'conversations',
      'declassifications',
      'deletions',
      'embedding_spaces',
      'extraction_cursors',
      'forget_fingerprints',
      'forget_source_blocks',
      'groups',
      'guardian_relations',
      'instance',
      'labels',
      'members',
      'memory_access_stats',
      'memory_consolidation_state',
      'memory_entities',
      'memory_entity_aliases',
      'memory_events',
      'memory_item_entities',
      'memory_items',
      'memory_ops_applied',
      'memory_sources',
      'memory_subjects',
      'memory_tombstones',
      'message_attachments',
      'message_reactions',
      'messages',
      'persons',
      'reader_set_members',
      'reader_set_seats',
      'reader_sets',
      'settings',
    ]);
  });

  it('includes the columns the M1-T11 acceptance criterion names', () => {
    const columnNames = (table: SQLiteTable) =>
      Object.values(getTableColumns(table)).map((column) => column.name);
    expect(columnNames(schema.members)).toContain('age_band');
    expect(columnNames(schema.members)).toContain('handle');
    expect(columnNames(schema.conversations)).toContain('primary');
    expect(columnNames(schema.labels)).toContain('co_owner_member_ids');
    expect(byName.has('guardian_relations')).toBe(true);
    expect(byName.has('reader_set_seats')).toBe(true);
    expect(byName.has('message_reactions')).toBe(true);
  });
});

describe('every bool column is guarded in process', () => {
  const boolColumns = tables.flatMap((table) =>
    Object.values(getTableColumns(table))
      .filter((column) => column.columnType === 'SQLiteBoolean')
      .map((column) => ({
        table: getTableName(table),
        column: column.name,
        notNull: column.notNull,
        label: `${getTableName(table)}.${column.name}`,
      })),
  );

  it('finds every bool column, and whether it is nullable', () => {
    // Pinned so that a new `bool()` column makes this suite notice, rather than silently adding a
    // case that happens to pass. Sorted, because discovery order follows the barrel's export
    // order — which Biome's `organizeImports` owns, not this schema.
    expect(
      boolColumns.map((entry) => `${entry.label}${entry.notNull ? '' : ' (nullable)'}`).sort(),
    ).toEqual([
      'channel_identities.dm_reachable',
      'channel_identities.is_bot',
      'conversations.primary',
      'labels.untrusted',
      // Three-valued on purpose: `04` §3.2.3's minor hint must distinguish "no" from "unknown".
      'memory_entities.is_minor (nullable)',
      'memory_items.pinned',
      'memory_items.portable',
      'messages.delivered_late',
      'messages.truncated',
      'messages.untrusted',
    ]);
  });

  it.each(boolColumns)('$label is guarded against a value outside 0 and 1', (entry) => {
    const { table, column, notNull } = entry;
    const inZeroOne = `"${table}"."${column}" IN (0, 1)`;
    // A **nullable** bool needs the `IS NULL` arm, or the constraint rejects the third state the
    // column exists to hold — which for `04` §3.2.3's minor hint would force "unknown" to be
    // stored as "no", the one direction that lowers a sensitivity floor.
    const expression = notNull ? inZeroOne : `"${table}"."${column}" IS NULL OR ${inZeroOne}`;
    expect(of(table).checks.map((check) => check.sql)).toContain(expression);
  });
});

describe('the named constraints of 02 §3.3', () => {
  it('encodes the instance singleton as a check, not a convention', () => {
    expect(of('instance').checks).toEqual([
      { name: 'instance_singleton_ck', sql: '"instance"."singleton" = 1' },
    ]);
  });

  it('encodes the child-role biconditional of 02 §3.3.1', () => {
    expect(of('members').checks).toEqual([
      {
        name: 'members_ageband_ck',
        sql: `("members"."role" = 'child') = ("members"."age_band" <> 'adult')`,
      },
    ]);
  });

  it('encodes both conversation rules plus the bool guard', () => {
    expect(of('conversations').checks).toEqual([
      {
        name: 'conversations_dm_ck',
        sql: `("conversations"."kind" = 'dm') = ("conversations"."member_id" IS NOT NULL)`,
      },
      {
        name: 'conversations_primary_ck',
        sql: `"conversations"."primary" = 0 OR "conversations"."kind" = 'group'`,
      },
      { name: 'conversations_primary_bool_ck', sql: '"conversations"."primary" IN (0, 1)' },
    ]);
  });

  it('constrains a group reader set to hold no members, one direction only', () => {
    // A `members` set may name nobody and still hold an outsider seat (`03` §3.4.1, A5), so the
    // converse must not be enforced.
    expect(of('reader_sets').checks.map((check) => check.sql)).toEqual([
      `"reader_sets"."kind" <> 'group' OR "reader_sets"."member_count" = 0`,
      '"reader_sets"."member_count" >= 0',
    ]);
  });

  it('bounds the counters that must never go negative', () => {
    expect(of('groups').checks.map((check) => check.sql)).toEqual([
      '"groups"."week_start" BETWEEN 1 AND 7',
    ]);
    expect(of('blobs').checks.map((check) => check.sql)).toEqual(['"blobs"."size_bytes" >= 0']);
    expect(of('message_attachments').checks.map((check) => check.sql)).toEqual([
      '"message_attachments"."size_bytes" IS NULL OR "message_attachments"."size_bytes" >= 0',
    ]);
  });
});

describe('the index inventory of 02 §3.3.10', () => {
  it('declares the message indexes with their partial predicates', () => {
    expect(of('messages').indexes).toEqual([
      // Q-ING-1 / I6.
      {
        name: 'messages_dedupe_uq',
        unique: true,
        where: '"messages"."dedupe_key" IS NOT NULL',
      },
      // Q-ING-5.
      {
        name: 'messages_conv_platform_uq',
        unique: true,
        where: '"messages"."platform_message_id" IS NOT NULL',
      },
      // Q-CTX-1.
      { name: 'messages_conv_rid_idx', unique: false, where: undefined },
      // Q-CAT-1, Q-PRV-4.
      { name: 'messages_group_sender_idx', unique: false, where: undefined },
      // Q-RET-1.
      {
        name: 'messages_retention_idx',
        unique: false,
        where: '"messages"."retention_until" IS NOT NULL',
      },
      {
        name: 'messages_client_id_uq',
        unique: true,
        where: '"messages"."client_message_id" IS NOT NULL',
      },
    ]);
  });

  it('makes the single primary conversation a partial unique index', () => {
    const primary = of('conversations').indexes.find(
      (index) => index.name === 'conversations_one_primary_uq',
    );
    expect(primary).toEqual({
      name: 'conversations_one_primary_uq',
      unique: true,
      where: '"conversations"."primary" = 1',
    });
  });

  it('orders the reader-set member index by member first, for Q-PRV-2', () => {
    // `(member_id, reader_set_id)` and not the primary key's order: the erasure query asks which
    // sets contain a member, which the other order cannot answer without a scan.
    const config = getTableConfig(schema.readerSetMembers);
    const index = config.indexes.find(
      (candidate) => candidate.config.name === 'reader_set_members_member_idx',
    );
    expect(index?.config.columns.map((column) => ('name' in column ? column.name : '?'))).toEqual([
      'member_id',
      'reader_set_id',
    ]);
  });

  it('includes the group in the conversation platform key, per 01 §14 A27', () => {
    // One platform DM chat maps to one DM conversation *per group*.
    const config = getTableConfig(schema.conversations);
    const index = config.indexes.find(
      (candidate) => candidate.config.name === 'conversations_platform_uq',
    );
    expect(index?.config.columns.map((column) => ('name' in column ? column.name : '?'))).toEqual([
      'channel',
      'platform_chat_id',
      'group_id',
    ]);
  });
});

describe('keys and references', () => {
  it('gives message attachments a composite foreign key into the group’s own blobs', () => {
    // The parent key includes `group_id`, so an attachment can only reference a blob in its own
    // group (I4), and blob reference counting can be trusted.
    const config = getTableConfig(schema.messageAttachments);
    const composite = config.foreignKeys
      .map((key) => key.reference())
      .find((reference) => reference.columns.length === 2);
    expect(composite?.columns.map((column) => column.name)).toEqual(['group_id', 'blob_sha256']);
    expect(composite?.foreignColumns.map((column) => column.name)).toEqual(['group_id', 'sha256']);
    expect(composite?.foreignTable).toBe(schema.blobs);
  });

  it('uses composite primary keys where 02 §3.3 has no surrogate id', () => {
    const pkColumns = (table: SQLiteTable) =>
      getTableConfig(table).primaryKeys.flatMap((key) => key.columns.map((column) => column.name));
    expect(pkColumns(schema.guardianRelations)).toEqual(['ward_member_id', 'guardian_member_id']);
    expect(pkColumns(schema.readerSetMembers)).toEqual(['reader_set_id', 'member_id']);
    expect(pkColumns(schema.readerSetSeats)).toEqual(['reader_set_id', 'conversation_id']);
    expect(pkColumns(schema.messageReactions)).toEqual(['message_rid', 'member_id', 'emoji']);
    expect(pkColumns(schema.blobs)).toEqual(['group_id', 'sha256']);
    expect(pkColumns(schema.settings)).toEqual(['scope', 'key']);
  });

  it('leaves the references that must outlive their target unconstrained', () => {
    // A seat outlives its conversation (`02` §3.3.2) and a tombstone outlives its group
    // (`02` §3.3.8). A foreign key would cascade away the very record that is the evidence.
    //
    // Note what is *not* asserted: `reader_set_seats` does have a foreign key, to its reader set,
    // which is right — the seat is meaningless without the set, and the set is never deleted
    // except with its group. Only the `conversation_id` is unconstrained.
    const seatTargets = getTableConfig(schema.readerSetSeats)
      .foreignKeys.map((key) => key.reference())
      .map((reference) => reference.foreignTable);
    expect(seatTargets).toContain(schema.readerSets);
    expect(seatTargets).not.toContain(schema.conversations);
    expect(getTableConfig(schema.deletions).foreignKeys).toHaveLength(0);
  });

  it('leaves message reactions with no second cascade path from groups', () => {
    // The cascade arrives through `message_rid`; a second path from `groups` would make the purge
    // order of `02` §3.13.4 ambiguous.
    const references = getTableConfig(schema.messageReactions).foreignKeys.map((key) =>
      key.reference(),
    );
    expect(references.map((reference) => reference.foreignTable)).not.toContain(schema.groups);
  });

  it('carries no foreign key on any label reference', () => {
    // Deliberate, and explained in `ifc.ts`: labels are interned and never deleted, the hot
    // ingestion path cannot afford the parent lookup, and the constraint that matters — that a
    // label belongs to the row's group — is a composite one that `02` §3.5's I4 triggers enforce.
    for (const table of [schema.messages, schema.messageAttachments, schema.declassifications]) {
      const references = getTableConfig(table).foreignKeys.map((key) => key.reference());
      expect(references.map((reference) => reference.foreignTable)).not.toContain(schema.labels);
    }
  });
});

describe('every declared foreign key resolves', () => {
  /**
   * Drizzle holds a `.references()` target in a **thunk**, so nothing resolves it until something
   * asks. That laziness is what lets `instance` reference `persons` before `persons` is declared —
   * and it is also why a thunk naming the wrong column is invisible until the first query that
   * crosses it. `reference()` forces every one at once.
   */
  it.each(tables.map((table) => ({ name: getTableName(table), table })))('$name', ({ table }) => {
    const keys = getTableConfig(table).foreignKeys;
    for (const key of keys) {
      const reference = key.reference();
      expect(reference.columns.length).toBeGreaterThan(0);
      // A composite key must name as many parent columns as child columns, or SQLite rejects the
      // DDL — which `ddl.int.test.ts` would catch, but only after a generate.
      expect(reference.foreignColumns).toHaveLength(reference.columns.length);
      expect(byName.has(getTableName(reference.foreignTable))).toBe(true);
    }
  });

  it('resolves the forward reference from instance to persons', () => {
    // The one case that needs an `AnySQLiteColumn` annotation, because `02` §3.3.1 declares
    // `instance` first. If the thunk were eager this would be a TDZ error at import.
    const [key] = getTableConfig(schema.instance).foreignKeys;
    expect(key?.reference().foreignTable).toBe(schema.persons);
    expect(key?.reference().foreignColumns.map((column) => column.name)).toEqual(['id']);
  });

  it('cascades group-scoped content from groups and nothing else', () => {
    // `02` §151: references to *actors* (`person_id`, `*_member_id`) are `NO ACTION`, because
    // members and persons are never hard-deleted outside the purge flows that delete dependents
    // first. Only the `group_id` references cascade, which is what makes I4 a property of the
    // database rather than of a query that might forget a `WHERE`.
    const cascading: string[] = [];
    const noAction: string[] = [];
    for (const table of tables) {
      for (const key of getTableConfig(table).foreignKeys) {
        const reference = key.reference();
        const label = `${getTableName(table)}.${reference.columns.map((c) => c.name).join('+')}`;
        if (key.onDelete === 'cascade') cascading.push(label);
        else if (key.onDelete === undefined) noAction.push(label);
      }
    }
    expect(cascading.sort()).toEqual([
      'blobs.group_id',
      'conversations.group_id',
      'declassifications.group_id',
      'extraction_cursors.conversation_id',
      'guardian_relations.group_id',
      'labels.group_id',
      'members.group_id',
      'memory_access_stats.memory_rid',
      'memory_consolidation_state.group_id',
      'memory_entities.group_id',
      'memory_entity_aliases.entity_id',
      'memory_events.group_id',
      'memory_item_entities.entity_id',
      'memory_item_entities.memory_rid',
      'memory_items.group_id',
      'memory_sources.memory_rid',
      'memory_subjects.memory_rid',
      'message_attachments.group_id',
      'message_attachments.message_id',
      'message_reactions.message_rid',
      'messages.conversation_id',
      'messages.group_id',
      'reader_set_members.reader_set_id',
      'reader_set_seats.reader_set_id',
      'reader_sets.group_id',
    ]);
    // Every actor reference is NO ACTION.
    expect(noAction.filter((label) => label.endsWith('person_id')).sort()).toEqual([
      'channel_identities.person_id',
      'instance.owner_person_id',
      'members.person_id',
    ]);
  });
});

describe('the 02 §3.3.9 JSON column catalog', () => {
  /**
   * Every JSON column, found through the tag `jsonOf` leaves on the built column.
   *
   * `M1-T12`'s acceptance criterion asks for a test that iterates these tags. Finding them through
   * `fieldConfig` rather than a hand-written list is what makes the iteration meaningful: a new
   * `jsonOf` column appears here automatically, so the catalog cannot drift from the schema
   * without this suite saying so — and for a *size cap*, drifting means a column quietly losing
   * its bound.
   */
  const jsonColumns = tables.flatMap((table) =>
    Object.values(getTableColumns(table)).flatMap((column) => {
      const tag = jsonColumnTag(column);
      return tag === undefined ? [] : [{ table: getTableName(table), column: column.name, tag }];
    }),
  );

  it('finds a tag on every JSON column and on no other column', () => {
    expect(jsonColumns.length).toBeGreaterThan(0);
    // The negative half: `tid`, `instantMs`, `tzText` and `plainDate*` are all `customType`s too,
    // so a reader that keyed on `columnType` alone would sweep them up as JSON columns.
    const idColumn = getTableColumns(schema.groups).id;
    expect(jsonColumnTag(idColumn)).toBeUndefined();
    const instantColumn = getTableColumns(schema.groups).createdAt;
    expect(jsonColumnTag(instantColumn)).toBeUndefined();
  });

  it.each(jsonColumns)('$tag names its own column', ({ table, column, tag }) => {
    // The tag is what a `STORAGE_JSON_INVALID` error prints and what `doctor --deep` reports, so a
    // tag that names no column sends a host looking for something that does not exist. `02`
    // §3.3.2 wrote `labels.co_owners` for `co_owner_member_ids`; this assertion is why that was
    // found and corrected rather than shipped.
    expect(tag).toBe(`${table}.${column}`);
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
