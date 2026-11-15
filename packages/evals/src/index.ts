/**
 * `@comvivo/evals`
 *
 * The simulation harness: persona agents, the scenario DSL, red-team suites, property-test arbitraries, judges and metrics. Published so plugin authors can use the simulator kit.
 *
 * Scaffolded by M0-T1. The implementation lands in this package's own milestone; see
 * `docs/plan/14-milestones.md`.
 *
 * `FakeProviderServer` was built here at `M2-T10` and moved to `@comvivo/models/testing` at
 * `M2-T6`: this package depends on `@comvivo/models`, so a provider fake here cannot serve that
 * package's own adapter tests without a cycle Turborepo refuses. `11` §3.2.4's table already put
 * every model double in `models/testing`; the worst-case behavioural models (`LeakyModel`,
 * `GreedyToolModel`, `GullibleModel`) still belong here, and so will `SimPlatformServer`.
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
