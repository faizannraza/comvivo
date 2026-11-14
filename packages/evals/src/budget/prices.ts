/**
 * The budget shares for a live eval run (`11` §3.8.4; `M2-T19`).
 *
 * `11` §3.8.4's table, as data. The shares matter because they are the **only** thing standing
 * between a nightly suite and an unbounded bill: a run that scheduled scenarios until it finished
 * would, on a bad night with a retry storm, spend whatever it spent and tell nobody until the
 * invoice arrived.
 *
 * Two properties the table has that the code must preserve:
 *
 *  - **Judge calls are billed to `judges`, not to the preset under test.** §3.8.4 says so, and the
 *    reason is comparability: a preset's share has to measure what that preset costs to *run*, and
 *    folding in the cost of grading it would make the cheap presets look worse than they are
 *    (they get graded more, because they run more scenarios).
 *  - **`local` has a time cap and a zero money cap.** A local model costs nothing and can run
 *    forever, so money is the wrong bound and wall-clock is the right one.
 */

/** One job's share of the run's budget. */
export interface BudgetShare {
  readonly job: string;
  /** Micro-USD. `0` for a job that spends no money (the local one). */
  readonly capMicros: number;
  /**
   * A wall-clock ceiling, for a job whose cost is time rather than money.
   *
   * `undefined` for the paid jobs: their bound is the money, and a time cap there would truncate a
   * run that was still inside its budget — which `11` §3.8.4 counts as yellow rather than green,
   * so it must not happen for a reason that is not the budget.
   */
  readonly capMinutes?: number;
}

/** `11` §3.8.4's nightly matrix. Total **$20**. */
export const NIGHTLY_SHARES: readonly BudgetShare[] = Object.freeze([
  Object.freeze({ job: 'economy', capMicros: 5_000_000 }),
  Object.freeze({ job: 'balanced', capMicros: 3_500_000 }),
  Object.freeze({ job: 'best', capMicros: 4_000_000 }),
  Object.freeze({ job: 'openai', capMicros: 2_500_000 }),
  // Zero money, 90 minutes. `11` §3.8.4: a local model's cost is wall-clock.
  Object.freeze({ job: 'local', capMicros: 0, capMinutes: 90 }),
  Object.freeze({ job: 'extraction-retrieval', capMicros: 1_000_000 }),
  // Every judge call from every job, which is why it is the second-largest share.
  Object.freeze({ job: 'judges', capMicros: 4_000_000 }),
]);

/** `11` §3.8.4's stated total, in micro-USD. Asserted against the shares, never derived from them. */
export const NIGHTLY_TOTAL_MICROS = 20_000_000;

/**
 * The live **smoke** share (`M2-T19`).
 *
 * Far smaller than a nightly share, and separate from the table above because it answers a
 * different question: the smoke proves the adapters can talk to the real providers, not that the
 * presets are any good. Five scenarios across three providers at `low` effort is cents, so the cap
 * is set at a figure that is unmistakably an accident if it is ever reached.
 */
export const SMOKE_CAP_MICROS = 500_000;

/** One job's share, by name. */
export function shareFor(
  job: string,
  shares: readonly BudgetShare[] = NIGHTLY_SHARES,
): BudgetShare | undefined {
  return shares.find((share) => share.job === job);
}
