/**
 * The spike's benchmarks (`02` §3.6.3 step 10, `02` §3.16, SP-2).
 *
 * Measurements, not assertions, so this is a script rather than a test: a benchmark that fails CI
 * because a laptop was busy teaches people to ignore CI. `M1-T32` builds the real bench
 * infrastructure with a recorded baseline; `M1-T33` measures the `02` §3.16.4 budgets. This exists
 * now because the spike's decision matrix has one numeric gate in it — SP-2's 40 MB/s — and
 * because "encrypted is not much slower than plain" is a claim worth having a number for before
 * the schema is designed around it.
 *
 * Run: `pnpm -F @comvivo/storage bench:storage`
 *
 * Every row prints the machine and Node version it was measured on, because a throughput figure
 * without them is decoration.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { version } from 'node:process';
import sodium from 'libsodium-wrappers';
import { BENCH_PREFIX, DB_FILENAME, openSpikeDatabase, rowid, vec } from './open.js';

export interface BenchRow {
  readonly metric: string;
  readonly value: string;
  readonly note: string;
}

export interface BenchReport {
  readonly host: string;
  readonly node: string;
  readonly rows: readonly BenchRow[];
}

const DIMENSIONS = 384; // `multilingual-e5-small`, ADR-007's default.

function hostLabel(): string {
  const model = cpus()[0]?.model ?? 'unknown cpu';
  const gib = Math.round(totalmem() / 1024 ** 3);
  return `${platform()}-${arch()} · ${model} · ${String(gib)} GiB · kernel ${release()}`;
}

function millis(fn: () => void): number {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/** A deterministic unit vector, so two runs measure the same work. */
function unitVector(seed: number): Buffer {
  const values = new Array<number>(DIMENSIONS);
  let x = seed * 2_654_435_761;
  let sum = 0;
  for (let i = 0; i < DIMENSIONS; i += 1) {
    x = (x * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    const v = (x / 0x7f_ff_ff_ff) * 2 - 1;
    values[i] = v;
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  return vec(values.map((v) => v / norm));
}

/** Insert throughput with and without the cipher, on the same schema and pragmas. */
function insertThroughput(rows: number): BenchRow[] {
  const measure = (encrypted: boolean): { perSecond: number; bytes: number } => {
    const dir = mkdtempSync(join(tmpdir(), BENCH_PREFIX));
    try {
      const path = join(dir, DB_FILENAME);
      const db = openSpikeDatabase({ path, key: encrypted ? randomBytes(32) : null });
      try {
        db.exec('create table messages (rid integer primary key, group_id text, text text)');
        const insert = db.prepare('insert into messages (group_id, text) values (?, ?)');
        const elapsed = millis(() => {
          db.transaction(() => {
            for (let i = 0; i < rows; i += 1) {
              insert.run('grp_01jd8', `message number ${String(i)} about dinner and the recital`);
            }
          })();
        });
        db.pragma('wal_checkpoint(TRUNCATE)');
        return { perSecond: (rows / elapsed) * 1000, bytes: statSync(path).size };
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const plain = measure(false);
  const encrypted = measure(true);
  const ratio = encrypted.perSecond / plain.perSecond;
  return [
    {
      metric: `Insert throughput, plain (${String(rows)} rows, one transaction)`,
      value: `${Math.round(plain.perSecond).toLocaleString('en-GB')} rows/s`,
      note: `${(plain.bytes / 1024 ** 2).toFixed(1)} MiB on disk`,
    },
    {
      metric: `Insert throughput, SQLCipher (${String(rows)} rows, one transaction)`,
      value: `${Math.round(encrypted.perSecond).toLocaleString('en-GB')} rows/s`,
      note: `${(encrypted.bytes / 1024 ** 2).toFixed(1)} MiB on disk · ${(ratio * 100).toFixed(0)}% of plain`,
    },
  ];
}

/**
 * KNN latency at two index sizes, and — the finding that matters — at two page-cache sizes.
 *
 * The first run of this benchmark reported **507 ms p50** at 50k vectors and sent me looking for a
 * bug in the measurement. There was none. With SQLCipher and a page cache smaller than the vector
 * index, every KNN query re-reads and **re-decrypts the whole partition**: 77 MiB for 50k × 384d.
 * Raise the cache above the index and the same query is 5 ms. The plain-text build is 15 ms either
 * way, because it never pays for decryption and the OS page cache does the rest.
 *
 * So `cache_size` is not a tuning knob for this product; it is the difference between memory
 * search inside its 60 ms budget (`02` §3.16.4) and 8× outside it. Both configurations are
 * measured here so the cliff is in the report rather than in somebody's afternoon.
 */
function knnLatency(sizes: readonly number[]): BenchRow[] {
  const out: BenchRow[] = [];
  const CACHES = [
    { kib: 8 * 1024, label: '8 MiB cache' },
    { kib: 192 * 1024, label: '192 MiB cache' },
  ];

  for (const size of sizes) {
    for (const cache of CACHES) {
      const dir = mkdtempSync(join(tmpdir(), `${BENCH_PREFIX}knn-`));
      try {
        const path = join(dir, DB_FILENAME);
        const db = openSpikeDatabase({
          path,
          key: randomBytes(32),
          cacheSizeKiB: cache.kib,
        });
        try {
          db.exec(`
            create virtual table vec_memory using vec0(
              group_rid integer partition key,
              label_id integer,
              embedding float[${String(DIMENSIONS)}],
              chunk_size=256
            )
          `);
          const insert = db.prepare(
            'insert into vec_memory(rowid, group_rid, label_id, embedding) values (?, ?, ?, ?)',
          );
          db.transaction(() => {
            for (let i = 1; i <= size; i += 1) {
              insert.run(rowid(i), 1n, BigInt(i % 8), unitVector(i));
            }
          })();
          db.pragma('wal_checkpoint(TRUNCATE)');
          const indexMiB = statSync(path).size / 1024 ** 2;

          // The real retrieval query: partition, padded eligible-label set, k = 16.
          const eligible = [0n, 1n, 2n, 3n, 0n, 1n, 2n, 3n];
          const query = db.prepare(`
            select rowid, distance from vec_memory
            where embedding match ? and k = 16 and group_rid = 1
              and label_id in (${eligible.map(() => '?').join(', ')})
            order by distance
          `);
          query.all(unitVector(size + 1), ...eligible); // warm
          const samples: number[] = [];
          for (let i = 0; i < 15; i += 1) {
            samples.push(millis(() => void query.all(unitVector(size + 2 + i), ...eligible)));
          }
          samples.sort((a, b) => a - b);
          const p50 = samples[Math.floor(samples.length / 2)] ?? 0;
          const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
          out.push({
            metric:
              `KNN k=16 over ${size.toLocaleString('en-GB')} vectors ` +
              `(${String(DIMENSIONS)}d, SQLCipher, ${cache.label})`,
            value: `p50 ${p50.toFixed(1)} ms`,
            note:
              `p95 ${p95.toFixed(1)} ms · ${indexMiB.toFixed(0)} MiB database · ` +
              '15 queries · label filter applied',
          });
        } finally {
          db.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return out;
}

/** FTS query latency on a message corpus the size `02` §3.16 uses. */
function ftsLatency(messages: number): BenchRow[] {
  const dir = mkdtempSync(join(tmpdir(), `${BENCH_PREFIX}fts-`));
  try {
    const db = openSpikeDatabase({ path: join(dir, DB_FILENAME), key: randomBytes(32) });
    try {
      db.exec(`
        create virtual table messages_fts using fts5(
          body, scope, content='', contentless_delete=1,
          tokenize="unicode61 remove_diacritics 2", detail=full
        )
      `);
      db.exec("insert into messages_fts(messages_fts, rank) values('secure-delete', 1)");
      const insert = db.prepare('insert into messages_fts(rowid, body, scope) values (?, ?, ?)');
      const words = [
        'dinner',
        'recital',
        'rent',
        'pickup',
        'homework',
        'dentist',
        'football',
        'groceries',
        'laundry',
        'birthday',
        'holiday',
        'passport',
        'bins',
        'flowers',
        'tuesday',
        'friday',
      ];
      const indexMs = millis(() => {
        db.transaction(() => {
          for (let i = 1; i <= messages; i += 1) {
            const body = [
              words[i % words.length],
              words[(i * 7) % words.length],
              words[(i * 13) % words.length],
              `number ${String(i)}`,
            ].join(' ');
            insert.run(i, body, i % 4 === 0 ? 'g01jd9' : 'g01jd8');
          }
        })();
      });

      const query = db.prepare(`
        select rowid, bm25(messages_fts, 1.0, 0.0) as score
        from messages_fts where messages_fts match ? order by score limit 20
      `);
      query.all('scope : "g01jd8" AND recital'); // warm
      const samples: number[] = [];
      for (let i = 0; i < 25; i += 1) {
        const term = words[i % words.length] ?? 'dinner';
        samples.push(millis(() => void query.all(`scope : "g01jd8" AND ${term}`)));
      }
      samples.sort((a, b) => a - b);
      const p50 = samples[Math.floor(samples.length / 2)] ?? 0;
      const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
      return [
        {
          metric: `FTS5 index build, ${messages.toLocaleString('en-GB')} messages`,
          value: `${(indexMs / 1000).toFixed(1)} s`,
          note: `${Math.round((messages / indexMs) * 1000).toLocaleString('en-GB')} rows/s, one transaction`,
        },
        {
          metric: `FTS5 query over ${messages.toLocaleString('en-GB')} messages (scoped, bm25, limit 20)`,
          value: `p50 ${p50.toFixed(2)} ms`,
          note: `p95 ${p95.toFixed(2)} ms · 25 queries`,
        },
      ];
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** SP-2: libsodium secretstream throughput, against the 40 MB/s gate. */
async function secretstreamThroughput(megabytes: number): Promise<BenchRow[]> {
  await sodium.ready;
  const chunkSize = 64 * 1024; // `02` D13's 64 KiB chunks.
  const chunks = Math.ceil((megabytes * 1024 * 1024) / chunkSize);
  const plaintext = randomBytes(chunkSize);
  const key = sodium.crypto_secretstream_xchacha20poly1305_keygen();

  const sealMs = millis(() => {
    const { state } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
    for (let i = 0; i < chunks; i += 1) {
      sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        plaintext,
        null,
        i === chunks - 1
          ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
          : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      );
    }
  });

  const mbPerSecond = (chunks * chunkSize) / 1024 ** 2 / (sealMs / 1000);
  return [
    {
      metric: 'libsodium-wrappers secretstream seal (SP-2)',
      value: `${mbPerSecond.toFixed(1)} MB/s`,
      note:
        `${String(chunks)} × 64 KiB chunks · gate is ≥ 40 MB/s **on a Pi 5** (owner ask H-10); ` +
        'this machine is not the gate',
    },
  ];
}

export async function runStorageBenchmarks(): Promise<BenchReport> {
  const rows: BenchRow[] = [
    ...insertThroughput(50_000),
    ...knnLatency([10_000, 50_000]),
    ...ftsLatency(135_000),
    ...(await secretstreamThroughput(64)),
  ];
  return { host: hostLabel(), node: version, rows };
}

/** Print the report as the markdown table `docs/architecture/storage-benchmarks.md` carries. */
export function renderBenchReport(report: BenchReport): string {
  const header = [
    `**Host:** ${report.host}`,
    `**Node:** ${report.node}`,
    '',
    '| Metric | Value | Notes |',
    '|---|---|---|',
  ];
  const body = report.rows.map((r) => `| ${r.metric} | **${r.value}** | ${r.note} |`);
  return [...header, ...body, ''].join('\n');
}

// A module, not a side effect: `bench.spike.test.ts` imports the functions, and the CLI entry
// below only runs when this file is the process entry point.
if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
) {
  const report = await runStorageBenchmarks();
  process.stdout.write(`${renderBenchReport(report)}\n`);
}
