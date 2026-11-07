/**
 * FTS5 tables and their sync triggers, as raw SQL (`02` §3.4).
 *
 * Drizzle cannot express a virtual table or a trigger, so these are SQL strings rather than schema
 * objects. `02` §3.4 puts them here so that one declaration serves three consumers: the custom
 * migration (`scripts/gen-guard-triggers.ts` writes it), the schema-equivalence test (`M1-T14`),
 * and `createTestDb` (`M1-T15`).
 *
 * ## Why the triggers are the authoritative sync path
 *
 * `02` §3.4 calls them that, and the alternative is worse in a specific way. If a repository were
 * responsible for keeping the index in step, then every write path — ingestion, a redaction, an
 * erasure sweep, a data migration, a `doctor` repair — would have to remember, and the one that
 * forgot would leave the index claiming a message exists that has been deleted. A trigger cannot
 * be forgotten, and `search.verify` (nightly, sampled) exists to catch the case where one is
 * missing entirely.
 *
 * ## `contentless_delete=1` plus `secure-delete`
 *
 * The tables are contentless: they store the index, not the text, because the text already lives
 * in `messages` and `memory_items` under a label. `contentless_delete=1` is what makes `DELETE`
 * possible at all on a contentless table (SQLite ≥ 3.43), and `secure-delete` goes further —
 * without it FTS5 marks tokens deleted and only removes them at the next merge, so a redacted
 * message's words stay recoverable from the index file until then. `00`'s "delete anything"
 * promise is about the bytes, and this is the setting that keeps it true for the search index.
 */

/** The `scope` token for a group: `'g'` plus the TypeID suffix, e.g. `g01jd8…`. */
export const SCOPE_TOKEN_SQL = (groupIdExpression: string): string =>
  `'g' || substr(${groupIdExpression}, 5)`;

/**
 * `02` §3.4's four FTS5 tables.
 *
 * `memory_fts_tri` deliberately has **no** `scope` column: trigram-tokenising a scope token would
 * index three-character slices of a group id, which is wasteful and useless, so group filtering
 * there is a join on `memory_items.group_id` instead.
 */
export const FTS_TABLES = ['messages_fts', 'memory_fts', 'memory_fts_tri', 'entity_fts'] as const;

export type FtsTable = (typeof FTS_TABLES)[number];

export const CREATE_FTS_TABLES: readonly string[] = [
  `CREATE VIRTUAL TABLE messages_fts USING fts5(body, scope, content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2", detail=full)`,
  `CREATE VIRTUAL TABLE memory_fts USING fts5(statement, terms, scope, content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2", detail=full)`,
  `CREATE VIRTUAL TABLE memory_fts_tri USING fts5(body, content='', contentless_delete=1,
  tokenize="trigram remove_diacritics 1", detail=full)`,
  `CREATE VIRTUAL TABLE entity_fts USING fts5(body, scope, content='', contentless_delete=1,
  tokenize="unicode61 remove_diacritics 2", detail=full)`,
];

/**
 * Turn on real token deletion for every FTS table.
 *
 * A separate statement per table because `secure-delete` is a per-table setting written through
 * the table's own config interface, not a pragma.
 */
export const SECURE_DELETE_STATEMENTS: readonly string[] = FTS_TABLES.map(
  (table) => `INSERT INTO ${table}(${table}, rank) VALUES('secure-delete', 1)`,
);

/** The terms column of `memory_fts`: the `search_terms` JSON array flattened to a token string. */
const MEMORY_TERMS_SQL =
  "coalesce((SELECT group_concat(value, ' ') FROM json_each(NEW.search_terms)), '')";

/**
 * `02` §3.4's entity type codes.
 *
 * One `entity_fts` table holds six kinds of coordination entity, keyed by
 * `rowid = rid * 8 + typeCode`. Six tables each with their own FTS table would mean six index
 * files, six merges and six queries for what `07` always asks as one question — "does anything in
 * this group mention X". Multiplying by 8 rather than 6 leaves the arithmetic a shift and keeps
 * two codes spare.
 *
 * `indexedText` is SQL over `NEW`, and `watchColumns` are the columns whose update must re-index.
 */
export interface EntityFtsSource {
  readonly typeCode: number;
  readonly table: string;
  readonly indexedText: string;
  readonly watchColumns: readonly string[];
}

export const ENTITY_FTS_SOURCES: readonly EntityFtsSource[] = [
  {
    typeCode: 1,
    table: 'events',
    // `02` §3.4 writes `description` here; the column is `notes` (§3.3.5). Corrected at `M1-T13`.
    indexedText:
      "NEW.title || ' ' || coalesce(NEW.notes, '') || ' ' || coalesce(json_extract(NEW.location, '$.text'), '')",
    watchColumns: ['title', 'notes', 'location', 'group_id'],
  },
  {
    typeCode: 2,
    table: 'tasks',
    indexedText: "NEW.title || ' ' || coalesce(NEW.notes, '')",
    watchColumns: ['title', 'notes', 'group_id'],
  },
  {
    typeCode: 3,
    table: 'list_items',
    indexedText: 'NEW.text',
    watchColumns: ['text', 'group_id'],
  },
  {
    typeCode: 4,
    table: 'decisions',
    indexedText: "NEW.summary || ' ' || coalesce(NEW.rationale, '')",
    watchColumns: ['summary', 'rationale', 'group_id'],
  },
  {
    typeCode: 5,
    table: 'plans',
    indexedText: "NEW.title || ' ' || coalesce(NEW.description, '')",
    watchColumns: ['title', 'description', 'group_id'],
  },
  {
    typeCode: 6,
    table: 'polls',
    indexedText: 'NEW.question',
    watchColumns: ['question', 'group_id'],
  },
];

/**
 * `messages` → `messages_fts` (`02` §3.4, verbatim).
 *
 * The `WHEN` clause is the index's definition of "indexable": a message that belongs to no group,
 * has been redacted, or has no text is not in the index. The update trigger repeats the condition
 * as a `WHERE` on the re-insert rather than as a `WHEN` on the trigger, because an update that
 * *makes* a row unindexable — a redaction — must still run the `DELETE`.
 */
export const MESSAGES_FTS_TRIGGERS: readonly string[] = [
  `CREATE TRIGGER trg_messages_fts_ai AFTER INSERT ON messages
WHEN NEW.group_id IS NOT NULL AND NEW.redacted_at IS NULL AND length(NEW.text) > 0
BEGIN
  INSERT INTO messages_fts(rowid, body, scope)
    VALUES (NEW.rid, NEW.text, ${SCOPE_TOKEN_SQL('NEW.group_id')});
END`,
  `CREATE TRIGGER trg_messages_fts_ad AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE rowid = OLD.rid;
END`,
  `CREATE TRIGGER trg_messages_fts_au AFTER UPDATE OF text, redacted_at, group_id ON messages
BEGIN
  DELETE FROM messages_fts WHERE rowid = OLD.rid;
  INSERT INTO messages_fts(rowid, body, scope)
    SELECT NEW.rid, NEW.text, ${SCOPE_TOKEN_SQL('NEW.group_id')}
    WHERE NEW.group_id IS NOT NULL AND NEW.redacted_at IS NULL AND length(NEW.text) > 0;
END`,
];

/**
 * `memory_items` → `memory_fts` and `memory_fts_tri` (`02` §3.4).
 *
 * Indexed while `status <> 'retracted'`. The update trigger watches **only** `status`, which is
 * correct and worth stating: `trg_memory_items_immutable` forbids updating `statement`,
 * `search_terms` or `content` at all (`01` §5 — a memory is never hard-updated in place), so the
 * only way an indexed memory's text can change is by being superseded by a different row. A
 * trigger watching the text columns would be dead code that implied otherwise.
 *
 * `memory_fts_tri` is fed `statement ‖ ' ' ‖ terms` as one `body` column, because a trigram index
 * has no use for field weighting — a substring match is a substring match.
 */
export const MEMORY_FTS_TRIGGERS: readonly string[] = [
  `CREATE TRIGGER trg_memory_items_fts_ai AFTER INSERT ON memory_items
WHEN NEW.status <> 'retracted'
BEGIN
  INSERT INTO memory_fts(rowid, statement, terms, scope)
    VALUES (NEW.rid, NEW.statement, ${MEMORY_TERMS_SQL}, ${SCOPE_TOKEN_SQL('NEW.group_id')});
  INSERT INTO memory_fts_tri(rowid, body)
    VALUES (NEW.rid, NEW.statement || ' ' || ${MEMORY_TERMS_SQL});
END`,
  `CREATE TRIGGER trg_memory_items_fts_ad AFTER DELETE ON memory_items
BEGIN
  DELETE FROM memory_fts WHERE rowid = OLD.rid;
  DELETE FROM memory_fts_tri WHERE rowid = OLD.rid;
END`,
  `CREATE TRIGGER trg_memory_items_fts_au AFTER UPDATE OF status ON memory_items
BEGIN
  DELETE FROM memory_fts WHERE rowid = OLD.rid;
  DELETE FROM memory_fts_tri WHERE rowid = OLD.rid;
  INSERT INTO memory_fts(rowid, statement, terms, scope)
    SELECT NEW.rid, NEW.statement, ${MEMORY_TERMS_SQL}, ${SCOPE_TOKEN_SQL('NEW.group_id')}
    WHERE NEW.status <> 'retracted';
  INSERT INTO memory_fts_tri(rowid, body)
    SELECT NEW.rid, NEW.statement || ' ' || ${MEMORY_TERMS_SQL}
    WHERE NEW.status <> 'retracted';
END`,
];

/** The three `entity_fts` triggers for one coordination table. */
export function entityFtsTriggers(source: EntityFtsSource): readonly string[] {
  const rowid = (alias: 'NEW' | 'OLD') => `${alias}.rid * 8 + ${String(source.typeCode)}`;
  return [
    `CREATE TRIGGER trg_${source.table}_entity_fts_ai AFTER INSERT ON ${source.table}
BEGIN
  INSERT INTO entity_fts(rowid, body, scope)
    VALUES (${rowid('NEW')}, ${source.indexedText}, ${SCOPE_TOKEN_SQL('NEW.group_id')});
END`,
    `CREATE TRIGGER trg_${source.table}_entity_fts_ad AFTER DELETE ON ${source.table}
BEGIN
  DELETE FROM entity_fts WHERE rowid = ${rowid('OLD')};
END`,
    `CREATE TRIGGER trg_${source.table}_entity_fts_au AFTER UPDATE OF ${source.watchColumns.join(', ')} ON ${source.table}
BEGIN
  DELETE FROM entity_fts WHERE rowid = ${rowid('OLD')};
  INSERT INTO entity_fts(rowid, body, scope)
    VALUES (${rowid('NEW')}, ${source.indexedText}, ${SCOPE_TOKEN_SQL('NEW.group_id')});
END`,
  ];
}

/** Every FTS sync trigger, in creation order. */
export function allFtsTriggers(): readonly string[] {
  return [
    ...MESSAGES_FTS_TRIGGERS,
    ...MEMORY_FTS_TRIGGERS,
    ...ENTITY_FTS_SOURCES.flatMap((source) => entityFtsTriggers(source)),
  ];
}
