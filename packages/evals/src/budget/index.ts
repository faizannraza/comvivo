/**
 * Live eval budgets (`11` §3.8.4; `M2-T19`).
 *
 * | Module | What |
 * |---|---|
 * | `prices` | `11` §3.8.4's share table, as data |
 * | `guard` | `EvalBudgetGuard`: projects, refuses, and makes a truncated run yellow |
 */
export {
  EvalBudgetGuard,
  type GuardOptions,
  type GuardState,
  isGreen,
  type ScenarioCost,
  type SuiteOutcome,
} from './guard.js';
export {
  type BudgetShare,
  NIGHTLY_SHARES,
  NIGHTLY_TOTAL_MICROS,
  SMOKE_CAP_MICROS,
  shareFor,
} from './prices.js';
