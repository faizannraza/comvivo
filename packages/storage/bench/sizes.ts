/**
 * `02` §3.16.2's per-row sizes, measured with `dbstat` (`14`'s `M1-T33`).
 *
 * That table was estimates — "SQLCipher page overhead included; to be validated by `dbstat`" — and
 * this is the validation. `dbstat` is a virtual table that reports the pages each table and index
 * actually occupies, so dividing by the row count gives what a row costs *including* its indexes,
 * its FTS postings and its vector, which is the figure capacity planning needs and the one nobody
 * can estimate reliably.
 *
 * Run it:
 *
 *     COMVIVO_BENCH_PROFILE=stress-50k-1m pnpm exec tsx packages/storage/bench/sizes.ts
 *
 * Not a `BenchResult`: a size is not a latency, and the harness in `@comvivo/evals` measures
 * percentiles over repetitions, which a file size has none of.
 */
import { statSync } from 'node:fs';
import { type PerfFixture, perfFixture } from './fixture.js';

/** Every table and index, with the bytes it occupies. */
export interface SizeRow {
  readonly name: string;
  readonly bytes: number;
}

/** What one logical row costs, split the way `02` §3.16.2 splits it. */
export interface RowCost {
  readonly table: string;
  readonly rows: number;
  readonly rowBytes: number;
  readonly indexBytes: number;
  readonly ftsBytes: number;
  readonly vectorBytes: number;
  readonly totalBytes: number;
}

/**
 * Which pages belong to which logical row.
 *
 * By prefix, because that is how SQLite names the things that hang off a table: `messages_*` is an
 * index of `messages` unless it is `messages_fts*`, which is the full-text index, and
 * `vec_memory_*` is the vector index of `memory_items`. The split matters because §3.16.2 reports
 * them separately — an FTS index that doubled in size is a different problem from a row that did.
 */
export function attribute(
  name: string,
  table: string,
): keyof Omit<RowCost, 'table' | 'rows' | 'totalBytes'> | undefined {
  if (name === table) return 'rowBytes';
  if (table === 'memory_items' && name.startsWith('vec_memory_')) return 'vectorBytes';
  if (table === 'memory_items' && name.startsWith('memory_fts')) return 'ftsBytes';
  if (name.startsWith(`${table}_fts`)) return 'ftsBytes';
  // `memory_items`'s indexes are named `memory_*`, not `memory_items_*`.
  const indexPrefix = table === 'memory_items' ? 'memory' : table;
  if (name.startsWith(`${indexPrefix}_`)) return 'indexBytes';
  return undefined;
}

export function sizeRows(fixture: PerfFixture): readonly SizeRow[] {
  return fixture.connection
    .prepare(`SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name`)
    .all() as SizeRow[];
}

/** `02` §3.16.2 for one table. */
export function rowCost(fixture: PerfFixture, table: string): RowCost {
  const rows = (
    fixture.connection.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
  const totals = { rowBytes: 0, indexBytes: 0, ftsBytes: 0, vectorBytes: 0 };
  for (const entry of sizeRows(fixture)) {
    const bucket = attribute(entry.name, table);
    if (bucket !== undefined) totals[bucket] += entry.bytes;
  }
  const per = (bytes: number): number => (rows === 0 ? 0 : Math.round(bytes / rows));
  const total = totals.rowBytes + totals.indexBytes + totals.ftsBytes + totals.vectorBytes;
  return {
    table,
    rows,
    rowBytes: per(totals.rowBytes),
    indexBytes: per(totals.indexBytes),
    ftsBytes: per(totals.ftsBytes),
    vectorBytes: per(totals.vectorBytes),
    totalBytes: per(total),
  };
}

/** The whole file, which is what a host sees in their data directory. */
export function databaseBytes(fixture: PerfFixture): number {
  return statSync(fixture.path).size;
}

if (import.meta.main) {
  const fixture = perfFixture();
  const kib = (bytes: number): string => `${(bytes / 1024).toFixed(2)} KB`;
  process.stdout.write(`profile ${fixture.report.profile}\n`);
  process.stdout.write(
    `database ${(databaseBytes(fixture) / 1024 / 1024).toFixed(1)} MB for ` +
      `${String(fixture.report.messages)} messages and ${String(fixture.report.memories)} memories\n\n`,
  );
  process.stdout.write('| table | rows | row | indexes | fts | vector | total |\n');
  process.stdout.write('|---|---|---|---|---|---|---|\n');
  for (const table of ['messages', 'memory_items', 'audit_events', 'jobs']) {
    const cost = rowCost(fixture, table);
    if (cost.rows === 0) continue;
    process.stdout.write(
      `| \`${cost.table}\` | ${String(cost.rows)} | ${kib(cost.rowBytes)} | ${kib(cost.indexBytes)} | ` +
        `${kib(cost.ftsBytes)} | ${kib(cost.vectorBytes)} | **${kib(cost.totalBytes)}** |\n`,
    );
  }
  fixture.close();
}
