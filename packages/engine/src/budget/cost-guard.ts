/**
 * The cost guard (`05` §3.9.3; `01` §8, §14 A3; `M3-T30`).
 *
 * Four things, and the AC's word "basic" is about which of them act rather than which exist:
 *
 *  1. **the budget**, per preset (`01` §14 A3) or as the host set it;
 *  2. **the ladder's step**, computed in full from §3.9.3's table, of which only **step 3** — the
 *     group hard stop — is enforced here. Steps 1 and 2 switch the chat route to the economy model
 *     and pause proactivity, which needs the router and the proactivity engine; `M8-T12` wires
 *     them. The step is still reported truthfully, because the dashboard's cost screen and the
 *     admin notices read it and a guard that under-reported to match its own reach would make
 *     `M8-T12` a rewrite rather than a wiring;
 *  3. **the per-turn cap** (`05` §5's `runtime.turn.perTurnCapUsd`), which is what stops one
 *     runaway turn from spending a day's budget before any window notices;
 *  4. **the per-member rate limit** (§3.9.3's last bullet), which is the only one of the four that
 *     is about a person rather than about money.
 *
 * ## Why the rollup is read every time instead of a counter in memory
 *
 * §3.9.3 says `spent(window)` is "cached in memory and incremented on write". It is not, and that
 * is deliberate — see `STATUS` → Plan changes. `02` §3.3.7's `usage_daily` rollup is already the
 * cache that sentence asks for, maintained **in the same transaction as the record** it summarises,
 * so reading it is one indexed lookup over at most 31 rows. A process-local counter would be worse
 * on all three counts that matter: it is lost on restart, it is wrong the moment a host runs a
 * second process (`01` §8 allows `--role=web|worker`), and it is a second source of truth for the
 * number that decides whether a family's assistant answers.
 */
import type { Effort, ModelRoute, Spend, UsageReader } from '@comvivo/core';
import { usageGroupKey } from '@comvivo/core';
import type { Clock, Config, GroupId, TimeZoneId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import { type BudgetWindow, budgetWindows } from './windows.js';

/** The preset a budget defaults from (`config.models.preset`). */
export type ModelPreset = Config['models']['preset'];

/** One micro-USD. Every amount in this module is an integer count of these (`09` §3.2's `costMicros`). */
const MICROS_PER_USD = 1_000_000;

/**
 * `01` §14 A3's defaults, in micro-USD.
 *
 * `custom` takes Best's numbers, which is A3's own rule: "Custom uses the Best defaults unless the
 * host sets explicit values."
 *
 * `local` is **zero**, and the strict reading is the right one. A3 says "Local $0 (tokens are free;
 * CPU budget only)", so a correctly configured local install spends nothing and never comes near
 * this limit — while an install that is quietly billing a paid key under the Local preset is a
 * misconfiguration a host has to be told about, and a zero budget tells them through the same
 * ladder as everybody else. The alternative, treating Local as "no limit", would make the one
 * preset where a surprise bill is impossible also the one preset where a surprise bill is
 * unlimited.
 */
export const PRESET_BUDGETS: Readonly<
  Record<ModelPreset, { readonly monthlyMicros: number; readonly dailyMicros: number }>
> = {
  best: { monthlyMicros: 75 * MICROS_PER_USD, dailyMicros: 4 * MICROS_PER_USD },
  balanced: { monthlyMicros: 40 * MICROS_PER_USD, dailyMicros: 2 * MICROS_PER_USD },
  economy: { monthlyMicros: 5 * MICROS_PER_USD, dailyMicros: 300_000 },
  local: { monthlyMicros: 0, dailyMicros: 0 },
  custom: { monthlyMicros: 75 * MICROS_PER_USD, dailyMicros: 4 * MICROS_PER_USD },
};

/**
 * `05` §5's `runtime.turn.perTurnCapUsd`, in micro-USD.
 *
 * Not yet a config key: `05` §5's `runtime.*` block is one object and `M3-T24` is the task that
 * reads the rest of it, so adding a `runtime.turn` with one field in it would reject a host's
 * config file for naming any of the other eleven. The defaults are §5's own numbers and
 * `BudgetLimits` carries them, so the wiring at `M3-T24` is a field, not a refactor. Recorded in
 * `STATUS` → Plan changes.
 */
export const PER_TURN_CAP = {
  /** `low` effort: $0.25. */
  lowMicros: 250_000,
  /** Everything above `low`: $1.00. `05` D6 — the router picks only `low` or `medium`. */
  mediumMicros: MICROS_PER_USD,
  /** No single turn may spend more than this share of what is left in the day. */
  maxShareOfDailyRemaining: 0.25,
} as const;

export interface PerTurnCap {
  readonly lowMicros: number;
  readonly mediumMicros: number;
  readonly maxShareOfDailyRemaining: number;
}

export interface BudgetLimits {
  readonly dailyMicros: number;
  readonly monthlyMicros: number;
  /** §3.9.3: `budgets.perMemberTurnsPerHour`, a cap on **addressed** turns per member. */
  readonly perMemberTurnsPerHour: number;
  readonly perTurnCap: PerTurnCap;
}

/**
 * The limits for an instance, from its config.
 *
 * An explicit `budgets.monthlyUsd` or `dailyUsd` wins over the preset, and either may be set
 * alone: a host who caps the month and leaves the day to the preset has said something coherent,
 * and making both-or-neither the rule would be this function inventing a constraint `09` §5.1 does
 * not have.
 */
export function budgetLimits(config: Config): BudgetLimits {
  const preset = PRESET_BUDGETS[config.models.preset];
  return {
    dailyMicros: usdToMicros(config.budgets.dailyUsd) ?? preset.dailyMicros,
    monthlyMicros: usdToMicros(config.budgets.monthlyUsd) ?? preset.monthlyMicros,
    perMemberTurnsPerHour: config.budgets.perMemberTurnsPerHour,
    perTurnCap: PER_TURN_CAP,
  };
}

/**
 * Dollars to micro-USD, rounded.
 *
 * Rounded rather than truncated, and `Math.round` rather than a cast, because `0.3 * 1_000_000` is
 * `299999.99999999994` in binary floating point: Economy's $0.30/day would become a budget of
 * 299,999 micros and every number shown to a host would be a hundredth of a cent short of what
 * they typed.
 */
function usdToMicros(usd: number | null): number | undefined {
  return usd === null ? undefined : Math.round(usd * MICROS_PER_USD);
}

/** What one of `05` §3.9.3's two windows has spent, against its limit. */
export interface WindowSpend {
  readonly window: BudgetWindow;
  readonly limitMicros: number;
  readonly spentMicros: number;
  /**
   * `spent / limit`, uncapped — a group at 140% reads as `1.4` rather than `1`.
   *
   * Uncapped because the admin notice shows it and "140% of the monthly budget" is a different
   * conversation from "100%". A **zero** limit is `0` while nothing has been spent and `Infinity`
   * once anything has, which is the arithmetic that makes the Local preset behave: see
   * `PRESET_BUDGETS`.
   */
  readonly fraction: number;
}

/**
 * `05` §3.9.3's ladder step, 0 to 3.
 *
 * Computed in full here and **enforced** only at 3 (`M3-T30`'s AC). See the module header.
 */
export type LadderStep = 0 | 1 | 2 | 3;

export interface BudgetState {
  readonly step: LadderStep;
  /** Day first, then month, as `budgetWindows` returns them. */
  readonly windows: readonly [WindowSpend, WindowSpend];
  /**
   * The window that decided the step: the one with the higher `fraction`.
   *
   * §3.9.3's trigger column is "either window", so the ladder is driven by the worse of the two —
   * and which one it was is what the admin notice has to name, because "you have reached your
   * budget" without "the daily one" sends a host to the wrong setting.
   */
  readonly binding: WindowSpend;
}

/** §3.9.3's thresholds, as the fraction at which each step begins. */
export const LADDER_THRESHOLDS = [
  { step: 3, atLeast: 1 },
  { step: 2, atLeast: 0.9 },
  { step: 1, atLeast: 0.8 },
] as const satisfies readonly { readonly step: LadderStep; readonly atLeast: number }[];

export function ladderStep(fraction: number): LadderStep {
  // Ordered highest first, so the first match is the answer and no threshold can shadow another.
  for (const rung of LADDER_THRESHOLDS) {
    if (fraction >= rung.atLeast) return rung.step;
  }
  return 0;
}

/**
 * Whether a route may still call a model (`05` §3.9.3 step 3).
 *
 * "Model routes stop for the group except `guard`, which is safety-critical; its spend is still
 * counted." The exception is not a convenience: `guard` is what checks an outgoing message for a
 * disclosure it should not make (`05` §3.8), and a group whose budget ran out while a reply was
 * being prepared must not get the ungarded version of it. Its spend is counted, so the overage is
 * visible rather than hidden in an exemption.
 */
export function routeAllowedAtStep(route: ModelRoute, step: LadderStep): boolean {
  return step < 3 || route === 'guard';
}

/**
 * What one turn may spend (`05` §5's `perTurnCapUsd`).
 *
 * Two caps, and the lower wins. The flat one per effort is what stops a single runaway tool loop;
 * the share of the day's remainder is what stops four of them in a row from emptying the budget
 * before any window crosses a threshold. Without the second, a group on Economy's $0.30/day could
 * spend the whole day in one turn and discover it at step 3 with no warning at steps 1 and 2.
 */
export function perTurnCapMicros(
  effort: Effort,
  dailyRemainingMicros: number,
  cap: PerTurnCap = PER_TURN_CAP,
): number {
  // `low` or everything else: `05` D6 has the router choosing only `low` and `medium`, so a higher
  // effort can only come from a route that asked for it explicitly — and capping that at `medium`
  // is the tighter answer, which is the safe direction for money.
  const byEffort = effort === 'low' ? cap.lowMicros : cap.mediumMicros;
  const byShare = Math.floor(Math.max(0, dailyRemainingMicros) * cap.maxShareOfDailyRemaining);
  return Math.min(byEffort, byShare);
}

export interface CostGuardDeps {
  readonly usage: UsageReader;
  readonly clock: Clock;
  readonly limits: BudgetLimits;
}

/**
 * The guard a turn asks before it starts, and again before each iteration.
 *
 * Synchronous, because `UsageReader.spend` is: `02`'s repositories are better-sqlite3 and the
 * budget check is on the turn's critical path, so an `await` here would be a scheduling boundary
 * on every iteration for a read that takes microseconds.
 */
export class CostGuard {
  readonly #usage: UsageReader;
  readonly #clock: Clock;
  readonly #limits: BudgetLimits;

  constructor(deps: CostGuardDeps) {
    this.#usage = deps.usage;
    this.#clock = deps.clock;
    this.#limits = deps.limits;
  }

  get limits(): BudgetLimits {
    return this.#limits;
  }

  /** Where this group stands, in both windows, right now. */
  state(groupId: GroupId, zone: TimeZoneId, at: Temporal.Instant = this.#clock.now()): BudgetState {
    const key = usageGroupKey(groupId);
    const [day, month] = budgetWindows(at, zone);
    const windows = [
      this.#spend(key, day, this.#limits.dailyMicros),
      this.#spend(key, month, this.#limits.monthlyMicros),
    ] as const;
    // The worse of the two decides, per §3.9.3's "either window".
    const binding = windows[0].fraction >= windows[1].fraction ? windows[0] : windows[1];
    return { step: ladderStep(binding.fraction), windows, binding };
  }

  /** What is left in the **daily** window, which is what the per-turn share cap is a share of. */
  dailyRemainingMicros(state: BudgetState): number {
    const day = state.windows[0];
    return Math.max(0, day.limitMicros - day.spentMicros);
  }

  /** `perTurnCapMicros`, with this instance's cap and this group's remaining day. */
  turnCapMicros(effort: Effort, state: BudgetState): number {
    return perTurnCapMicros(effort, this.dailyRemainingMicros(state), this.#limits.perTurnCap);
  }

  /** `routeAllowedAtStep` against this group's current step. */
  allows(route: ModelRoute, state: BudgetState): boolean {
    return routeAllowedAtStep(route, state.step);
  }

  #spend(key: string, window: BudgetWindow, limitMicros: number): WindowSpend {
    const spend: Spend = this.#usage.spend(key, {
      fromDay: window.fromDay,
      toDay: window.toDay,
    });
    return {
      window,
      limitMicros,
      spentMicros: spend.costMicros,
      fraction: fractionOf(spend.costMicros, limitMicros),
    };
  }
}

/**
 * `spent / limit`, with the zero-limit case decided rather than left to IEEE 754.
 *
 * `0 / 0` is `NaN`, and `NaN >= 1` is `false` — so a Local install that started billing would have
 * sailed past every rung of the ladder with a step of 0. Spelled out because that is a failure
 * nothing would have reported.
 */
function fractionOf(spentMicros: number, limitMicros: number): number {
  if (limitMicros > 0) return spentMicros / limitMicros;
  return spentMicros > 0 ? Number.POSITIVE_INFINITY : 0;
}

/** What `MemberTurnLimiter.take` decided, in one answer so the notice cannot be forgotten. */
export interface MemberTurnDecision {
  /** Whether this addressed turn may start. */
  readonly allowed: boolean;
  /**
   * Whether to reply with `err.slow_down`.
   *
   * `05` §3.9.3: "Excess messages get one `err.slow_down` reply per hour, then silence." Returned
   * from the same call as `allowed` rather than left to the caller to work out, because the
   * bookkeeping is the whole of the rule: a caller that replied on every refusal would turn a rate
   * limit into the spam it exists to prevent, and one that never replied would leave a member
   * being ignored with no explanation.
   */
  readonly notify: boolean;
}

/**
 * How many member buckets to keep.
 *
 * A household has a handful of members and an instance a handful of groups, so this is far above
 * any real install — it is here because the map is keyed by a value that arrives from outside, and
 * an unbounded map keyed by anything a message can carry is a memory leak with a sender. A **full**
 * bucket holds no information (it is indistinguishable from a member who has never asked), so a
 * sweep that drops those is lossless.
 */
const MAX_TRACKED_MEMBERS = 10_000;

const HOUR_MS = 60 * 60 * 1000;

interface Bucket {
  /** Tokens available, fractional between refills. */
  tokens: number;
  /** When `tokens` was last brought up to date. */
  refilledAtMs: number;
  /** When `err.slow_down` was last sent, or `undefined` if never. */
  notifiedAtMs?: number;
}

/**
 * The per-member rate limit (`05` §3.9.3's last bullet; `08` §3.9's cost-abuse defence).
 *
 * A token bucket rather than a counter per clock hour, and the difference is what a member
 * experiences. A counter that resets on the hour lets someone spend thirty turns at 10:59 and
 * thirty more at 11:00 — sixty in two minutes, which is the burst the limit exists to stop — and
 * then makes them wait fifty-eight minutes. A bucket refills continuously, so the thirty-first
 * question is answered two minutes later rather than at the top of the hour.
 *
 * ## In memory, and what that costs
 *
 * The state is process-local, so a restart gives every member a full bucket. That is the right
 * trade for this limit: the alternative is a write per addressed turn on the turn's critical path
 * (`02` has one writer, `01` C1), to defend against an abuser who would have to crash the process
 * to benefit. `01` §8 allows `--role=web|worker`, and two processes would each keep their own
 * bucket — which halves the limit's strictness and is still a limit; the budget windows, which are
 * about money, read the shared rollup instead for exactly that reason.
 */
export class MemberTurnLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  readonly #clock: Clock;

  constructor(options: { readonly turnsPerHour: number; readonly clock: Clock }) {
    if (!Number.isInteger(options.turnsPerHour) || options.turnsPerHour < 1) {
      throw new RangeError(
        `budgets.perMemberTurnsPerHour must be a positive integer, got ${String(options.turnsPerHour)}`,
      );
    }
    this.#capacity = options.turnsPerHour;
    this.#clock = options.clock;
  }

  /** Take one token for an addressed turn. */
  take(memberKey: string): MemberTurnDecision {
    const nowMs = this.#clock.now().epochMilliseconds;
    const bucket = this.#refill(memberKey, nowMs);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, notify: false };
    }
    // Refused. One notice per hour per member, then silence.
    const notify = bucket.notifiedAtMs === undefined || nowMs - bucket.notifiedAtMs >= HOUR_MS;
    if (notify) bucket.notifiedAtMs = nowMs;
    return { allowed: false, notify };
  }

  /** How many turns this member has left, for the dashboard and for a test. */
  remaining(memberKey: string): number {
    return Math.floor(this.#refill(memberKey, this.#clock.now().epochMilliseconds).tokens);
  }

  #refill(memberKey: string, nowMs: number): Bucket {
    const existing = this.#buckets.get(memberKey);
    if (existing === undefined) {
      if (this.#buckets.size >= MAX_TRACKED_MEMBERS) this.#sweep(nowMs);
      const fresh: Bucket = { tokens: this.#capacity, refilledAtMs: nowMs };
      this.#buckets.set(memberKey, fresh);
      return fresh;
    }
    const elapsedMs = Math.max(0, nowMs - existing.refilledAtMs);
    existing.tokens = Math.min(
      this.#capacity,
      existing.tokens + (elapsedMs / HOUR_MS) * this.#capacity,
    );
    existing.refilledAtMs = nowMs;
    return existing;
  }

  /** Drop every bucket that is full and out of its notice window: both hold no information. */
  #sweep(nowMs: number): void {
    for (const [key, bucket] of this.#buckets) {
      const refilled =
        Math.min(
          this.#capacity,
          bucket.tokens + (Math.max(0, nowMs - bucket.refilledAtMs) / HOUR_MS) * this.#capacity,
        ) >= this.#capacity;
      const quiet = bucket.notifiedAtMs === undefined || nowMs - bucket.notifiedAtMs >= HOUR_MS;
      if (refilled && quiet) this.#buckets.delete(key);
    }
  }
}
