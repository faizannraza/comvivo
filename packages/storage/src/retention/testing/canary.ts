/**
 * `assertNoCanary` — `02` §3.13.5's verification that an erasure left nothing (`M1-T26`).
 *
 * The idea is older than this codebase and it is the only way to test an erasure honestly: seed a
 * string that appears nowhere else in the universe, run the deletion, then go looking for it
 * *everywhere* rather than in the places the deletion was written to clear. A test that checks the
 * tables the implementation walks can only ever confirm the implementation's own list.
 *
 * `02` §3.13.5 names five places, and each is here because a real erasure has failed in it:
 *
 *  1. **Every text and blob column of every table**, discovered from `sqlite_schema` — so a table
 *     a later milestone adds is searched without anyone remembering to add it.
 *  2. **The FTS doclists.** FTS5 keeps its own copy of the indexed text in `<name>_content` and its
 *     tokens in `<name>_data`. A `DELETE` on the base table fires the sync trigger; a delete that
 *     bypassed the trigger — a `DELETE` on a shadow table, a disabled trigger — leaves the content
 *     perfectly searchable with the row gone.
 *  3. **The vec rows** of deleted memories, which are vectors rather than text and so cannot carry
 *     the canary, but *can* carry a deleted item's embedding: checked by rid rather than by content.
 *  4. **Blob files**, whose bytes are ciphertext — so the canary cannot appear even before deletion.
 *     What is checked is that the file is *gone*, which is the only thing a plaintext search of an
 *     encrypted file could never tell you.
 *  5. **The raw database file, its WAL and its shared-memory file**, after a truncating checkpoint.
 *     This is the one that catches the difference between "the row is deleted" and "the bytes are
 *     gone": SQLite leaves a deleted row's payload on a free page until something overwrites it,
 *     and the WAL holds it until the checkpoint. `secure_delete` and the checkpoint are what make
 *     this pass, and nothing else is.
 *
 * ## Four spellings, because one is not how text is stored
 *
 * A canary written through the API is UTF-8 in the page, but the same string reaches a file as
 * UTF-16 if any column is `NVARCHAR`-shaped, and search is case-folded, and an FTS tokenizer
 * lowercases. Searching for one spelling is the kind of test that passes while the data is sitting
 * there in another encoding.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import { shadowTables } from '../inventory.js';

/** Where the canary was found. Empty means the erasure is complete. */
export interface CanaryHit {
  /** `table.column`, `fts:<name>`, `file:<path>`, or `vec:<table>`. */
  readonly where: string;
  /** Which spelling matched, so a failure says whether it was an encoding issue. */
  readonly form: string;
  /** How many rows or bytes matched. Never the surrounding content. */
  readonly count: number;
  /**
   * The column could not be read, so this is "not checked" rather than "found".
   *
   * It still fails the assertion: an erasure verification that silently skips a column it could
   * not query is the kind of pass that means nothing.
   */
  readonly unreadable?: boolean;
}

export interface CanaryOptions {
  /** The blob directory, if the instance has one. Skipped when absent. */
  readonly blobsDir?: string | undefined;
  /** The database file, so the raw pages and the WAL can be read. `:memory:` has none. */
  readonly dbPath?: string | undefined;
  /** vec0 rids that must no longer have a vector row. */
  readonly erasedRids?: readonly number[] | undefined;
}

/**
 * The spellings to look for.
 *
 * `latin1` is deliberately not here: it is a byte-for-byte subset of UTF-8 for ASCII canaries, so
 * it would only ever duplicate the first entry. Mixed case covers both a case-folding comparison
 * and an FTS tokenizer's lowercasing.
 */
function spellings(canary: string): readonly (readonly [string, Buffer])[] {
  return [
    ['utf8', Buffer.from(canary, 'utf8')],
    ['utf16le', Buffer.from(canary, 'utf16le')],
    ['lower', Buffer.from(canary.toLowerCase(), 'utf8')],
    ['upper', Buffer.from(canary.toUpperCase(), 'utf8')],
  ];
}

interface ColumnRow {
  readonly name: string;
  readonly type: string;
  /** 0 normal, 1 hidden (virtual tables only), 2 `VIRTUAL` generated, 3 `STORED` generated. */
  readonly hidden: number;
}

/**
 * Text and blob columns hold content; an integer column cannot hold a canary.
 *
 * **`table_xinfo`, not `table_info`.** Measured: `table_info` omits generated columns entirely, so
 * a `STORED` generated column — which SQLite writes into the page like any other — was never
 * searched, and a `VIRTUAL` one computed from erased text was never evaluated. The header's first
 * promise is "every text and blob column of every table, discovered from `sqlite_schema`, so a
 * table a later milestone adds is searched without anyone remembering"; the same reasoning applies
 * to a column, and `table_info` quietly excluded a whole kind of them. Found at the M1 exit gate
 * while building the fixture for the unreadable-column case, which could not be seen at all.
 *
 * `hidden === 1` is dropped: that is a virtual table's hidden column, and virtual tables are
 * skipped by the caller — their content lives in shadow tables, where these columns are ordinary.
 */
function searchableColumns(db: Database.Database, table: string): readonly string[] {
  return (db.pragma(`table_xinfo(${JSON.stringify(table)})`) as ColumnRow[])
    .filter((column) => column.hidden !== 1)
    .filter((column) => /char|clob|text|blob/i.test(column.type) || column.type === '')
    .map((column) => column.name);
}

/** Every table worth searching, shadow tables **included** — see point 2 in the header. */
function searchableTables(db: Database.Database): readonly string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

/**
 * Find every trace of `canary`.
 *
 * Returns the hits rather than throwing, so a test can assert on an empty array and print the
 * whole list when it is not — "found in 3 places" with the places named beats the first failure.
 */
export function findCanary(
  db: Database.Database,
  canary: string,
  options: CanaryOptions = {},
): readonly CanaryHit[] {
  const forms = spellings(canary);
  const hits: CanaryHit[] = [...columnHits(db, forms)];
  hits.push(...ftsHits(db, canary));
  hits.push(...vecHits(db, options.erasedRids ?? []));
  hits.push(...fileHits(forms, filesToScan(options)));
  return hits;
}

/** Every text and blob column of every table, in all four spellings (point 1 in the header). */
function columnHits(
  db: Database.Database,
  forms: readonly (readonly [string, Buffer])[],
): readonly CanaryHit[] {
  const hits: CanaryHit[] = [];
  const shadows = shadowTables(db);
  for (const table of searchableTables(db)) {
    // A virtual table's own name cannot be selected from with `instr`, but its shadow tables can —
    // and they are where the content actually lives, so the shadows are searched and the virtual
    // table is skipped.
    if (isVirtualTable(db, table)) continue;
    const suffix = shadows.has(table) ? ' (shadow)' : '';
    for (const column of searchableColumns(db, table)) {
      hits.push(...scanColumn(db, table, column, `${table}.${column}${suffix}`, forms));
    }
  }
  return hits;
}

/**
 * One column, in every spelling.
 *
 * `UNREADABLE` becomes a hit rather than nothing. `countMatches` used to `return 0` with a comment
 * claiming "the file scan below reads the same bytes unconditionally, so nothing is left unchecked"
 * — and `filesToScan` returns **nothing** for an in-memory database, which is what most of these
 * tests use. So on the one configuration where the justification was needed it was false, and a
 * column SQLite refused to read counted as a column with no canary in it. Found by the M1 exit
 * gate's reviewer. The reported hit has `count: 0` and fails the assertion all the same, which is
 * the point: "could not look" and "looked and found nothing" are not the same answer.
 */
function scanColumn(
  db: Database.Database,
  table: string,
  column: string,
  where: string,
  forms: readonly (readonly [string, Buffer])[],
): readonly CanaryHit[] {
  const hits: CanaryHit[] = [];
  for (const [form, needle] of forms) {
    const count = countMatches(db, table, column, needle);
    if (count === UNREADABLE) hits.push({ where, form, count: 0, unreadable: true });
    else if (count > 0) hits.push({ where, form, count });
  }
  return hits;
}

/** What `countMatches` returns when the column could not be read at all. */
const UNREADABLE = -1;

/**
 * `instr` on a `CAST(… AS BLOB)`, so a text and a blob column are searched the same way.
 *
 * `UNREADABLE` rather than `0` when the query fails — a shadow table SQLite refuses to read
 * directly, or a column type it will not cast. The caller turns that into a hit, because an
 * erasure check that cannot read a column has not checked it.
 */
function countMatches(
  db: Database.Database,
  table: string,
  column: string,
  needle: Buffer,
): number {
  const sql = `SELECT count(*) AS n FROM "${table.replaceAll('"', '""')}"
                WHERE instr(CAST("${column.replaceAll('"', '""')}" AS BLOB), ?) > 0`;
  try {
    return (db.prepare(sql).get(needle) as { n: number }).n;
  } catch {
    return UNREADABLE;
  }
}

function isVirtualTable(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string | null } | undefined;
  return (row?.sql ?? '').toUpperCase().includes('CREATE VIRTUAL TABLE');
}

/**
 * Ask each FTS index for the canary, which is a different question from searching its tables.
 *
 * `MATCH` goes through the tokenizer, so this finds the canary if it is *indexed* — even when the
 * content table has been cleared, because FTS5 keeps the term in `<name>_data` until the index is
 * rebuilt or the delete goes through the trigger.
 */
function ftsHits(db: Database.Database, canary: string): readonly CanaryHit[] {
  const hits: CanaryHit[] = [];
  const indexes = (
    db
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND sql LIKE '%USING fts5%' ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  for (const index of indexes) {
    try {
      const row = db
        .prepare(`SELECT count(*) AS n FROM "${index}" WHERE "${index}" MATCH ?`)
        .get(quoteForFts(canary)) as { n: number };
      if (row.n > 0) hits.push({ where: `fts:${index}`, form: 'match', count: row.n });
    } catch {
      // An FTS query error means the term tokenized to nothing, which is not a hit.
    }
  }
  return hits;
}

/** A canary may contain `-`, which FTS5 reads as an operator. Quoted, it is a phrase. */
function quoteForFts(canary: string): string {
  return `"${canary.replaceAll('"', '""')}"`;
}

/** Vectors cannot hold a canary, so the question is whether the row is gone. */
function vecHits(db: Database.Database, erasedRids: readonly number[]): readonly CanaryHit[] {
  if (erasedRids.length === 0) return [];
  const hits: CanaryHit[] = [];
  const spaces = (
    db
      .prepare(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name LIKE 'vec_memory_%' AND sql LIKE '%USING vec0%'
          ORDER BY name`,
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const list = erasedRids.map(() => '?').join(', ');
  for (const space of spaces) {
    const row = db
      .prepare(`SELECT count(*) AS n FROM "${space}" WHERE rid IN (${list})`)
      .get(...erasedRids.map((rid) => BigInt(rid))) as { n: number };
    if (row.n > 0) hits.push({ where: `vec:${space}`, form: 'rid', count: row.n });
  }
  return hits;
}

/** The database file, its sidecars, and every blob file. */
function filesToScan(options: CanaryOptions): readonly string[] {
  const files: string[] = [];
  if (options.dbPath !== undefined && options.dbPath !== ':memory:') {
    files.push(options.dbPath, `${options.dbPath}-wal`, `${options.dbPath}-shm`);
  }
  if (options.blobsDir !== undefined) files.push(...filesUnder(options.blobsDir));
  return files;
}

function filesUnder(dir: string): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

function fileHits(
  forms: readonly (readonly [string, Buffer])[],
  files: readonly string[],
): readonly CanaryHit[] {
  const hits: CanaryHit[] = [];
  for (const file of files) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      // A `-wal` or `-shm` that does not exist is the normal case after a truncating checkpoint.
      continue;
    }
    for (const [form, needle] of forms) {
      if (bytes.includes(needle)) hits.push({ where: `file:${file}`, form, count: 1 });
    }
  }
  return hits;
}

/**
 * Throw unless `canary` is gone.
 *
 * `02` §3.13.5 names this helper; the message lists every place it was found, because the *first*
 * place is rarely the interesting one — a canary in both a table and the WAL means the delete
 * worked and the checkpoint did not, which is a completely different fix from a canary in a table
 * alone.
 */
export function assertNoCanary(
  db: Database.Database,
  canary: string,
  options: CanaryOptions = {},
): void {
  const hits = findCanary(db, canary, options);
  if (hits.length === 0) return;
  // An unreadable column is reported as "not checked", not as a count: a failure saying `×0` would
  // read as a bug in this helper rather than as the column it could not search.
  const places = hits
    .map(
      (hit) =>
        `${hit.where} [${hit.form}] ${hit.unreadable === true ? '(not checked: unreadable)' : `×${String(hit.count)}`}`,
    )
    .join('\n  ');
  throw new Error(`the canary survived in ${String(hits.length)} place(s):\n  ${places}`);
}
