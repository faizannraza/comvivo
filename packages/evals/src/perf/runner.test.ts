/**
 * The benchmark harness, measured against work whose duration is known (`11` §3.9.2).
 *
 * A harness is a measuring instrument, and the only honest way to test one is to give it something
 * whose answer you already know: a function that sleeps a fixed time, a function that counts its
 * own calls, a repetition that is deliberately slower than the others. The assertions are about
 * the **protocol** — warm-up excluded, N iterations per repetition, five repetitions, median of
 * their percentiles — rather than about the numbers, which belong to whatever machine runs this.
 */
import { describe, expect, it } from 'vitest';
import type { BenchEnv } from './bench-result.js';
import { BenchResultSchema } from './bench-result.js';
import { type BenchDefinition, defineBench, measure, median, runSuite } from './runner.js';

const ENV: BenchEnv = {
  runner: 'test',
  arch: 'x64',
  cpu: 'test cpu',
  node: 'v26.13.0',
  profile: 'dev',
};
const OPTIONS = { env: ENV, gitSha: '0123456789ab' };

/**
 * A `nanos()` that returns the given durations, one per iteration.
 *
 * Each iteration reads the clock twice (before and after `run`), so the sequence is built as
 * cumulative pairs: the difference the runner records is exactly the duration asked for.
 */
function scriptedNanos(durationsMs: readonly number[]): () => bigint {
  let at = 0n;
  let index = 0;
  let reading = 0;
  return () => {
    if (reading === 1) {
      // The closing read of an iteration: advance by that iteration's duration.
      const ms = durationsMs[index % durationsMs.length] ?? 0;
      at += BigInt(Math.round(ms * 1e6));
      index += 1;
      reading = 0;
      return at;
    }
    reading = 1;
    return at;
  };
}

/** Busy-wait, because a timer's resolution is coarser than the thing being measured. */
function spin(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Intentionally empty: the point is to occupy the clock.
  }
}

describe('the protocol (11 §3.9.2)', () => {
  it('runs warm-up, then N iterations, five times', async () => {
    const calls = { warmupAndIterations: 0, setups: 0, teardowns: 0 };
    const definition: BenchDefinition<{ id: number }> = {
      id: 'micro:protocol',
      name: 'counts its calls',
      unit: 'ms',
      iterations: 10,
      warmup: 3,
      setup: () => {
        calls.setups += 1;
        return { id: calls.setups };
      },
      teardown: () => {
        calls.teardowns += 1;
      },
      run: () => {
        calls.warmupAndIterations += 1;
      },
    };
    const result = await measure(definition, OPTIONS);

    // Five repetitions of (3 warm-up + 10 timed).
    expect(calls.warmupAndIterations).toBe(5 * 13);
    // A context per repetition, so a benchmark can start from a clean database each time — and
    // every one is torn down, including when the run throws.
    expect(calls.setups).toBe(5);
    expect(calls.teardowns).toBe(5);
    expect(result.repetitions).toBe(5);
    expect(result.iterations).toBe(10);
  });

  it('tears down even when an iteration throws', async () => {
    const calls = { teardowns: 0 };
    const definition: BenchDefinition<void> = {
      id: 'micro:throws',
      name: 'throws',
      unit: 'ms',
      iterations: 1,
      warmup: 0,
      teardown: () => {
        calls.teardowns += 1;
      },
      run: () => {
        throw new Error('the benchmark itself failed');
      },
    };
    await expect(measure(definition, OPTIONS)).rejects.toThrow(/the benchmark itself failed/);
    // Without this, one failing benchmark leaks a database handle per repetition and the suite
    // after it measures a machine under pressure.
    expect(calls.teardowns).toBe(1);
  });

  it('excludes the warm-up from the measurement', async () => {
    // The warm-up is slow and the iterations are fast. If the warm-up were timed, the percentiles
    // would be dominated by it — which is the mistake this part of the protocol prevents, because
    // V8 tiers up and the first calls of anything measure the interpreter.
    const warmupSpinMs = 12;
    const state = { call: 0 };
    const result = await measure(
      {
        id: 'micro:warmup',
        name: 'slow warm-up, fast iterations',
        unit: 'ms',
        iterations: 5,
        warmup: 2,
        repetitions: 1,
        run: () => {
          state.call += 1;
          spin(state.call <= 2 ? warmupSpinMs : 0.1);
        },
      },
      OPTIONS,
    );
    // Against the warm-up's own duration rather than an arbitrary number: a leaked warm-up would
    // put the p99 at or above 12 ms, and anything below that is a measurement of the fast
    // iterations. Phrased this way, the assertion says what it is checking and does not also
    // measure how busy the machine is.
    expect(result.p99).toBeLessThan(warmupSpinMs);
  });

  it('reports the p95 for a latency benchmark and a rate for a throughput one', async () => {
    const latency = await measure(
      {
        id: 'micro:latency',
        name: 'two milliseconds',
        unit: 'ms',
        iterations: 5,
        warmup: 1,
        repetitions: 3,
        run: () => spin(2),
      },
      OPTIONS,
    );
    // `01` §11.10 states every budget as a p95, so that is what `value` carries.
    expect(latency.value).toBe(latency.p95);
    expect(latency.value).toBeGreaterThan(1.5);

    // **The ordering assertion is gone, and the clock is injected instead.** Three versions of
    // "more work reads as more time" failed under load: an absolute bound at the M1 gate
    // (15.97 ms for a 2 ms spin), a ratio at `M2-T4` (8.03 against 5.71), and the ordering itself
    // inverting at `M2-T6` (10.38 ms measured for an 8 ms spin against 12.75 ms for a 2 ms one,
    // during a full `pnpm verify`). None of them could work: a busy spin for 2 ms of wall time
    // takes **at least** 2 ms with no upper bound, because the OS may deschedule it — so the
    // lighter benchmark's p95 can exceed the heavier one's while the instrument is perfect.
    //
    // "More work reads as more time" is a property of the scheduler. What this harness is
    // responsible for is the arithmetic, and `the arithmetic, on an injected clock` below asserts
    // it exactly. Fourth and last patch to this assertion.

    const throughput = await measure(
      {
        id: 'micro:throughput',
        name: 'ten units per iteration',
        unit: 'ops/s',
        iterations: 5,
        warmup: 1,
        repetitions: 3,
        opsPerIteration: 10,
        run: () => spin(1),
      },
      OPTIONS,
    );
    // Ten operations per iteration at about 1 ms each: on the order of 10,000/s. The assertion is
    // the *shape* — a rate derived from the median, not a percentile — with a wide band, because
    // the number belongs to the machine.
    expect(throughput.value).toBeGreaterThan(1_000);
    expect(throughput.value).toBeLessThan(100_000);
    expect(throughput.value).not.toBe(throughput.p95);
  });

  it('produces a result its own schema accepts', async () => {
    const result = await measure(
      { id: 'micro:schema', name: 'nothing', unit: 'ms', iterations: 2, warmup: 0, run: () => {} },
      OPTIONS,
    );
    // The schema is the boundary (`11` §4.5): a result is written to JSON and read on another
    // machine, so the harness producing something its own reader would reject is a real failure.
    const parsed = BenchResultSchema.safeParse(result);
    expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      [],
    );
  });
});

describe('the median (11 §3.9.2: "the median of the repetitions")', () => {
  it('is the middle value, and the lower middle for an even count', () => {
    expect(median([3])).toBe(3);
    expect(median([5, 1, 3])).toBe(3);
    // The lower of the two middles rather than their mean: a benchmark figure should be a number
    // the machine actually produced.
    expect(median([1, 2, 3, 4])).toBe(2);
    expect(median([10, 1])).toBe(1);
  });

  it('refuses an empty list rather than inventing a zero', () => {
    expect(() => median([])).toThrow(/median of nothing/);
  });

  it('survives one bad repetition, which is why there are five', async () => {
    // One repetition takes ten times as long as the other four — a noisy neighbour on a shared
    // runner, which is exactly the event the median is chosen to absorb. A mean would carry it.
    const state = { repetition: 0 };
    const result = await measure(
      {
        id: 'micro:noisy',
        name: 'one slow repetition in five',
        unit: 'ms',
        iterations: 3,
        warmup: 0,
        repetitions: 5,
        setup: () => {
          state.repetition += 1;
          return state.repetition;
        },
        run: (repetition: number) => spin(repetition === 3 ? 20 : 1),
      },
      OPTIONS,
    );
    expect(result.value).toBeLessThan(10);
  });
});

describe('runSuite', () => {
  it('runs in order and shares one environment and commit', async () => {
    const order: string[] = [];
    const define = (name: string) =>
      defineBench({
        id: `micro:${name}`,
        name,
        unit: 'ms',
        iterations: 1,
        warmup: 0,
        repetitions: 1,
        run: () => {
          order.push(name);
        },
      });

    const results = await runSuite([define('first'), define('second')], OPTIONS);
    // Sequential, because two benchmarks running at once measure each other.
    expect(order).toEqual(['first', 'second']);
    expect(results.map((result) => result.id)).toEqual(['micro:first', 'micro:second']);
    // One environment and one commit for the suite: results that disagreed about which machine
    // they came from would be impossible to compare with each other.
    expect(new Set(results.map((result) => result.env.runner)).size).toBe(1);
    expect(new Set(results.map((result) => result.gitSha)).size).toBe(1);
  });

  it('scales the work down, for a plumbing check', async () => {
    const calls = { count: 0 };
    const results = await runSuite(
      [
        defineBench({
          id: 'micro:scaled',
          name: 'scaled',
          unit: 'ms',
          iterations: 100,
          warmup: 100,
          repetitions: 5,
          run: () => {
            calls.count += 1;
          },
        }),
      ],
      { ...OPTIONS, scale: 0.01 },
    );
    // `--scale` exists so a test can prove the plumbing without spending a minute on it: one
    // iteration, one warm-up call, one repetition.
    expect(calls.count).toBe(2);
    expect(results[0]?.iterations).toBe(1);
    expect(results[0]?.repetitions).toBe(1);
  });
});

describe('the arithmetic, on an injected clock', () => {
  const latencyDefinition = {
    id: 'micro:exact',
    name: 'scripted durations',
    unit: 'ms',
    iterations: 5,
    warmup: 0,
    repetitions: 1,
    run: () => {},
  } as const;

  it('reports the p50, p95 and p99 of the recorded durations', async () => {
    // Five iterations of 1–5 ms. The HDR histogram's percentiles are exact to its precision at
    // this scale, so the assertion is on the numbers rather than on a bound.
    const result = await measure(latencyDefinition, {
      ...OPTIONS,
      nanos: scriptedNanos([1, 2, 3, 4, 5]),
    });
    expect(result.p50).toBeCloseTo(3, 1);
    expect(result.p95).toBeCloseTo(5, 1);
    expect(result.p99).toBeCloseTo(5, 1);
    // `01` §11.10 states every budget as a p95, so that is what `value` carries.
    expect(result.value).toBe(result.p95);
    expect(result.iterations).toBe(5);
    expect(result.repetitions).toBe(1);
  });

  it('takes the median across repetitions, not the mean', async () => {
    // Three repetitions whose p95s are 2, 50 and 3 ms. The median is 3; a mean would be ~18 and a
    // single slow repetition would dominate every budget verdict.
    const result = await measure(
      { ...latencyDefinition, iterations: 1, repetitions: 3 },
      { ...OPTIONS, nanos: scriptedNanos([2, 50, 3]) },
    );
    expect(result.p95).toBeCloseTo(3, 1);
  });

  it('converts a median iteration to ops per second for a throughput benchmark', async () => {
    // 2 ms per iteration, 10 operations each → 5,000 ops/s. A rate is derived from the **median**
    // and not the tail, because `B4`'s "≥ 500 jobs/s" is not a statement about the slow end.
    const result = await measure(
      {
        ...latencyDefinition,
        id: 'micro:exact-rate',
        unit: 'ops/s',
        opsPerIteration: 10,
        iterations: 3,
      },
      { ...OPTIONS, nanos: scriptedNanos([2, 2, 2]) },
    );
    expect(result.value).toBeCloseTo(5000, -1);
    expect(result.p50).toBeCloseTo(2, 1);
  });

  it('records a zero-duration iteration as the clock floor rather than refusing it', async () => {
    // `RecordableHistogram.record` refuses 0, and an operation faster than the clock's resolution
    // is better described as the floor than as an error.
    const result = await measure(latencyDefinition, {
      ...OPTIONS,
      nanos: scriptedNanos([0, 0, 0, 0, 0]),
    });
    expect(result.p50).toBeGreaterThan(0);
    expect(result.p50).toBeLessThan(0.001);
  });
});
