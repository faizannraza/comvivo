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
  WORKSPACE_ALIASES,
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
  // Every `@comvivo/*` import resolves to **source**, not to a package's `dist/`.
  //
  // Without this a test that imports a sibling package needs that package built first, so it
  // passes on a machine that has built recently and fails on a fresh checkout with "Failed to
  // resolve entry for package". That is the same shape as M0-T18's `.astro` types: a local check
  // that is weaker than CI's while printing the same result. Built from `tsconfig.paths.json`, the
  // one file dependency-cruiser and the test typecheck also read.
  resolve: { alias: WORKSPACE_ALIASES },
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

    // No `benchmark` block: `M1-T32` built the harness instead.
    //
    // Vitest 5.0.5 exposes no usable `bench` API — re-verified at `M1-T32` rather than inherited
    // from the note `M0` left here: `bench` is not exported from `vitest`, `vitest/runtime` or
    // `vitest/node`, is not injected as a global with `globals: true`, and there is no
    // `@vitest/bench` package. And the second reason that note gave turned out to be the deciding
    // one: every budget in `01` §11.10 and `11` §3.9.1 is a **percentile over a realistic
    // workload**, which a micro-benchmark runner reports poorly.
    //
    // So `*.bench.ts` files default-export an array of `BenchDefinition` and `pnpm bench`
    // (`scripts/bench/run.ts`) discovers, runs and records them. `COMMON_EXCLUDE` keeps them out
    // of the test projects, and `packages/evals/src/perf/*.test.ts` is where the harness itself is
    // tested. See STATUS → Plan changes.

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
          /*
           * Forks, since 2026-11-14.
           *
           * This was `threads`, justified as "`core` and `shared` are pure, and Stryker requires
           * them". Both halves were false, and the `include` below says so: the glob is every
           * package, app, script and tool plus the `test/` tree, not two pure packages. And
           * Stryker does not use this project at all — `packages/core/stryker.config.json` points
           * at `packages/core/vitest.mutation.config.ts` and sets `"pool": "forks"` itself, which
           * is the opposite of what the comment claimed it needed.
           *
           * It matters because `vitest run` died twice in two days with exit 139 and exit 138,
           * both times partway through **this** tier (`M2-T11`'s gate on 2026-11-13, `M2-T19`'s on
           * 2026-11-14), with no failing test and the next run green. Not reproduced since: 10
           * dedicated runs of this project plus three full `pnpm verify` runs on Node 26.13.0 are
           * all clean, so this is not a claimed fix. It removes the one difference between this
           * tier and the four below it that had no reason behind it, and process isolation is the
           * safer default for a tier this broad.
           *
           * Measured cost: 15.4 s → 16.7 s for 3 979 tests, +9%.
           */
          pool: 'forks',
          include: [
            'packages/**/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            'scripts/**/*.test.ts',
            // `12` §3.10.4 puts release tooling in `tools/` — the changelog formatter, the notes
            // composer — and its grouping logic is exactly the kind of thing that needs tests.
            'tools/**/*.test.ts',
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
            // `02` M1-T2 keeps the storage spike as a permanent regression suite, and it lives
            // outside `src/` — so without this glob it would have been written once and never run
            // again, which makes it a record of what was true in November rather than a guard.
            'packages/*/spike/**/*.spike.test.ts',
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
