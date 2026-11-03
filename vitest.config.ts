/**
 * Vitest projects — one per layer of the pyramid in
 * `docs/plan/11-quality-evals-observability.md` §3.1.1.
 *
 * `test.projects` is the current mechanism; `vitest.workspace.ts` and `defineWorkspace` were
 * removed in Vitest 4 and now fail silently (`01` §14 A31).
 */
import { defineConfig } from 'vitest/config';
import {
  COMMON_EXCLUDE,
  COVERAGE_EXCLUDE,
  COVERAGE_THRESHOLDS,
  NON_UNIT,
  sharedTest,
} from './vitest.shared.js';

// Pin the environment here, in the main process, **before Vitest forks any worker**. Workers
// inherit it, which is the only placement that actually works: a worker gets a copy of
// `process.env`, so assigning to it from a setup file sets the variable without triggering Node's
// timezone-change notification — the suite then reports TZ=UTC while formatting dates in the
// host's zone. `vitest.setup.ts` repeats the assignment as a second layer, and
// `scripts/harness/network-guard.test.ts` asserts the *behaviour* (`getHours()`), not the variable,
// so this cannot regress unnoticed. (`11` §3.1.3)
process.env['TZ'] = 'UTC';
process.env['LANG'] = 'C.UTF-8';
process.env['COMVIVO_TEST_MODE'] = '1';

const CI = process.env['CI'] === 'true' || process.env['CI'] === '1';

export default defineConfig({
  test: {
    // The integration, contract, scenario and bench layers are populated by their own milestones
    // (M1 storage, M2/M3 adapters, M3-T43 the harness, M1-T32 benches), so an empty project must
    // not fail the run. The `unit` project is never empty in practice, and the coverage ratchet is
    // what keeps it that way.
    passWithNoTests: true,

    // Locally: readable. In CI: `junit` for the GitHub test summary and `json` for the quality
    // trend site.
    //
    // `blob` is deliberately NOT here. It belongs on the sharded `unit` command in `ci.yml`
    // (`--reporter=blob`), because Vitest refuses `--merge-reports` while a blob reporter is
    // configured — "Cannot merge reports when `--reporter=blob` is used. Remove blob reporter from
    // the config first." Having it in the config made the `coverage` job impossible to write, and
    // in a way that only showed up once the job existed.
    reporters: CI ? ['default', 'junit', 'json'] : ['default'],
    // Spread rather than `outputFile: … : undefined`, because `exactOptionalPropertyTypes`
    // distinguishes an absent property from one explicitly set to undefined — and here it is
    // right to.
    ...(CI ? { outputFile: { junit: '.vitest/junit.xml', json: '.vitest/results.json' } } : {}),

    // Benchmarks: the globs are declared here, at the root, because `benchmark` is listed in
    // Vitest 5's `UnsupportedProperties` for *project* configs — `11` §3.1.3's "bench project" is
    // not expressible any more.
    //
    // They do not run yet. Vitest 5.0.5 exposes no usable `bench` API: it is not exported from
    // `vitest`, not from `vitest/runtime` or `vitest/node`, and not injected as a global even with
    // `globals: true`, and there is no `@vitest/bench` package (both names 404 on the registry).
    // Verified directly, not inferred. `M1-T32` owns bench infrastructure and decides between a
    // purpose-built harness and a Vitest version where this works — and a purpose-built one is
    // probably right regardless, because `01` §11.10 and `11` §8 specify *percentile* budgets over
    // realistic workloads, which a micro-benchmark runner measures poorly. The globs stay so the
    // files are already in the right place. See STATUS → Plan changes.
    benchmark: {
      include: ['packages/**/src/**/*.bench.ts', 'scripts/**/*.bench.ts'],
      exclude: [...COMMON_EXCLUDE],
    },

    coverage: {
      provider: 'v8',
      reporter: CI ? ['text-summary', 'json', 'lcov'] : ['text', 'html'],
      reportsDirectory: 'coverage',
      exclude: [...COVERAGE_EXCLUDE],
      // Every tier that runs in process counts toward coverage, scenarios included — that is how
      // the guarantees are actually exercised (`11` §3.1.4). Vitest 5 removed the `all` option and
      // made that the behaviour, so there is nothing to set.
      // Thresholds are whole-tree, so a **shard** cannot meet them: each one runs a third of the
      // files and legitimately covers a third of the code. `ci.yml`'s `unit` shards therefore set
      // `COMVIVO_COVERAGE_THRESHOLDS=off` and the `coverage` job enforces them once over the
      // merged reports. Measured, not assumed: with thresholds on, all three shards exit 1.
      ...(process.env['COMVIVO_COVERAGE_THRESHOLDS'] === 'off'
        ? {}
        : { thresholds: COVERAGE_THRESHOLDS }),
      // Vitest 5 removed `all` and `autoUpdate`. The ratchet `11` §3.1.4 asks for is a separate
      // mechanism anyway — `quality/coverage-baseline.json` plus a weekly job that raises it — and
      // is built with the coverage CI job in M0-T11.
    },

    projects: [
      {
        test: {
          ...sharedTest,
          name: 'unit',
          // Threads: `core` and `shared` are pure, and Stryker requires them.
          pool: 'threads',
          include: [
            'packages/**/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            'scripts/**/*.test.ts',
            'test/**/*.test.ts',
          ],
          exclude: [...COMMON_EXCLUDE, ...NON_UNIT, 'apps/dashboard/**'],
        },
      },
      {
        test: {
          ...sharedTest,
          name: 'integration',
          // Forks: these load native modules (SQLCipher, sqlite-vec, onnxruntime).
          pool: 'forks',
          include: [
            'packages/**/src/**/*.int.test.ts',
            'apps/*/src/**/*.int.test.ts',
            'test/**/*.int.test.ts',
          ],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          ...sharedTest,
          name: 'contract',
          pool: 'forks',
          include: ['packages/**/src/**/*.contract.test.ts', 'test/**/*.contract.test.ts'],
        },
      },
      {
        test: {
          ...sharedTest,
          name: 'scenario',
          pool: 'forks',
          include: ['packages/evals/scenarios/**/*.scenario.ts'],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          ...sharedTest,
          name: 'dashboard',
          environment: 'jsdom',
          include: ['apps/dashboard/src/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
