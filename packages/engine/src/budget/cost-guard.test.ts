/**
 * The cost guard (`05` §3.9.3; `01` §8, §14 A3; `M3-T30`).
 *
 * Three groups of tests, and the middle one is the reason this file is long.
 *
 *  1. **The numbers**, pinned against `01` §14 A3. A budget table is read once and then trusted
 *     forever, so a transposed digit is a bug nobody looks for — and `$4/day` typed as `$40/day`
 *     is a tenfold overspend that only the owner's invoice would reveal.
 *  2. **The arithmetic at the edges**: a zero limit, a limit crossed exactly, a day with nothing
 *     left. Each of these has a plausible implementation that returns `NaN` or `0` and sails past
 *     the ladder.
 *  3. **The ladder and the rate limit**, which are what a member actually experiences.
 */
import type { Spend, UsageReader } from '@comvivo/core';
import { type Config, defaultConfig, type GroupId, parseTimeZoneId } from '@comvivo/shared';
import { VirtualClock } from '@comvivo/shared/testing';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  budgetLimits,
  CostGuard,
  ladderStep,
  MemberTurnLimiter,
  PER_TURN_CAP,
  PRESET_BUDGETS,
  perTurnCapMicros,
  routeAllowedAtStep,
} from './cost-guard.js';

const GROUP = 'grp_01jd0000000000000000000000' as GroupId;
const MADRID =
  parseTimeZoneId('Europe/Madrid') ??
  (() => {
    throw new Error('Europe/Madrid is not a timezone this runtime knows');
  })();

/** Every spend query this reader was asked, so a test can assert the **windows**, not just the sums. */
interface FakeUsage extends UsageReader {
  readonly queries: { groupKey: string; fromDay: string; toDay: string }[];
}

/**
 * A `UsageReader` that answers from a per-window map.
 *
 * Keyed by the day range rather than by "first call, second call", because the thing most likely to
 * be wrong is the guard reading the monthly spend against the daily limit — and a fake that
 * answered positionally would agree with that bug.
 */
function fakeUsage(byRange: Readonly<Record<string, number>>): FakeUsage {
  const queries: { groupKey: string; fromDay: string; toDay: string }[] = [];
  const empty: Spend = {
    calls: 0,
    costMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
  };
  return {
    queries,
    byId: () => undefined,
    records: () => [],
    daily: () => [],
    spend: (groupKey, window) => {
      queries.push({ groupKey, fromDay: window.fromDay, toDay: window.toDay });
      const costMicros = byRange[`${window.fromDay}..${window.toDay}`] ?? 0;
      return { ...empty, costMicros, calls: costMicros > 0 ? 1 : 0 };
    },
  };
}

function guard(
  byRange: Readonly<Record<string, number>>,
  limits = budgetLimits(defaultConfig()),
): { guard: CostGuard; usage: FakeUsage } {
  const usage = fakeUsage(byRange);
  return {
    guard: new CostGuard({ usage, clock: new VirtualClock('2026-11-14T12:00:00Z'), limits }),
    usage,
  };
}

/** `defaultConfig()` with one branch replaced, so a test changes one thing. */
function configWith(over: Partial<Config['budgets']>, preset?: Config['models']['preset']): Config {
  const base = defaultConfig();
  return {
    ...base,
    models: { ...base.models, ...(preset === undefined ? {} : { preset }) },
    budgets: { ...base.budgets, ...over },
  };
}

describe('the per-preset defaults (01 §14 A3)', () => {
  it('matches A3 to the cent', () => {
    // Pinned, in micro-USD, because this table is the product's promise about money. `01` §14 A3:
    // Best $75/mo ($4/day), Balanced $40/mo ($2/day), Economy $5/mo ($0.30/day), Local $0.
    expect(PRESET_BUDGETS).toEqual({
      best: { monthlyMicros: 75_000_000, dailyMicros: 4_000_000 },
      balanced: { monthlyMicros: 40_000_000, dailyMicros: 2_000_000 },
      economy: { monthlyMicros: 5_000_000, dailyMicros: 300_000 },
      local: { monthlyMicros: 0, dailyMicros: 0 },
      // A3: "Custom uses the Best defaults unless the host sets explicit values."
      custom: { monthlyMicros: 75_000_000, dailyMicros: 4_000_000 },
    });
  });

  it('keeps every daily budget below its monthly one', () => {
    // Not a tautology: a daily budget above a thirtieth of the month is intentional (a family does
    // not spend evenly), but a daily budget above the **whole** month would make the monthly
    // window unreachable and the ladder's "either window" meaningless.
    for (const [preset, budget] of Object.entries(PRESET_BUDGETS)) {
      expect(budget.dailyMicros, preset).toBeLessThanOrEqual(budget.monthlyMicros);
    }
  });
});

describe('budgetLimits', () => {
  it('takes the preset when the host set no explicit budget', () => {
    expect(budgetLimits(configWith({}, 'balanced'))).toMatchObject({
      dailyMicros: 2_000_000,
      monthlyMicros: 40_000_000,
      perMemberTurnsPerHour: 30,
    });
  });

  it('lets an explicit budget win, in either window alone', () => {
    // Either alone, because a host who caps the month and leaves the day to the preset has said
    // something coherent. Requiring both would be this function inventing a constraint `09` §5.1
    // does not have.
    expect(budgetLimits(configWith({ monthlyUsd: 12 }, 'best'))).toMatchObject({
      monthlyMicros: 12_000_000,
      dailyMicros: 4_000_000,
    });
    expect(budgetLimits(configWith({ dailyUsd: 1 }, 'best'))).toMatchObject({
      monthlyMicros: 75_000_000,
      dailyMicros: 1_000_000,
    });
  });

  it('converts dollars without losing a hundredth of a cent', () => {
    // `0.3 * 1_000_000` is 299999.99999999994 in binary floating point. Truncating would make
    // Economy's $0.30/day a budget of 299,999 micros — and every figure shown to a host would be
    // a hundredth of a cent short of what they typed.
    expect(budgetLimits(configWith({ dailyUsd: 0.3 })).dailyMicros).toBe(300_000);
    expect(budgetLimits(configWith({ dailyUsd: 0.07 })).dailyMicros).toBe(70_000);
    expect(budgetLimits(configWith({ monthlyUsd: 29.99 })).monthlyMicros).toBe(29_990_000);
  });

  it('carries 05 §5’s per-turn cap', () => {
    expect(budgetLimits(defaultConfig()).perTurnCap).toEqual({
      lowMicros: 250_000,
      mediumMicros: 1_000_000,
      maxShareOfDailyRemaining: 0.25,
    });
  });
});

describe('ladderStep (05 §3.9.3)', () => {
  it('follows §3.9.3’s table, boundaries included', () => {
    // The boundaries are the point: §3.9.3 says "≥ 80 %", so 0.8 is step 1 and 0.7999 is step 0.
    expect([0, 0.5, 0.799].map(ladderStep)).toEqual([0, 0, 0]);
    expect([0.8, 0.85, 0.899].map(ladderStep)).toEqual([1, 1, 1]);
    expect([0.9, 0.95, 0.999].map(ladderStep)).toEqual([2, 2, 2]);
    expect([1, 1.4, 12].map(ladderStep)).toEqual([3, 3, 3]);
  });

  it('reports step 3 for an infinite fraction, which is a zero budget that spent something', () => {
    expect(ladderStep(Number.POSITIVE_INFINITY)).toBe(3);
  });
});

describe('routeAllowedAtStep (05 §3.9.3 step 3)', () => {
  it('stops every route except guard at step 3', () => {
    // `guard` is what checks an outgoing message for a disclosure it should not make (`05` §3.8).
    // A group whose budget ran out mid-reply must not receive the unguarded version of it, which
    // is why §3.9.3 carves it out — and why its spend is still counted rather than exempted.
    for (const route of ['chat', 'route', 'extract', 'declassify', 'consolidate'] as const) {
      expect(routeAllowedAtStep(route, 3), route).toBe(false);
    }
    expect(routeAllowedAtStep('guard', 3)).toBe(true);
  });

  it('allows everything below step 3, because steps 1 and 2 degrade rather than stop', () => {
    for (const step of [0, 1, 2] as const) {
      for (const route of ['chat', 'guard', 'extract'] as const) {
        expect(routeAllowedAtStep(route, step), `${route}@${String(step)}`).toBe(true);
      }
    }
  });
});

describe('perTurnCapMicros (05 §5)', () => {
  it('uses the flat cap per effort when the day has room', () => {
    // $4 left, so a quarter of it is $1 — above `low`'s $0.25 and equal to `medium`'s $1.00.
    expect(perTurnCapMicros('low', 4_000_000)).toBe(250_000);
    expect(perTurnCapMicros('medium', 4_000_000)).toBe(1_000_000);
  });

  it('caps anything above medium at medium’s figure', () => {
    // `05` D6 has the router choosing only `low` or `medium`, so a higher effort can only come from
    // a route that asked for it — and the tighter cap is the safe direction for money.
    for (const effort of ['high', 'xhigh', 'max'] as const) {
      expect(perTurnCapMicros(effort, 4_000_000), effort).toBe(1_000_000);
    }
  });

  it('never lets one turn take more than a quarter of what is left today', () => {
    // The cap that matters on Economy: $0.30/day means a turn may spend 7.5 cents, so four
    // expensive turns in a row cannot empty the day before the 80% and 90% rungs are ever seen.
    expect(perTurnCapMicros('medium', 300_000)).toBe(75_000);
    expect(perTurnCapMicros('low', 300_000)).toBe(75_000);
    // And it shrinks as the day is spent, rather than staying at a quarter of the budget.
    expect(perTurnCapMicros('medium', 40_000)).toBe(10_000);
  });

  it('is zero when the day is spent, and never negative when it is overspent', () => {
    expect(perTurnCapMicros('medium', 0)).toBe(0);
    // An overspent day can arrive from a concurrent write or a single turn that cost more than the
    // whole budget. A negative cap would compare as "below" every cost and allow everything.
    expect(perTurnCapMicros('medium', -500_000)).toBe(0);
  });

  it('takes an instance’s own cap when the host configured one', () => {
    const cap = { lowMicros: 10_000, mediumMicros: 20_000, maxShareOfDailyRemaining: 1 };
    expect(perTurnCapMicros('low', 4_000_000, cap)).toBe(10_000);
    expect(perTurnCapMicros('medium', 4_000_000, cap)).toBe(20_000);
    // A share of 1 means the only cap is the flat one, which is how a host disables the share.
    expect(perTurnCapMicros('medium', 5_000, cap)).toBe(5_000);
    expect(PER_TURN_CAP.maxShareOfDailyRemaining).toBe(0.25);
  });
});

describe('CostGuard.state', () => {
  it('reads each window against its own limit', () => {
    // The assertion that catches a swapped window: the fake answers by **day range**, so a guard
    // that asked for the month and compared it to the daily limit would read 0 for the day.
    const { guard: cost, usage } = guard({
      '2026-11-14..2026-11-14': 1_000_000,
      '2026-11-01..2026-11-30': 30_000_000,
    });
    const state = cost.state(GROUP, MADRID);
    const [day, month] = state.windows;
    expect(day.spentMicros).toBe(1_000_000);
    expect(day.limitMicros).toBe(4_000_000);
    expect(day.fraction).toBeCloseTo(0.25, 10);
    expect(month.spentMicros).toBe(30_000_000);
    expect(month.limitMicros).toBe(75_000_000);
    expect(month.fraction).toBeCloseTo(0.4, 10);
    // Both windows, under the group's key, each exactly once.
    expect(usage.queries).toEqual([
      { groupKey: GROUP, fromDay: '2026-11-14', toDay: '2026-11-14' },
      { groupKey: GROUP, fromDay: '2026-11-01', toDay: '2026-11-30' },
    ]);
  });

  it('lets the worse window decide the step, and names it', () => {
    // §3.9.3's trigger is "either window". A group at 10% of its month and 100% of its day is
    // stopped — and the admin notice has to say **which**, because "you have reached your budget"
    // without "the daily one" sends a host to the wrong setting.
    const { guard: cost } = guard({
      '2026-11-14..2026-11-14': 4_000_000,
      '2026-11-01..2026-11-30': 7_500_000,
    });
    const state = cost.state(GROUP, MADRID);
    expect(state.step).toBe(3);
    expect(state.binding.window.period).toBe('day');
    expect(cost.allows('chat', state)).toBe(false);
    expect(cost.allows('guard', state)).toBe(true);
  });

  it('is step 0 for a group that has spent nothing', () => {
    const { guard: cost } = guard({});
    const state = cost.state(GROUP, MADRID);
    expect(state.step).toBe(0);
    expect(state.binding.fraction).toBe(0);
    expect(cost.allows('chat', state)).toBe(true);
  });

  it('reads the day in the group’s zone, not in UTC', () => {
    // At 06:00 UTC it is still the 13th in Honolulu, so a guard that keyed the rollup by the UTC
    // date would read a day the group has not started yet — zero spend, step 0, no limit — while
    // the day the family actually spent its budget in sat in a bucket nothing looked at.
    const honolulu = parseTimeZoneId('Pacific/Honolulu');
    expect(honolulu).toBeDefined();
    const { guard: cost, usage } = guard({ '2026-11-13..2026-11-13': 4_000_000 });
    const state = cost.state(
      GROUP,
      honolulu ?? MADRID,
      Temporal.Instant.from('2026-11-14T06:00:00Z'),
    );
    expect(usage.queries[0]?.fromDay).toBe('2026-11-13');
    expect(state.step).toBe(3);
  });

  it('takes an explicit instant, so a caller can ask about a window that has closed', () => {
    const { guard: cost } = guard({ '2026-10-20..2026-10-20': 4_000_000 });
    const state = cost.state(GROUP, MADRID, Temporal.Instant.from('2026-10-20T12:00:00Z'));
    expect(state.windows[0].window.fromDay).toBe('2026-10-20');
    expect(state.step).toBe(3);
  });

  it('stops a Local install the moment it spends anything, and never before', () => {
    // A zero budget divided into zero spend is `0 / 0`, which is `NaN` — and `NaN >= 1` is false,
    // so the obvious implementation sails past every rung with a step of 0. `01` §14 A3's Local
    // preset is $0, so a Local install that is quietly billing a paid key is a misconfiguration
    // the host has to be told about, through the same ladder as everybody else.
    const local = budgetLimits(configWith({}, 'local'));
    expect([local.dailyMicros, local.monthlyMicros]).toEqual([0, 0]);

    const quiet = guard({}, local).guard.state(GROUP, MADRID);
    expect(quiet.step).toBe(0);
    expect(quiet.binding.fraction).toBe(0);
    expect(quiet.windows.map((window) => window.fraction)).toEqual([0, 0]);

    const billing = guard({ '2026-11-14..2026-11-14': 1 }, local).guard.state(GROUP, MADRID);
    expect(billing.step).toBe(3);
    expect(billing.windows[0].fraction).toBe(Number.POSITIVE_INFINITY);
  });

  it('gives a free turn a zero cap it can satisfy', () => {
    // The consequence of the above, and it has to be checked rather than reasoned about: a Local
    // install has nothing remaining, so the share cap is zero — and a turn that costs nothing
    // is still within a cap of nothing. A guard that compared `cost >= cap` instead of `cost > cap`
    // would refuse every turn on the one preset where tokens are free.
    const local = budgetLimits(configWith({}, 'local'));
    const { guard: cost } = guard({}, local);
    const state = cost.state(GROUP, MADRID);
    expect(cost.dailyRemainingMicros(state)).toBe(0);
    expect(cost.turnCapMicros('medium', state)).toBe(0);
  });

  it('shrinks the turn cap as the day is spent', () => {
    const { guard: cost } = guard({ '2026-11-14..2026-11-14': 3_900_000 });
    const state = cost.state(GROUP, MADRID);
    // $0.10 left, so a quarter of it: 2.5 cents.
    expect(cost.dailyRemainingMicros(state)).toBe(100_000);
    expect(cost.turnCapMicros('medium', state)).toBe(25_000);
    expect(cost.turnCapMicros('low', state)).toBe(25_000);
  });

  it('exposes its limits, because the dashboard shows the budget beside the spend', () => {
    const { guard: cost } = guard({});
    expect(cost.limits.monthlyMicros).toBe(75_000_000);
  });
});

describe('MemberTurnLimiter (05 §3.9.3)', () => {
  const member = 'mbr_01jd0000000000000000000000';

  function limiter(turnsPerHour = 30): { limiter: MemberTurnLimiter; clock: VirtualClock } {
    const clock = new VirtualClock('2026-11-14T12:00:00Z');
    return { limiter: new MemberTurnLimiter({ turnsPerHour, clock }), clock };
  }

  it('allows the configured number of turns and then refuses', async () => {
    const { limiter: limit } = limiter(30);
    for (let turn = 0; turn < 30; turn += 1) {
      expect(limit.take(member), `turn ${String(turn)}`).toEqual({ allowed: true, notify: false });
    }
    expect(limit.take(member).allowed).toBe(false);
  });

  it('replies once per hour and is then silent (05 §3.9.3)', async () => {
    const { limiter: limit, clock } = limiter(1);
    expect(limit.take(member).allowed).toBe(true);
    // The first refusal explains itself.
    expect(limit.take(member)).toEqual({ allowed: false, notify: true });
    // The next twenty do not, which is the difference between a rate limit and the spam it exists
    // to prevent.
    for (let again = 0; again < 20; again += 1) {
      expect(limit.take(member)).toEqual({ allowed: false, notify: false });
    }
    // An hour later, one more explanation — because by then the member has plausibly forgotten,
    // and silence from an assistant that used to answer reads as broken.
    await clock.advance('PT1H');
    expect(limit.take(member).allowed).toBe(true);
    expect(limit.take(member)).toEqual({ allowed: false, notify: true });
  });

  it('refills continuously, not on the hour', async () => {
    // The reason it is a bucket. A counter that reset at the top of the hour would let a member
    // spend thirty turns at 10:59 and thirty more at 11:00 — sixty in two minutes, the exact burst
    // the limit exists to stop — and then make them wait fifty-eight minutes.
    const { limiter: limit, clock } = limiter(30);
    for (let turn = 0; turn < 30; turn += 1) limit.take(member);
    expect(limit.take(member).allowed).toBe(false);
    // 30/hour is one every two minutes.
    await clock.advance('PT2M');
    expect(limit.remaining(member)).toBe(1);
    expect(limit.take(member).allowed).toBe(true);
    expect(limit.take(member).allowed).toBe(false);
  });

  it('never holds more than a full bucket, however long the member was away', async () => {
    const { limiter: limit, clock } = limiter(30);
    await clock.advance('PT72H');
    expect(limit.remaining(member)).toBe(30);
    for (let turn = 0; turn < 30; turn += 1) {
      expect(limit.take(member).allowed, `turn ${String(turn)}`).toBe(true);
    }
    expect(limit.take(member).allowed).toBe(false);
  });

  it('counts each member separately', async () => {
    const { limiter: limit } = limiter(1);
    expect(limit.take('mbr_a').allowed).toBe(true);
    expect(limit.take('mbr_a').allowed).toBe(false);
    // One member hitting the limit must not quiet the rest of the family.
    expect(limit.take('mbr_b').allowed).toBe(true);
  });

  it('refuses a rate of zero rather than silencing a whole group', async () => {
    // `budgets.perMemberTurnsPerHour` has a floor of 1 in the schema; this is the second line of
    // defence, because a zero here would be a group where nobody can ask anything — configured
    // through a number that looks like a rate limit.
    const clock = new VirtualClock('2026-11-14T12:00:00Z');
    for (const turnsPerHour of [0, -1, 1.5]) {
      expect(() => new MemberTurnLimiter({ turnsPerHour, clock }), String(turnsPerHour)).toThrow(
        /positive integer/,
      );
    }
  });

  it('does not grow without bound when the keys come from outside', async () => {
    // The map is keyed by a member id that arrives with a message, so an unbounded map is a memory
    // leak with a sender. A **full** bucket is indistinguishable from a member who never asked, so
    // dropping those is lossless — and this checks the sweep actually happens rather than trusting
    // the constant.
    const { limiter: limit, clock } = limiter(30);
    for (let index = 0; index < 10_050; index += 1) limit.take(`mbr_${String(index)}`);
    // An hour on, every bucket is full again and the next insert sweeps them.
    await clock.advance('PT1H');
    limit.take('mbr_fresh');
    // The one member who is still rate-limited keeps its bucket: the sweep drops full ones only.
    const { limiter: busy } = limiter(1);
    busy.take(member);
    expect(busy.take(member)).toEqual({ allowed: false, notify: true });
    for (let index = 0; index < 10_050; index += 1) busy.take(`mbr_${String(index)}`);
    expect(busy.take(member)).toEqual({ allowed: false, notify: false });
  });
});
