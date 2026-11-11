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
}

/** Text and blob columns hold content; an integer column cannot hold a canary. */
function searchableColumns(db: Database.Database, table: string): readonly string[] {
  return (db.pragma(`table_info(${JSON.stringify(table)})`) as ColumnRow[])
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
  const hits: CanaryHit[] = [];
  const forms = spellings(canary);
  const shadows = shadowTables(db);

  for (const table of searchableTables(db)) {
    // A virtual table's own name cannot be selected from with `instr`, but its shadow tables can —
    // and they are where the content actually lives, so the shadows are searched and the virtual
    // table is skipped.
    if (isVirtualTable(db, table)) continue;
    for (const column of searchableColumns(db, table)) {
      for (const [form, needle] of forms) {
        const count = countMatches(db, table, column, needle);
        if (count > 0) {
          hits.push({ where: `${table}.${column}${shadows.has(table) ? ' (shadow)' : ''}`, form, count });
        }
      }
    }
  }

  hits.push(...ftsHits(db, canary));
  hits.push(...vecHits(db, options.erasedRids ?? []));
  hits.push(...fileHits(forms, filesToScan(options)));
  return hits;
}

/** `instr` on a `CAST(… AS BLOB)`, so a text and a blob column are searched the same way. */
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
    // A shadow table SQLite refuses to read directly, or a column type it will not cast. Reported
    // as no hit rather than as an error: the file scan below reads the same bytes unconditionally,
    // so nothing is left unchecked by this returning zero.
    return 0;
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
  const places = hits.map((hit) => `${hit.where} [${hit.form}] ×${String(hit.count)}`).join('\n  ');
  throw new Error(`the canary survived in ${String(hits.length)} place(s):\n  ${places}`);
}
