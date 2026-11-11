/**
 * `02` §3.16.4's latency table, measured (`14`'s `M1-T33`).
 *
 * Every row of that table was an estimate marked **U7** — "to be replaced by `02:M1-T25`
 * measurements", which `14` maps to this task. These are the measurements. The budget column is
 * what each one is checked against, and a row that misses its budget is a deviation filed in `15`
 * and `STATUS.md` rather than a number quietly adjusted.
 *
 * ## What each row actually runs
 *
 * The queries go through the **repositories**, not through hand-written SQL. That is the point: a
 * benchmark of a query this product does not issue measures nothing, and three of these rows are
 * about what the eligibility filter, the zod validation and the FTS triggers cost. Where a row
 * names something that does not exist yet — `02` §3.16.4's "storage share of context build" needs
 * `M6`'s context builder — the substitution is named in the benchmark and in
 * `docs/architecture/storage-benchmarks.md`.
 *
 * ## The profile
 *
 * `COMVIVO_BENCH_PROFILE` selects it (`fixture.ts`), defaulting to `release-small` so a CI push
 * stays inside its job. The numbers in the architecture note are from `stress-50k-1m`, which is
 * what §3.16.4's "1M msgs / 50k memories" column means.
 */
import { expectWritten } from '@comvivo/core';
import type { ConversationId, GroupId, MemoryId } from '@comvivo/shared';
import { SystemClock, TypeIdGenerator } from '@comvivo/shared';
import { SeededRng } from '@comvivo/shared/testing';
import { Temporal } from 'temporal-polyfill';
import { defineBench, type ErasedBench } from '../../evals/src/perf/index.js';
import { openDatabase } from '../src/db/open.js';
import { SqliteStore } from '../src/db/tx.js';
import { appliedMigrations } from '../src/migrate/runner.js';
import { JobKindRegistry } from '../src/queue/kinds.js';
import { makeRepositories, type Repositories } from '../src/repos/index.js';
import { silentLogger } from '../src/repos/testing/harness.js';
import { scopeToken } from '../src/search/fts-query.js';
import { SqliteMemorySearch } from '../src/search/memory-search.js';
import { type PerfFixture, perfFixture } from './fixture.js';

/** Everything a row needs, built once per repetition from the shared fixture. */
interface Context {
  readonly fixture: PerfFixture;
  readonly repos: Repositories;
  readonly store: SqliteStore;
  readonly search: SqliteMemorySearch;
  readonly groupId: GroupId;
  readonly conversationId: ConversationId;
  readonly eligible: never;
  readonly memoryIds: readonly MemoryId[];
  readonly vector: Float32Array;
}

/**
 * The eligible set for "everything in this group", which is what a group-readable audience gets.
 *
 * Built by reading the group's labels rather than by casting an empty one: the whole point of
 * these rows is what the `label_id IN (…)` predicate costs, and an empty set would short-circuit
 * to `1 = 0` and measure nothing.
 */
function eligibleFor(repos: Repositories, groupId: GroupId): never {
  const labels = [...repos.labels.groupLabels(groupId).keys()];
  return {
    groupId,
    ids: labels.toSorted((left, right) => left - right),
    audienceKey: 'g|s:',
    epoch: `1:${String(labels.length)}`,
  } as unknown as never;
}

function context(): Context {
  const fixture = perfFixture();
  const clock = new SystemClock();
  const ids = new TypeIdGenerator(clock);
  const rng = new SeededRng(7);
  const store = new SqliteStore({ db: fixture.connection, clock, logger: silentLogger, ids, rng });
  const repos = makeRepositories({
    db: fixture.db,
    connection: fixture.connection,
    ids,
    rng,
    clock,
  });
  const groupId = fixture.report.groups[0] as GroupId;
  const search = new SqliteMemorySearch({
    db: fixture.db,
    connection: fixture.connection,
    activeSpaceSlug: () => fixture.report.spaceSlug,
  });
  const eligible = eligibleFor(repos, groupId);
  // The group conversation is the first one the generator made.
  const conversationId = (
    fixture.connection
      .prepare(`SELECT id FROM conversations WHERE group_id = ? AND kind = 'group' LIMIT 1`)
      .get(groupId) as { id: string }
  ).id as ConversationId;
  const memoryIds = (
    fixture.connection
      .prepare(`SELECT id FROM memory_items WHERE group_id = ? LIMIT 200`)
      .all(groupId) as { id: string }[]
  ).map((row) => row.id as MemoryId);
  // A query vector taken from a stored one, so KNN searches near a real cluster rather than into
  // empty space — which is the difference between measuring the index and measuring a scan.
  const stored = fixture.connection
    .prepare(`SELECT embedding FROM vec_memory_${fixture.report.spaceSlug} LIMIT 1`)
    .get() as { embedding: Buffer } | undefined;
  const vector = new Float32Array(
    stored === undefined
      ? Array.from({ length: 384 }, () => 1 / Math.sqrt(384))
      : new Float32Array(
          stored.embedding.buffer.slice(
            stored.embedding.byteOffset,
            stored.embedding.byteOffset + stored.embedding.byteLength,
          ),
        ),
  );
  return { fixture, repos, store, search, groupId, conversationId, eligible, memoryIds, vector };
}

/** A term the generator planted, so FTS has something real to find (`02` §3.16.5). */
const NEEDLE = 'perfneedle1';

/**
 * The ingestion row's id counter, at module scope so it survives a repetition.
 *
 * Per-repetition state would restart at one and the second repetition's first insert would collide
 * with the first repetition's — which is what the first run did: *expected the message to be
 * written, got duplicate*. A mutable object rather than a `let`, which `scripts/hygiene/check.ts`
 * refuses in a test file for a related reason.
 */
const ingested = { count: 0 };

const benchmarks: readonly ErasedBench[] = [
  defineBench({
    id: 'B1',
    name: 'ingestion transaction (insert + FTS trigger + enqueue)',
    unit: 'ms',
    // Every budget below is `02` §3.16.4's own column, declared on the row so the number lives
    // where the thing it constrains does and travels into `.bench/results.json`. `pnpm bench
    // --gate` fails on a miss; a trend run only prints it (`11` §3.9.3).
    budget: 3,
    iterations: 200,
    warmup: 20,
    setup: () => {
      const base = context();
      const registry = new JobKindRegistry();
      // The kind an ingestion actually enqueues next (`02` §3.10.1); the payload schema is the
      // owner's, and `extract.conversation` takes a conversation.
      const kind = registry.register('extract.conversation', {
        parse: (value: unknown) => value,
        safeParse: (value: unknown) => ({ success: true as const, data: value }),
      } as never);
      return { ...base, kind };
    },
    run: (ctx) => {
      ingested.count += 1;
      const ordinal = ingested.count;
      ctx.store.write((uow) => {
        expectWritten(
          ctx.repos.messages.insert(
            uow,
            {
              id: `msg_01jb${String(ordinal).padStart(22, '0')}` as never,
              groupId: ctx.groupId,
              conversationId: ctx.conversationId,
              kind: 'member',
              text: `bench message ${String(ordinal)} with some ordinary words in it`,
              sentAt: uow.now,
              receivedAt: uow.now,
            },
            ctx.repos.labels.groupLabels(ctx.groupId).values().next().value as never,
          ),
          'the message',
        );
        ctx.repos.jobs.enqueue(uow, ctx.kind as never, {
          partitionKey: ctx.groupId,
          payload: { conversationId: ctx.conversationId } as never,
        });
      });
    },
  }),

  defineBench({
    id: 'micro:storage.recent-window',
    name: 'recent window, 50 messages (Q-CTX-1)',
    unit: 'ms',
    budget: 5,
    setup: context,
    run: (ctx) => {
      ctx.repos.messages.window({ conversationId: ctx.conversationId, limit: 50 }, ctx.eligible);
    },
  }),

  defineBench({
    id: 'micro:storage.memory-fts-word',
    name: 'memory FTS, word mode (Q-CTX-2)',
    unit: 'ms',
    budget: 20,
    setup: context,
    run: (ctx) => {
      ctx.search.text({
        groupId: ctx.groupId,
        query: NEEDLE,
        mode: 'word',
        limit: 20,
        maxState: 1,
        eligible: ctx.eligible,
      });
    },
  }),

  defineBench({
    id: 'micro:storage.memory-fts-trigram',
    name: 'memory FTS, trigram mode',
    unit: 'ms',
    budget: 30,
    setup: context,
    run: (ctx) => {
      ctx.search.text({
        groupId: ctx.groupId,
        query: NEEDLE,
        mode: 'trigram',
        limit: 20,
        maxState: 1,
        eligible: ctx.eligible,
      });
    },
  }),

  defineBench({
    id: 'micro:storage.message-fts',
    name: 'message FTS, group-scoped (M8-shaped query)',
    unit: 'ms',
    budget: 50,
    setup: () => {
      const base = context();
      // **There is no message-FTS reader yet.** `02` §3.16.4 marks this row "catch-up only", and
      // catch-up is `M8`; the index is maintained by triggers from `M1-T13` but nothing queries it.
      // So this measures the query `02` §3.4 specifies — the scope token, the `MATCH`, the group
      // predicate and the `label_id IN (…)` filter — built with the product's own helpers, which
      // is the closest honest thing to a repository method that does not exist. Named in the
      // benchmark and in the architecture note rather than presented as the real path.
      const labelList = base.eligible as unknown as { ids: readonly number[] };
      const statement = base.fixture.connection.prepare(
        `SELECT m.rid FROM messages_fts
           JOIN messages m ON m.rid = messages_fts.rowid
          WHERE messages_fts MATCH ?
            AND m.group_id = ?
            AND m.label_id IN (${labelList.ids.map(() => '?').join(', ')})
            AND m.redacted_at IS NULL
          ORDER BY bm25(messages_fts) LIMIT 20`,
      );
      return { ...base, statement, args: [...labelList.ids] };
    },
    run: (ctx) => {
      ctx.statement.all(`${scopeToken(ctx.groupId)} AND ${NEEDLE}`, ctx.groupId, ...ctx.args);
    },
  }),

  defineBench({
    id: 'micro:storage.knn-64',
    name: 'KNN k=64, 384-d',
    unit: 'ms',
    budget: 60,
    setup: context,
    run: (ctx) => {
      ctx.search.vector({
        groupId: ctx.groupId,
        vector: ctx.vector,
        k: 64,
        maxState: 1,
        validAt: Temporal.Instant.from('2026-06-01T00:00:00Z'),
        eligible: ctx.eligible,
      });
    },
  }),

  defineBench({
    id: 'micro:storage.hydrate-200',
    name: 'hydrate 200 memories (zod-validated)',
    unit: 'ms',
    budget: 15,
    setup: context,
    run: (ctx) => {
      // `hydrate` is on the memory **search** port rather than the repository (`02` §3.3.9: a
      // trace holds ids, and the reader re-checks eligibility at render time), which is the
      // zod-validated read this row is about.
      ctx.search.hydrate(ctx.memoryIds, ctx.eligible);
    },
  }),

  defineBench({
    id: 'B4',
    name: 'job claim, one round at 10k queued',
    unit: 'ms',
    budget: 5,
    iterations: 100,
    warmup: 10,
    setup: () => {
      const base = context();
      const registry = new JobKindRegistry();
      const kind = registry.register('retention.sweep', {
        parse: (value: unknown) => value,
        safeParse: (value: unknown) => ({ success: true as const, data: value }),
      } as never);
      // 10,000 queued, as the row says. The claim's cost is in the selection window, so a queue
      // with ten rows in it measures the wrong thing entirely.
      for (let batch = 0; batch < 10; batch += 1) {
        base.store.write((uow) => {
          for (let index = 0; index < 1_000; index += 1) {
            base.repos.jobs.enqueue(uow, kind as never, {
              partitionKey: '_instance',
              payload: {} as never,
            });
          }
        });
      }
      return { ...base, kind };
    },
    run: (ctx) => {
      const claimed = ctx.repos.jobs.claim('bench', {
        kinds: ['retention.sweep'],
        max: 25,
        leaseMs: 30_000,
      });
      // Completed, so the next iteration claims fresh rows rather than re-reading leased ones.
      for (const job of claimed) ctx.repos.jobs.complete(job);
    },
  }),

  defineBench({
    id: 'micro:storage.context-share',
    name: 'storage share of a context build (M6-shaped sequence)',
    unit: 'ms',
    // `02` §3.16.4 states this one as "≤ 150 ms **total**" (`01` §11.10's context budget), and
    // this row is the storage share of it. So the budget is loose by construction: it is the
    // ceiling the whole build has to fit in, and `M6`'s own `B2` is what checks the rest of it.
    budget: 150,
    iterations: 50,
    warmup: 5,
    setup: context,
    run: (ctx) => {
      // **`M6` owns the context builder.** `02` §3.16.4's row is the storage *share* of it, so this
      // runs the four reads `05` §3.3 assembles a window from, in order, against the same fixture:
      // the recent window, a memory text search, a KNN search, and the hydrate of what they
      // returned. Summing four separately-measured rows would miss the page-cache interaction
      // between them, which is the part a single budget is actually about.
      ctx.repos.messages.window({ conversationId: ctx.conversationId, limit: 50 }, ctx.eligible);
      const text = ctx.search.text({
        groupId: ctx.groupId,
        query: NEEDLE,
        mode: 'word',
        limit: 20,
        maxState: 1,
        eligible: ctx.eligible,
      });
      const near = ctx.search.vector({
        groupId: ctx.groupId,
        vector: ctx.vector,
        k: 64,
        maxState: 1,
        validAt: Temporal.Instant.from('2026-06-01T00:00:00Z'),
        eligible: ctx.eligible,
      });
      const ids = [...text, ...near].slice(0, 200).map((scored) => scored.ref);
      ctx.search.hydrate(ids, ctx.eligible);
    },
  }),

  defineBench({
    id: 'B5',
    name: 'cold open: key check and migration check',
    unit: 'ms',
    budget: 300,
    // Twenty, because each one opens and closes a 687 MB file and the figure is dominated by the
    // operating system's page cache rather than by anything this process does.
    iterations: 20,
    warmup: 2,
    setup: () => ({ path: perfFixture().path }),
    run: (ctx) => {
      // `02` §3.16.4's cold-start share: the open, the key check (inside `openDatabase`) and the
      // migration check. Not the whole of `01` §11.10's 3-second cold start — that is `M3`'s
      // server boot — but the storage part of it, which is the part that grows with the database.
      const opened = openDatabase({ path: ctx.path, key: null, role: 'cli', loadVec: true });
      try {
        appliedMigrations(opened.db);
      } finally {
        opened.db.close();
      }
    },
  }),

  defineBench({
    id: 'micro:storage.retention-chunk',
    name: 'retention chunk, 1000 messages',
    unit: 'ms',
    budget: 50,
    iterations: 20,
    warmup: 2,
    setup: () => {
      const base = context();
      // Mark a slice of the group's messages as expired, so the sweep has exactly the 1,000 rows
      // per chunk `02` §3.13.2 deletes.
      base.fixture.connection
        .prepare(
          `UPDATE messages SET retention_until = 1
             WHERE rid IN (SELECT rid FROM messages WHERE group_id = ? LIMIT 25000)`,
        )
        .run(base.groupId);
      return base;
    },
    run: (ctx) => {
      ctx.store.write((uow) => {
        ctx.repos.messages.deleteExpired(
          uow,
          undefined,
          Temporal.Instant.from('2027-01-01T00:00:00Z'),
          1_000,
        );
      });
    },
  }),
];

export default benchmarks;
