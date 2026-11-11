/**
 * Compacting the FTS indexes after a deletion (`02` §3.13.2 as amended at `M1-T26`).
 *
 * One function, called from all three deletion paths — the sweep, the group purge and the person
 * erasure — because all three have the same residue to clear and the reasoning behind it belongs in
 * exactly one place. `schema/search.sql.ts` has that reasoning; this is the call.
 *
 * Deliberately **outside** any transaction. An `optimize` rewrites every segment of every index, so
 * inside a transaction it would hold the write lock for the duration — which is the opposite of
 * what the chunked deletes above it are for. A crash before it runs leaves a correct database with
 * stale terms in the index, which the next deletion's optimize takes.
 */
import type Database from 'better-sqlite3-multiple-ciphers';
import { FTS_OPTIMIZE_STATEMENTS } from '../schema/search.sql.js';

/** Compact every FTS index. Returns how many ran, so a caller can log it. */
export function optimizeFtsIndexes(conn: Database.Database): number {
  for (const statement of FTS_OPTIMIZE_STATEMENTS) conn.exec(statement);
  return FTS_OPTIMIZE_STATEMENTS.length;
}
