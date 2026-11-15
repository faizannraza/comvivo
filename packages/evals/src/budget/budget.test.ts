/**
 * `EvalBudgetGuard` (`11` §3.8.4; `M2-T19`).
 *
 * The guard exists so a live run cannot overspend somebody's account without anyone noticing, so
 * the tests are about the three ways that could still happen: a running total that admits a
 * scenario it cannot afford, a judge call charged to the wrong share, and a truncated run reported
 * as a pass.
 */
import { describe, expect, it } from 'vitest';
import { EvalBudgetGuard, isGreen } from './guard.js';
import { NIGHTLY_SHARES, NIGHTLY_TOTAL_MICROS, SMOKE_CAP_MICROS, shareFor } from './prices.js';

/** A clock the test drives, so the time cap is assertable. */
function clock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function guard(capMicros: number, openingEstimateMicros = 100_000) {
  const time = clock();
  return {
    time,
    guard: new EvalBudgetGuard({
      share: { job: 'test', capMicros },
      openingEstimateMicros,
      nowMs: time.now,
    }),
  };
}

describe('the share table (11 §3.8.4)', () => {
  it('sums to the stated total', () => {
    // Asserted against `11` §3.8.4's own figure rather than derived from the rows, so a row edited
    // without updating the total fails here instead of silently moving the cap.
    const total = NIGHTLY_SHARES.reduce((sum, share) => sum + share.capMicros, 0);
    expect(total).toBe(NIGHTLY_TOTAL_MICROS);
  });

  it('has every job the table names', () => {
    expect(NIGHTLY_SHARES.map((share) => share.job)).toEqual([
      'economy',
      'balanced',
      'best',
      'openai',
      'local',
      'extraction-retrieval',
      'judges',
    ]);
  });

  it('bounds the local job by time and not by money', () => {
    // A local model costs nothing and can run forever, so money is the wrong bound.
    const local = shareFor('local');
    expect(local?.capMicros).toBe(0);
    expect(local?.capMinutes).toBe(90);
    // And no paid job has a time cap: it would truncate a run still inside its budget, which
    // `11` §3.8.4 counts as yellow — so it must not happen for a reason that is not the money.
    for (const share of NIGHTLY_SHARES.filter((entry) => entry.capMicros > 0)) {
      expect(share.capMinutes, share.job).toBeUndefined();
    }
  });

  it('keeps the smoke cap far below any nightly share', () => {
    expect(SMOKE_CAP_MICROS).toBeLessThan(
      Math.min(...NIGHTLY_SHARES.filter((s) => s.capMicros > 0).map((s) => s.capMicros)),
    );
  });

  it('returns nothing for a job it does not know', () => {
    expect(shareFor('not-a-job')).toBeUndefined();
  });
});

describe('admission projects rather than measures', () => {
  it('admits one scenario at a time until it has a real figure', () => {
    // The failure a running total cannot see: with nothing completed, `spent` and `inFlight` are
    // both zero, so a projection built only on `spent` would wave through every scenario at once
    // and discover the overspend afterwards.
    const { guard: g } = guard(1_000_000);
    expect(g.canStart()).toBe(true);
    expect(g.canStart()).toBe(false);
    g.finish({ scenario: 's1', costMicros: 50_000, judge: false });
    // Now there is a mean, so it can look ahead properly.
    expect(g.canStart()).toBe(true);
  });

  it('refuses when the projection would exceed the cap, not when the spend does', () => {
    const { guard: g } = guard(100_000);
    // One scenario at 60k: spent 60k, under the 100k cap. A counter would admit another.
    expect(g.canStart()).toBe(true);
    g.finish({ scenario: 's1', costMicros: 60_000, judge: false });
    // 60k spent + 60k estimated = 120k > 100k, so the next one is refused **before** it runs.
    expect(g.canStart()).toBe(false);
    expect(g.state().outcome).toBe('budget_truncated');
  });

  it('uses the running mean, so a cheap run admits more', () => {
    const { guard: g } = guard(1_000_000, 500_000);
    expect(g.canStart()).toBe(true);
    g.finish({ scenario: 's1', costMicros: 1_000, judge: false });
    // The opening estimate was 500k; the real figure is 1k, so the mean collapses and many more
    // scenarios fit.
    expect(g.estimateMicros()).toBe(1_000);
    let admitted = 0;
    while (g.canStart() && admitted < 50) admitted += 1;
    expect(admitted).toBe(50);
  });

  it('returns a reservation when a scenario cost less than estimated', () => {
    // A scenario that under-spends must give the difference back, or the budget stays reserved
    // against work that already finished and the run truncates early.
    const { guard: g } = guard(300_000, 100_000);
    expect(g.canStart()).toBe(true);
    g.finish({ scenario: 's1', costMicros: 10_000, judge: false });
    expect(g.state().inFlightMicros).toBe(0);
    expect(g.state().spentMicros).toBe(10_000);
  });
});

describe('judge calls are billed to the judges share', () => {
  it('does not count a judge call against the preset under test', () => {
    // `11` §3.8.4. Folding grading costs into a preset's share would make the cheap presets look
    // worse than they are, because they run more scenarios and so are graded more.
    const { guard: g } = guard(100_000);
    expect(g.canStart()).toBe(true);
    g.finish({ scenario: 's1', costMicros: 90_000, judge: true });
    expect(g.state().spentMicros).toBe(0);
    // And the judge call is not in the mean either, so it cannot distort the projection.
    expect(g.estimateMicros()).toBe(100_000);
  });

  it('records the judge cost for the report even though it is not charged here', () => {
    const { guard: g } = guard(100_000);
    g.canStart();
    g.finish({ scenario: 's1', costMicros: 90_000, judge: true });
    expect(g.costs()).toEqual([{ scenario: 's1', costMicros: 90_000, judge: true }]);
  });
});

describe('the time cap', () => {
  it('stops a zero-money job on the clock', () => {
    const time = clock();
    const g = new EvalBudgetGuard({
      share: { job: 'local', capMicros: 0, capMinutes: 90 },
      openingEstimateMicros: 0,
      nowMs: time.now,
    });
    expect(g.canStart()).toBe(true);
    time.advance(89 * 60_000);
    expect(g.canStart()).toBe(true);
    time.advance(2 * 60_000);
    expect(g.canStart()).toBe(false);
    expect(g.state().outcome).toBe('time_truncated');
  });

  it('never bounds a zero-money job by money', () => {
    const time = clock();
    const g = new EvalBudgetGuard({
      share: { job: 'local', capMicros: 0, capMinutes: 90 },
      openingEstimateMicros: 0,
      nowMs: time.now,
    });
    // A cap of zero means money is not this job's bound, not that it may spend nothing — so many
    // scenarios are admitted in a row.
    let admitted = 0;
    while (g.canStart() && admitted < 20) admitted += 1;
    expect(admitted).toBe(20);
  });
});

describe('a truncated run is yellow, not green', () => {
  it('reports the three outcomes distinctly', () => {
    expect(isGreen('completed')).toBe(true);
    // The whole point: a suite that stopped early did not measure what it claims to measure.
    expect(isGreen('budget_truncated')).toBe(false);
    expect(isGreen('time_truncated')).toBe(false);
  });

  it('marks the outcome when the first scenario is turned away, not at the end', () => {
    // The outcome is a fact about the run from that moment. Deferring it would let a caller report
    // green until the very last line.
    const { guard: g } = guard(100_000);
    g.canStart();
    g.finish({ scenario: 's1', costMicros: 99_000, judge: false });
    expect(g.state().outcome).toBe('completed');
    expect(g.canStart()).toBe(false);
    expect(g.state().outcome).toBe('budget_truncated');
  });

  it('counts what it admitted and what it refused', () => {
    const { guard: g } = guard(100_000);
    g.canStart();
    g.finish({ scenario: 's1', costMicros: 99_000, judge: false });
    g.canStart();
    g.canStart();
    expect(g.state()).toMatchObject({ admitted: 1, refused: 2, completed: 1 });
  });
});

describe('recording usage directly', () => {
  it('sums a turn’s iterations through the caller’s pricing function', () => {
    // The shape `M5`'s nightly runner has: iterations from the gateway and `costIteration` from
    // the models package, rather than a total somebody computed on the way.
    const { guard: g } = guard(1_000_000);
    g.canStart();
    g.finishWithUsage(
      's1',
      [
        {
          model: 'm',
          kind: 'message',
          input: 10,
          cacheRead: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 5,
          batch: false,
        },
        {
          model: 'm',
          kind: 'fallback_message',
          input: 2,
          cacheRead: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 1,
          batch: false,
        },
      ],
      (iteration) => iteration.input * 100 + iteration.output * 200,
    );
    // (10×100 + 5×200) + (2×100 + 1×200) = 2000 + 400.
    expect(g.state().spentMicros).toBe(2_400);
  });

  it('bills a judge turn to the judges share', () => {
    const { guard: g } = guard(1_000_000);
    g.canStart();
    g.finishWithUsage(
      's1',
      [
        {
          model: 'm',
          kind: 'message',
          input: 10,
          cacheRead: 0,
          cacheWrite5m: 0,
          cacheWrite1h: 0,
          output: 5,
          batch: false,
        },
      ],
      () => 999_999,
      { judge: true },
    );
    expect(g.state().spentMicros).toBe(0);
  });
});
