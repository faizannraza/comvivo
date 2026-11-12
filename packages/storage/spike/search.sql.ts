/**
 * The FTS5 DDL from `02` §3.4, transcribed for the spike.
 *
 * `M1-T13` moves these to `src/schema/search.sql.ts` and generates the migration from them. They
 * live here first for the same reason the pragma sequence does: the spike has to establish that
 * this exact DDL works — `contentless_delete=1`, `secure-delete`, both tokenizers, the column
 * filter — before a migration writes it into a host's database, where changing it means a rebuild
 * of the whole index.
 */

/** `02` §3.4: messages, with the group scope token as a non-ranking column. */
export const MESSAGES_FTS = `
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    body, scope,
    content='', contentless_delete=1,
    tokenize="unicode61 remove_diacritics 2", detail=full
  )
`;

/** `02` §3.4 / `04` R4: two searchable columns, so a query can filter to one or both. */
export const MEMORY_FTS = `
  CREATE VIRTUAL TABLE memory_fts USING fts5(
    statement, terms, scope,
    content='', contentless_delete=1,
    tokenize="unicode61 remove_diacritics 2", detail=full
  )
`;

/** `02` §3.4: substring matching for CJK, compounds and typos-in-the-middle. */
export const MEMORY_FTS_TRI = `
  CREATE VIRTUAL TABLE memory_fts_tri USING fts5(
    body,
    content='', contentless_delete=1,
    tokenize="trigram remove_diacritics 1", detail=full
  )
`;

/**
 * "Delete anything" — remove tokens immediately rather than at the next merge (SQLite ≥ 3.44).
 *
 * Without it, a deleted memory's tokens stay in the index until a merge happens, which may be
 * never on a quiet instance. `02` §3.14 counts on this for erasure.
 */
export const secureDelete = (table: string): string =>
  `INSERT INTO ${table}(${table}, rank) VALUES('secure-delete', 1)`;

/** The group scope token: `'g' || substr(group_id, 5)` (`02` §3.4). */
export const scopeToken = (groupId: string): string => `g${groupId.slice(4)}`;
