/**
 * `EvalBudgetGuard` (`11` §3.8.4; `M2-T19`).
 *
 * ## What it is for
 *
 * A live eval run spends real money on somebody's account, and the thing that must not happen is
 * an overspend nobody noticed until the invoice. So the guard sums `UsageRecord.costMicros` as the
 * run proceeds and **stops scheduling new scenarios** when projected spend reaches its share.
 *
 * ## The three rules that make it a guard rather than a counter
 *
 *  1. **It projects, it does not just measure.** Admitting a scenario because *spent* is under the
 *     cap and then spending twice the cap on it is the failure mode a running total cannot see. So
 *     admission compares `spent + inFlight + estimate` against the cap, where the estimate is the
 *     running mean of what a scenario has actually cost on this run.
 *  2. **In-flight work finishes.** §3.8.4 says so, and it is the right call: killing a scenario
 *     mid-turn spends the money and produces no result, which is the worst of both.
 *  3. **A truncated run is yellow, not green.** The whole point is that a suite which did not
 *     finish must not be reported as a pass. `budget_truncated` is a distinct outcome, and
 *     `isGreen` is false for it.
 *
 * ## Why the estimate starts pessimistic
 *
 * With no completed scenario there is no mean, and the first admission decision still has to be
 * made. Starting from zero would admit the first scenario unconditionally — fine — but also the
 * next hundred, because `spent` stays zero until the first one finishes. So the opening estimate is
 * a caller-supplied figure and the guard admits **one** scenario at a time until it has real data.
 */
import type { UsageIteration } from '@comvivo/core';
import type { BudgetShare } from './prices.js';

/** How a suite ended. `11` §3.8.4's outcomes. */
export type SuiteOutcome = 'completed' | 'budget_truncated' | 'time_truncated';

/** Whether an outcome counts as a green run. */
export function isGreen(outcome: SuiteOutcome): boolean {
  // `11` §3.8.4: "A truncated run is yellow, not green." A suite that stopped early did not
  // measure what it claims to measure, whichever bound stopped it.
  return outcome === 'completed';
}

export interface GuardOptions {
  readonly share: BudgetShare;
  /**
   * What to assume one scenario costs before any has finished, in micro-USD.
   *
   * Pessimistic on purpose: it is only used until the first real figure arrives, and guessing low
   * there is what lets a run admit a hundred scenarios on the strength of having spent nothing yet.
   */
  readonly openingEstimateMicros: number;
  /** Injected, as everywhere. Milliseconds since the epoch. */
  readonly nowMs: () => number;
}

/** One finished scenario's cost, as the guard records it. */
export interface ScenarioCost {
  readonly scenario: string;
  readonly costMicros: number;
  /** True when the call was billed to the `judges` share rather than this one (`11` §3.8.4). */
  readonly judge: boolean;
}

export interface GuardState {
  readonly spentMicros: number;
  readonly inFlightMicros: number;
  readonly completed: number;
  readonly admitted: number;
  readonly refused: number;
  readonly outcome: SuiteOutcome;
}

/**
 * The guard.
 *
 * A class because it holds a running total that every admission reads — the alternative is
 * threading the total through every call site, which is how one of them ends up reading a stale
 * copy.
 */
export class EvalBudgetGuard {
  readonly #options: GuardOptions;
  readonly #startedAtMs: number;
  readonly #costs: ScenarioCost[] = [];
  #spentMicros = 0;
  /**
   * What each in-flight scenario reserved, in admission order.
   *
   * A queue of the **actual** reservations rather than a single total released with the current
   * estimate. The first version subtracted `estimateMicros()` at finish time, which is a different
   * number from the one reserved — the mean has moved by then — so a scenario that cost less than
   * estimated left the difference reserved against work that had already finished, and the run
   * truncated early for budget it still had. Caught by a test asserting the reservation returns to
   * zero.
   */
  readonly #reservations: number[] = [];
  #inFlight = 0;
  #admitted = 0;
  #refused = 0;
  #outcome: SuiteOutcome = 'completed';

  constructor(options: GuardOptions) {
    this.#options = options;
    this.#startedAtMs = options.nowMs();
  }

  /** What one more scenario is expected to cost: the running mean, or the opening estimate. */
  estimateMicros(): number {
    const billed = this.#costs.filter((cost) => !cost.judge);
    if (billed.length === 0) return this.#options.openingEstimateMicros;
    const total = billed.reduce((sum, cost) => sum + cost.costMicros, 0);
    return Math.ceil(total / billed.length);
  }

  /**
   * May another scenario start?
   *
   * The projection is `spent + inFlight + estimate`, which is rule 1. Refusing marks the suite
   * `budget_truncated` immediately rather than when the run ends: the outcome is a fact about the
   * run from the moment the first scenario is turned away, and deferring it would let a caller
   * report green until the very last line.
   */
  canStart(): boolean {
    if (this.#overTime()) {
      this.#outcome = 'time_truncated';
      this.#refused += 1;
      return false;
    }
    // A zero money cap means money is not this job's bound at all (the local job). Only the clock
    // above can stop it, which is `11` §3.8.4's intent and not a cap of zero dollars.
    if (this.#options.share.capMicros === 0) {
      this.#admitted += 1;
      this.#inFlight += 1;
      return true;
    }

    // Until a real figure exists, admit **one** at a time: with nothing completed, `spent` and
    // `inFlight` are both zero and the projection would wave through every scenario at once.
    const settling = this.#costs.filter((cost) => !cost.judge).length === 0;
    if (settling && this.#inFlight > 0) {
      this.#refused += 1;
      return false;
    }

    const projected = this.#spentMicros + this.#inFlightMicros() + this.estimateMicros();
    if (projected > this.#options.share.capMicros) {
      this.#outcome = 'budget_truncated';
      this.#refused += 1;
      return false;
    }

    this.#admitted += 1;
    this.#inFlight += 1;
    this.#reservations.push(this.estimateMicros());
    return true;
  }

  /** What in-flight work has reserved. Derived, so it cannot drift from the queue. */
  #inFlightMicros(): number {
    return this.#reservations.reduce((sum, reserved) => sum + reserved, 0);
  }

  /**
   * Record a finished scenario.
   *
   * The reservation this scenario made is released in full and the real cost is added to `spent`,
   * so a scenario that cost less than expected returns the difference to the budget rather than
   * leaving it reserved against work that already finished.
   */
  finish(cost: ScenarioCost): void {
    // The reservation is released **before** the cost is recorded, so the amount released is the
    // one that was reserved rather than one computed from a mean the new cost has already moved.
    this.#reservations.shift();
    this.#inFlight = Math.max(0, this.#inFlight - 1);
    this.#costs.push(cost);
    // A judge call is billed to the `judges` share (`11` §3.8.4), so it does not count against the
    // preset under test — folding it in would make the cheap presets look worse than they are,
    // because they run more scenarios and are therefore graded more.
    if (!cost.judge) this.#spentMicros += cost.costMicros;
  }

  /** Record a turn's usage directly, for a caller that has iterations rather than a total. */
  finishWithUsage(
    scenario: string,
    iterations: readonly UsageIteration[],
    costOf: (iteration: UsageIteration) => number,
    options: { readonly judge?: boolean } = {},
  ): void {
    const costMicros = iterations.reduce((sum, iteration) => sum + costOf(iteration), 0);
    this.finish({ scenario, costMicros, judge: options.judge ?? false });
  }

  #overTime(): boolean {
    const capMinutes = this.#options.share.capMinutes;
    if (capMinutes === undefined) return false;
    return this.#options.nowMs() - this.#startedAtMs >= capMinutes * 60_000;
  }

  /** The run's state, for the report and the exit code. */
  state(): GuardState {
    return {
      spentMicros: this.#spentMicros,
      inFlightMicros: this.#inFlightMicros(),
      completed: this.#costs.length,
      admitted: this.#admitted,
      refused: this.#refused,
      outcome: this.#outcome,
    };
  }

  /** Every recorded cost, for the artifact `11` §3.8.4 uploads. */
  costs(): readonly ScenarioCost[] {
    return [...this.#costs];
  }
}
