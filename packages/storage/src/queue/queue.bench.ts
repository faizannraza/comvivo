/**
 * The queue's micro-benchmark baseline (`11` §3.9.1's µ row, `14`'s `M1-T32`).
 *
 * Three numbers, recorded and **non-gating**: one enqueue, one claim of a batch, and a full
 * enqueue → claim → complete round trip as a throughput figure. `11` §3.9.1's `B4` ("≥ 500
 * jobs/s") is the macro version of the third, over a file-backed database with a real worker loop;
 * `M1-T33` owns that. This is the baseline that makes a later regression visible — a trend line
 * from `M1`, rather than a number that first exists at the release gate.
 *
 * **In-memory, deliberately.** A micro-benchmark on a file-backed database measures the host's
 * disk and its page cache, which on a shared CI runner is the loudest thing in the measurement.
 * `createTestDb` gives the same migrated schema from a page image, so what is left is the SQL, the
 * drizzle layer and the transaction wrapper — the parts this repository can regress.
 *
 * Run with `pnpm bench --filter queue`.
 */
import { SystemClock, TypeIdGenerator, z } from '@comvivo/shared';
import { SeededRng } from '@comvivo/shared/testing';
import { defineBench, type ErasedBench } from '../../../evals/src/perf/index.js';
import { makeDb } from '../db/drizzle.js';
import { SqliteStore } from '../db/tx.js';
import { silentLogger } from '../repos/testing/harness.js';
import { seedGroup } from '../schema/testing/migrated-db.js';
import { createTestDb } from '../testing/test-db.js';
import { JobKindRegistry } from './kinds.js';
import { SqliteJobQueue } from './queue.js';

/** One job's payload: the smallest thing that is still validated on enqueue and on claim. */
const PayloadSchema = z.strictObject({ n: z.int().min(0) });

/** The kind used throughout: instance-scoped, so the fixture needs no group for the partition. */
const KIND = 'retention.sweep';

interface Context {
  readonly close: () => void;
  readonly store: SqliteStore;
  readonly queue: SqliteJobQueue;
  readonly definition: ReturnType<JobKindRegistry['register']>;
  /** A counter, so every enqueue is a distinct row rather than an idempotent no-op. */
  readonly next: () => number;
}

function openContext(): Context {
  const db = createTestDb({ seed: (fresh) => seedGroup(fresh, 'bnch') });
  const drizzle = makeDb(db);
  // The **system** clock, not a virtual one: `TypeIdGenerator` allows 4,096 ids per millisecond
  // and refuses the 4,097th rather than letting ids stop sorting by creation order (invariants I6
  // and I7). A frozen clock therefore cannot enqueue more than 4,096 jobs — which this benchmark
  // does on its second repetition. Real time is also the honest choice here: the measurement is of
  // real work.
  const clock = new SystemClock();
  const ids = new TypeIdGenerator(clock);
  const rng = new SeededRng(7);
  const store = new SqliteStore({ db, clock, logger: silentLogger, ids, rng });
  const registry = new JobKindRegistry();
  const definition = registry.register(KIND, PayloadSchema);
  const counter = { value: 0 };
  return {
    close: () => db.close(),
    store,
    queue: new SqliteJobQueue({ db: drizzle, clock, ids, rng }),
    definition,
    next: () => {
      counter.value += 1;
      return counter.value;
    },
  };
}

/** Enqueue `count` jobs in one transaction. */
function fill(context: Context, count: number): void {
  context.store.write((uow) => {
    for (let i = 0; i < count; i += 1) {
      context.queue.enqueue(uow, context.definition as never, {
        partitionKey: '_instance',
        payload: { n: context.next() } as never,
      });
    }
  });
}

const CLAIM_BATCH = 25;

const benchmarks: readonly ErasedBench[] = [
  defineBench({
    id: 'micro:queue.enqueue',
    name: 'enqueue one job',
    unit: 'ms',
    setup: openContext,
    teardown: (context) => {
      context.close();
    },
    run: (context) => {
      fill(context, 1);
    },
  }),
  defineBench({
    id: 'micro:queue.claim',
    name: `claim a batch of ${String(CLAIM_BATCH)}`,
    unit: 'ms',
    // Pre-filled with more than the iterations will claim, so no iteration measures an empty
    // queue — a claim that finds nothing is a different query plan and would flatten the figure.
    setup: () => {
      const context = openContext();
      fill(context, 200 * CLAIM_BATCH + CLAIM_BATCH);
      return context;
    },
    teardown: (context) => {
      context.close();
    },
    iterations: 200,
    warmup: 20,
    run: (context) => {
      context.queue.claim('bench-worker', {
        kinds: [KIND],
        max: CLAIM_BATCH,
        leaseMs: 30_000,
      });
    },
  }),
  defineBench({
    id: 'micro:queue.roundtrip',
    name: 'enqueue, claim and complete one job',
    unit: 'ops/s',
    // `11` §3.9.1's `B4` floor, applied one layer down: the whole queue — worker loop, handler
    // dispatch, retries — has to deliver 500 jobs/s, so the storage round trip underneath it must
    // clear at least that. `B4` itself arrives with `M3`'s worker; this keeps the floor honest
    // until then rather than leaving the fastest part of the path unchecked.
    budget: 500,
    setup: openContext,
    teardown: (context) => {
      context.close();
    },
    iterations: 100,
    warmup: 20,
    run: (context) => {
      fill(context, 1);
      const [claimed] = context.queue.claim('bench-worker', {
        kinds: [KIND],
        max: 1,
        leaseMs: 30_000,
      });
      if (claimed === undefined) throw new Error('the queue returned nothing to complete');
      context.queue.complete(claimed);
    },
  }),
];

export default benchmarks;
