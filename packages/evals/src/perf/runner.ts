/**
 * The benchmark harness (`11` §3.9.2).
 *
 * ## Why this exists rather than `vitest bench`
 *
 * `11` §3.9.2 names the Vitest `bench` fixture for micro-benchmarks. **Vitest 5.0.5 exposes no
 * such API** — re-verified at implementation time, not inherited from the note `M0` left: `bench`
 * is not exported from `vitest`, `vitest/runtime` or `vitest/node`, is not injected as a global
 * with `globals: true`, and there is no `@vitest/bench` package. So `M1-T32` builds the harness,
 * which the M0 note already judged the likely answer for a second reason that has nothing to do
 * with availability: every budget in `01` §11.10 and `11` §3.9.1 is a **percentile over a
 * realistic workload**, and a micro-benchmark runner reports ops/s over a tight loop. One harness
 * that measures both the way the budgets are written beats two that measure neither.
 *
 * ## The protocol, and why each part is there
 *
 * `11` §3.9.2: "a warm-up, then N iterations, then 5 repetitions, and reports the median of the
 * repetitions."
 *
 *  - **Warm-up** because V8 tiers up. The first few hundred calls of anything measure the
 *    interpreter, not the code.
 *  - **N iterations into a histogram** because the budgets are p95s. A mean hides the tail that
 *    every one of those budgets is about.
 *  - **Five repetitions, median of their percentiles** because a single repetition inherits
 *    whatever the machine was doing during it. The median of five is the cheapest statistic that
 *    survives one bad neighbour on a shared runner.
 *
 * `perf_hooks.createHistogram()` rather than an array of numbers: it is an HDR histogram, so the
 * memory is bounded whatever N is, and the percentiles come from the same implementation Node uses
 * for its own event-loop metrics.
 */
import { createHistogram, type RecordableHistogram } from 'node:perf_hooks';
import { hrtime } from 'node:process';
import type { BenchEnv, BenchResult } from './bench-result.js';

/** One benchmark. `Ctx` is whatever `setup` builds and `run` needs. */
export interface BenchDefinition<Ctx = void> {
  readonly id: BenchResult['id'];
  readonly name: string;
  readonly unit: BenchResult['unit'];
  /** Built once per repetition, so a benchmark can start from a clean database each time. */
  readonly setup?: () => Promise<Ctx> | Ctx;
  readonly teardown?: (context: Ctx) => Promise<void> | void;
  /** One iteration. Timed. */
  readonly run: (context: Ctx) => Promise<void> | void;
  /** Iterations per repetition. */
  readonly iterations?: number;
  /** Untimed calls before the first measurement. */
  readonly warmup?: number;
  readonly repetitions?: number;
  /**
   * Units of work one iteration performs, for a throughput benchmark.
   *
   * `B4` enqueues jobs in batches, so one iteration is many jobs; without this the number would be
   * "iterations per second" and the budget is in jobs per second.
   */
  readonly opsPerIteration?: number;
  /**
   * The budget this row is checked against, in `unit` (`11` §3.9.1, `02` §3.16.4).
   *
   * On the definition, so the number lives next to the thing it constrains and travels into the
   * result. A row with no budget is a trend row, which is what `11` §3.9.1's µ line is.
   */
  readonly budget?: number;
}

/**
 * What a run needs beyond the benchmark itself.
 *
 * `env` and `gitSha` are **required**, not defaulted: a result that cannot say which machine and
 * which commit produced it is a point on a chart nobody can attribute, and a default would make
 * that the easy path. `currentEnv()` builds the first; `scripts/bench/run.ts` resolves the second,
 * because reading git is a subprocess and this package may not spawn one (`08` PSC-8).
 */
export interface BenchOptions {
  readonly env: BenchEnv;
  readonly gitSha: string;
  /** Scale the work down, for the tests that prove this harness rather than measure anything. */
  readonly scale?: number;
  /**
   * The nanosecond clock, injected (`M2-T6`). Defaults to `hrtime.bigint`.
   *
   * A measuring instrument that reads the wall clock directly cannot be tested — `01` §11.4 says
   * exactly that about every other clock in this repository, and this one was the exception. The
   * cost of the exception was three separate load-sensitive failures of one assertion: an absolute
   * bound at the M1 gate (15.97 ms for a 2 ms spin), a ratio at `M2-T4` (8.03 against 5.71), and
   * then the *ordering itself* inverting at `M2-T6` (10.38 ms for an 8 ms spin against 12.75 ms
   * for a 2 ms one, under a full `pnpm verify`).
   *
   * Each patch made the assertion weaker, and none of them could work: a busy spin for 2 ms of
   * wall time takes ≥ 2 ms **and has no upper bound**, because the OS may deschedule it. "More
   * work reads as more time" is a property of the scheduler, not of this code. With the clock
   * injected, the arithmetic this function is actually responsible for — the histogram, the
   * percentiles, the median across repetitions, the ops/s conversion — is asserted exactly, and
   * the real-clock test only has to show it runs.
   */
  readonly nanos?: () => bigint;
}

const DEFAULTS = { iterations: 200, warmup: 50, repetitions: 5 } as const;

/** Nanoseconds per millisecond, named because the conversions below are easy to misread. */
const NS_PER_MS = 1e6;

/** The percentiles one repetition produced. */
interface Repetition {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

/** The median of a list, which for an even length is the lower of the two middles. */
export function median(values: readonly number[]): number {
  if (values.length === 0) throw new RangeError('the median of nothing is not a number');
  const sorted = [...values].toSorted((a, b) => a - b);
  // The **lower** middle for an even count, rather than the mean of the two: a benchmark figure
  // should be a number the machine actually produced, not an average of two it did.
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

function percentilesOf(histogram: RecordableHistogram): Repetition {
  return {
    p50: histogram.percentile(50) / NS_PER_MS,
    p95: histogram.percentile(95) / NS_PER_MS,
    p99: histogram.percentile(99) / NS_PER_MS,
  };
}

/**
 * Run one benchmark and return its result.
 *
 * The timing is `options.nanos()` around each iteration — `hrtime.bigint()` unless a test injects
 * one — recorded in nanoseconds. A duration of zero is recorded as 1 ns, because
 * `RecordableHistogram.record` refuses zero and an operation that takes less than the clock's
 * resolution is better described as "the floor" than as an error.
 */
export async function measure<Ctx>(
  definition: BenchDefinition<Ctx>,
  options: BenchOptions,
): Promise<BenchResult> {
  const scale = options.scale ?? 1;
  const iterations = Math.max(
    1,
    Math.round((definition.iterations ?? DEFAULTS.iterations) * scale),
  );
  const warmup = Math.max(0, Math.round((definition.warmup ?? DEFAULTS.warmup) * scale));
  const repetitions = Math.max(
    1,
    Math.round((definition.repetitions ?? DEFAULTS.repetitions) * scale),
  );

  // Wrapped rather than passed by reference: `unbound-method` is right that detaching
  // `hrtime.bigint` from `hrtime` is the shape of a `this` bug, even though this particular method
  // does not use one.
  const nanos = options.nanos ?? ((): bigint => hrtime.bigint());

  const reps: Repetition[] = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const context = (await definition.setup?.()) as Ctx;
    try {
      for (let i = 0; i < warmup; i += 1) await definition.run(context);
      const histogram = createHistogram();
      for (let i = 0; i < iterations; i += 1) {
        const started = nanos();
        await definition.run(context);
        const elapsed = Number(nanos() - started);
        histogram.record(Math.max(elapsed, 1));
      }
      reps.push(percentilesOf(histogram));
    } finally {
      await definition.teardown?.(context);
    }
  }

  const p50 = median(reps.map((rep) => rep.p50));
  const p95 = median(reps.map((rep) => rep.p95));
  const p99 = median(reps.map((rep) => rep.p99));
  return {
    id: definition.id,
    name: definition.name,
    unit: definition.unit,
    // The p95 for a latency budget, because that is how every budget in `01` §11.10 is written.
    // Throughput is derived from the median iteration instead: ops per second is a rate, and the
    // tail of a rate is not what `B4`'s "≥ 500 jobs/s" means.
    value: definition.unit === 'ops/s' ? throughput(p50, definition.opsPerIteration ?? 1) : p95,
    p50,
    p95,
    p99,
    range: `p50 ${String(round(p50))} / p99 ${String(round(p99))} ms`,
    env: options.env,
    gitSha: options.gitSha,
    repetitions,
    iterations,
    ...(definition.budget === undefined ? {} : { budget: definition.budget }),
  };
}

/** Operations per second from a per-iteration median in milliseconds. */
function throughput(perIterationMs: number, opsPerIteration: number): number {
  if (perIterationMs <= 0) return 0;
  return (opsPerIteration * 1000) / perIterationMs;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * A benchmark with its context type erased, so one suite can hold several.
 *
 * The alternative was `BenchDefinition<never>[]` with a cast per entry, which is how the first
 * version read — and it makes every `run(context)` parameter `never`, so the body of each
 * benchmark stops typechecking. The context type is an implementation detail of one benchmark and
 * no business of the list that holds it, which is exactly what an existential is for: `defineBench`
 * closes over it and hands back something with no type parameter at all.
 */
export interface ErasedBench {
  readonly id: BenchResult['id'];
  readonly name: string;
  readonly unit: BenchResult['unit'];
  readonly budget?: number;
  readonly measure: (options: BenchOptions) => Promise<BenchResult>;
}

/** Erase a definition's context type. What a `*.bench.ts` file exports, one per entry. */
export function defineBench<Ctx>(definition: BenchDefinition<Ctx>): ErasedBench {
  return {
    id: definition.id,
    name: definition.name,
    unit: definition.unit,
    ...(definition.budget === undefined ? {} : { budget: definition.budget }),
    measure: async (options: BenchOptions) => measure(definition, options),
  };
}

/**
 * Run a suite, in order, and collect the results.
 *
 * Sequential on purpose: two benchmarks running at once measure each other. The environment and
 * the commit are resolved **once** and shared, so a suite cannot produce results that disagree
 * about which machine they came from.
 */
export async function runSuite(
  benches: readonly ErasedBench[],
  options: BenchOptions,
): Promise<readonly BenchResult[]> {
  const results: BenchResult[] = [];
  for (const bench of benches) results.push(await bench.measure(options));
  return results;
}
