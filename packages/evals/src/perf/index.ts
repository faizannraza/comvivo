/**
 * `@comvivo/evals` performance benchmarking (`11` §3.9).
 *
 * | Module | What |
 * |---|---|
 * | `bench-result` | The result shape, its zod schema, its budget verdict, and the machine and commit it came from |
 * | `runner` | The warm-up → N iterations → 5 repetitions protocol, over an HDR histogram |
 * | `to-gab` | The converter to github-action-benchmark's `customSmallerIsBetter` JSON |
 *
 * `scripts/bench/run.ts` is the CLI that discovers `*.bench.ts` suites and writes the JSON; the
 * benchmarks themselves live beside the code they measure.
 */
export {
  type BenchEnv,
  BenchEnvSchema,
  BenchIdSchema,
  type BenchProfile,
  BenchProfileSchema,
  type BenchResult,
  BenchResultSchema,
  budgetShare,
  budgetVerdict,
  currentEnv,
  type EnvSources,
  largerIsBetter,
} from './bench-result.js';
export {
  type BenchDefinition,
  type BenchOptions,
  defineBench,
  type ErasedBench,
  measure,
  median,
  runSuite,
} from './runner.js';
export { type GabEntry, toGab, toGabEntry } from './to-gab.js';
