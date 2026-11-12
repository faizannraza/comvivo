/**
 * `@comvivo/evals`
 *
 * The simulation harness: persona agents, the scenario DSL, red-team suites, property-test arbitraries, judges and metrics. Published so plugin authors can use the simulator kit.
 *
 * Scaffolded by M0-T1. The implementation lands in this package's own milestone; see
 * `docs/plan/14-milestones.md`.
 */

export {
  type BenchDefinition,
  type BenchEnv,
  BenchEnvSchema,
  BenchIdSchema,
  type BenchOptions,
  type BenchProfile,
  BenchProfileSchema,
  type BenchResult,
  BenchResultSchema,
  currentEnv,
  defineBench,
  type EnvSources,
  type ErasedBench,
  type GabEntry,
  measure,
  median,
  runSuite,
  toGab,
  toGabEntry,
} from './perf/index.js';
