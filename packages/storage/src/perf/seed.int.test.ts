/**
 * The fixture generator against a real database (`02` §3.16.5).
 *
 * `seed.test.ts` proves the distributions; this proves the rows. The generator is a **measuring
 * instrument** — every figure in `docs/architecture/storage-benchmarks.md` is a statement about
 * the data it produced — so the things that would silently invalidate a measurement are the things
 * asserted here: the label mix (if every row carried the group label, the eligibility predicate in
 * each benched query would be free), the planted needles (if FTS found nothing, the text rows would
 * be measuring a miss), the vector clustering (if the vectors were uniform, KNN would be measuring
 * a scan), and determinism (if two runs differed, two measurements could not be compared).
 */
import { createHash } from 'node:crypto';
import { SystemClock, TypeIdGenerator } from '@comvivo/shared';
import { SeededRng } from '@comvivo/shared/testing';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { describe, expect, it } from 'vitest';
import { makeDb } from '../db/drizzle.js';
import { silentLogger } from '../repos/testing/harness.js';
import { createTestDb } from '../testing/test-db.js';
import {
  SEED_EPOCH,
  SEED_PROFILES,
  type SeedProfile,
  type SeedReport,
  seedPerfDatabase,
} from './seed.js';

/** Generate into a fresh database and hand both back. The caller closes it. */
function generate(
  profile: SeedProfile,
  onProgress?: (written: number, total: number) => void,
): { db: Database; report: SeedReport } {
  const db = createTestDb();
  const clock = new SystemClock();
  const report = seedPerfDatabase(profile, {
    db: makeDb(db),
    connection: db,
    ids: new TypeIdGenerator(clock),
    rng: new SeededRng(profile.seed),
    logger: silentLogger,
    ...(onProgress === undefined ? {} : { onProgress }),
  });
  return { db, report };
}

/** A profile small enough for the unit tiers: two days of one group, 200 memories. */
const SMALL: SeedProfile = {
  ...SEED_PROFILES['release-small'],
  groups: [
    {
      ...(SEED_PROFILES['release-small'].groups[0] ?? {
        members: 5,
        days: 2,
        msgsPerDay: 100,
        memoriesTotal: 200,
        dmShare: 0.1,
        privateMemoryShare: 0.04,
        subgroupShare: 0.01,
        attachmentsPerDay: 8,
      }),
      days: 2,
      msgsPerDay: 100,
      memoriesTotal: 200,
    },
  ],
};

describe('seedPerfDatabase', () => {
  it('writes the rows the profile asks for, and reports them', () => {
    const { db, report } = generate(SMALL);
    try {
      expect(report.messages).toBe(200);
      expect(report.memories).toBe(200);
      // A vector per memory: `02` §3.16.5's fixture is for KNN as much as for FTS, and a memory
      // with no vector is invisible to the row that measures it.
      expect(report.vectors).toBe(200);
      expect(report.rowsPerSecond).toBeGreaterThan(0);
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(count('messages')).toBe(200);
      expect(count('memory_items')).toBe(200);
      expect(count(`vec_memory_${report.spaceSlug}`)).toBe(200);
      // The parents a labeled row needs, so the foreign keys are real rather than deferred.
      expect(count('groups')).toBe(1);
      expect(count('members')).toBe(5);
      // One group conversation plus one DM per member.
      expect(count('conversations')).toBe(6);
    } finally {
      db.close();
    }
  });

  it('spreads the labels, so the eligibility predicate costs something', () => {
    const { db, report } = generate(SMALL);
    try {
      const labels = db
        .prepare(
          `SELECT label_id, COUNT(*) AS n FROM messages WHERE group_id = ? GROUP BY label_id ORDER BY n DESC`,
        )
        .all(report.groups[0]) as { label_id: number; n: number }[];
      // More than one label in play. With a single label the `label_id IN (…)` filter in every
      // benched read would match everything and measure nothing — which is the shape `02` §3.16.5
      // asks for with its 85/10/4/1 mix.
      expect(labels.length).toBeGreaterThan(1);
      const total = labels.reduce((sum, row) => sum + row.n, 0);
      const dominant = (labels[0]?.n ?? 0) / total;
      // The group label dominates, but not entirely: ~85% group, ~10% DM, the rest private or
      // subgroup. Wide bands, because 200 messages is a small sample of a distribution.
      expect(dominant).toBeGreaterThan(0.6);
      expect(dominant).toBeLessThan(0.98);
      // The DM traffic landed in DM conversations, not in the group one.
      const dms = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
              WHERE c.kind = 'dm'`,
          )
          .get() as { n: number }
      ).n;
      expect(dms).toBeGreaterThan(0);
      expect(dms).toBeLessThan(200);
    } finally {
      db.close();
    }
  });

  it('points every vector at the memory it belongs to', () => {
    const { db, report } = generate(SMALL);
    try {
      // The generator takes each memory's rid from its insert's own `lastInsertRowid` rather than
      // re-reading it, which is correct only because SQLite restores `last_insert_rowid()` when a
      // trigger ends — and the FTS triggers insert rows of their own on the way. If that were
      // wrong, the vectors would be attached to postings instead of memories and every KNN result
      // would hydrate the wrong row (or none). So the mapping is asserted, not reasoned about.
      const orphans = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM vec_memory_${report.spaceSlug} v
               WHERE NOT EXISTS (SELECT 1 FROM memory_items m WHERE m.rid = v.rid)`,
          )
          .get() as { n: number }
      ).n;
      expect(orphans).toBe(0);
      const matched = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM memory_items m
               WHERE EXISTS (SELECT 1 FROM vec_memory_${report.spaceSlug} v WHERE v.rid = m.rid)`,
          )
          .get() as { n: number }
      ).n;
      expect(matched).toBe(report.memories);
    } finally {
      db.close();
    }
  });

  it('plants needles the FTS index can find', () => {
    const { db, report } = generate(SMALL);
    try {
      expect(report.needles).toBeGreaterThan(0);
      const hits = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH 'perfneedle*'`)
          .get() as { n: number }
      ).n;
      // Every needle is indexed. `02` §3.16.5 plants them so recall can be verified; a text
      // benchmark whose query matched nothing would report the cost of a miss, which is the
      // cheapest possible answer and the least informative.
      expect(hits).toBe(report.needles);
    } finally {
      db.close();
    }
  });

  it('clusters the vectors, so KNN measures an index rather than a scan', () => {
    const { db, report } = generate(SMALL);
    try {
      const space = `vec_memory_${report.spaceSlug}`;
      const query = (
        db.prepare(`SELECT embedding FROM ${space} LIMIT 1`).get() as { embedding: Buffer }
      ).embedding;
      const neighbours = db
        .prepare(
          `SELECT distance FROM ${space} WHERE embedding MATCH ? AND k = 10 AND group_id = ? ORDER BY distance`,
        )
        .all(query, report.groups[0]) as { distance: number }[];
      expect(neighbours).toHaveLength(10);
      // In 384 dimensions, two uniform random unit vectors sit at a distance of about √2 ≈ 1.41,
      // and *every* pair is close to that — which is why `02` §3.16.5 clusters around 64
      // centroids. The structure to see is a **gap**: a same-cluster neighbour at ≈ 0.44 and the
      // rest out at ≈ 1.32. Measured on this profile, with 200 memories over 64 centroids, so
      // only two or three share each one.
      const [self, closest] = neighbours;
      expect(self?.distance).toBeCloseTo(0, 3);
      expect(closest?.distance ?? 2).toBeLessThan(0.6);
      // Non-vacuity, and the assertion that catches the σ bug this test was written for: with the
      // noise taken per dimension, σ = 0.35 makes every vector a uniform random direction and this
      // nearest neighbour sat at **1.287** rather than 0.44.
      expect(neighbours.at(-1)?.distance ?? 0).toBeGreaterThan(1);
    } finally {
      db.close();
    }
  });

  it('is the fixture the published numbers were measured on', () => {
    const { db, report } = generate(SMALL);
    try {
      const hash = createHash('sha256');
      const column = (sql: string): unknown[] => db.prepare(sql).all() as unknown[];
      for (const row of column(`SELECT text FROM messages ORDER BY rid`)) {
        hash.update((row as { text: string }).text);
      }
      for (const row of column(`SELECT statement FROM memory_items ORDER BY rid`)) {
        hash.update((row as { statement: string }).statement);
      }
      for (const row of column(
        `SELECT label_id, COUNT(*) n FROM messages GROUP BY label_id ORDER BY label_id`,
      )) {
        const counted = row as { label_id: number; n: number };
        hash.update(`${String(counted.label_id)}:${String(counted.n)}`);
      }
      for (const row of column(
        `SELECT embedding FROM vec_memory_${report.spaceSlug} ORDER BY rid`,
      )) {
        hash.update((row as { embedding: Buffer }).embedding);
      }
      // Pinned, for the reason the test above is not enough: that one proves two runs of *this*
      // code agree, and this one proves this code agrees with the code the numbers in
      // `docs/architecture/storage-benchmarks.md` were taken from. The draw order is the fixture's
      // identity — one `rng.next()` moved past another rewrites every row while every
      // distribution assertion still passes — so a refactor that changes the data fails here and
      // says, correctly, that the benchmarks need re-running.
      expect(hash.digest('hex').slice(0, 32)).toBe('7b4f0b9a16731bd6ecf15f2f98ebb0d6');
      expect(report.needles).toBe(6);
    } finally {
      db.close();
    }
  });

  it('is deterministic: the same seed writes the same database', () => {
    const first = generate(SMALL);
    const second = generate(SMALL);
    try {
      const texts = (db: Database): string[] =>
        (
          db.prepare(`SELECT text FROM messages ORDER BY rid LIMIT 20`).all() as { text: string }[]
        ).map((row) => row.text);
      // The guarantee the whole benchmark rests on: a measurement taken today is comparable with
      // one taken next month because the data is the same data.
      expect(texts(first.db)).toEqual(texts(second.db));
      expect(first.report.needles).toBe(second.report.needles);
      expect(first.report.groups).toEqual(second.report.groups);
    } finally {
      first.db.close();
      second.db.close();
    }
  });

  it('anchors the history at SEED_EPOCH, so every row sits a fixed distance from it', () => {
    const { db } = generate(SMALL);
    try {
      const span = db
        .prepare(`SELECT MIN(sent_at) AS lo, MAX(sent_at) AS hi FROM messages`)
        .get() as {
        lo: number;
        hi: number;
      };
      // Not `Date.now()`: a wall-clock anchor would put the retention and recent-window rows a
      // different distance from `now` on every run, and two such measurements are not comparable.
      // Two days of history from the anchor, so the span is inside those two days.
      expect(span.lo).toBeGreaterThanOrEqual(SEED_EPOCH.epochMilliseconds);
      expect(span.hi).toBeLessThan(SEED_EPOCH.epochMilliseconds + 2 * 86_400_000);
    } finally {
      db.close();
    }
  });

  it('reports progress, because the stress profile is half a minute of work', () => {
    const seen: { written: number; total: number }[] = [];
    const { db, report } = generate(SMALL, (written, total) => {
      seen.push({ written, total });
    });
    try {
      expect(seen.length).toBeGreaterThan(0);
      // Monotonic and bounded by one total: the bench fixture turns this into a percentage, which
      // a count that went backwards or a total that moved would make nonsense of.
      const totals = new Set(seen.map((entry) => entry.total));
      expect(totals.size).toBe(1);
      expect(seen.map((entry) => entry.written).toSorted((a, b) => a - b)).toEqual(
        seen.map((entry) => entry.written),
      );
      expect(seen.at(-1)?.written).toBe(report.messages + report.memories);
    } finally {
      db.close();
    }
  });

  it('writes a different database for a different seed', () => {
    const first = generate(SMALL);
    const second = generate({ ...SMALL, seed: 43 });
    try {
      const text = (db: Database): string =>
        (db.prepare(`SELECT text FROM messages ORDER BY rid LIMIT 1`).get() as { text: string })
          .text;
      // Non-vacuity for the test above: if the generator ignored its seed, both assertions would
      // pass and neither would mean anything.
      expect(text(first.db)).not.toBe(text(second.db));
    } finally {
      first.db.close();
      second.db.close();
    }
  });
});
