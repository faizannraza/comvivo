/**
 * Vitest projects. One project per layer of the pyramid in
 * `docs/plan/11-quality-evals-observability.md` §3.1.1.
 *
 * `test.projects` is the current, non-deprecated mechanism — `vitest.workspace.ts` and
 * `defineWorkspace` were removed in Vitest 4 (`01` §14 A31). Coverage thresholds, strict tags and
 * sharding are completed in **M0-T3**.
 */
import { defineConfig } from 'vitest/config';
import { COMMON_EXCLUDE, NON_UNIT, sharedTest } from './vitest.shared.js';

export default defineConfig({
  test: {
    // The integration, contract, scenario and bench layers are populated by their own milestones
    // (M1 storage, M2/M3 adapters, M3-T43 the harness, M1-T32 benches), so an empty project must
    // not fail the run. The `unit` project is never empty in practice, and M0-T3's coverage ratchet
    // is what guarantees it stays that way.
    passWithNoTests: true,
    projects: [
      {
        test: {
          ...sharedTest,
          name: 'unit',
          // `core` and `shared` are pure, so threads are both faster and what Stryker requires.
          pool: 'threads',
          include: [
            'packages/**/src/**/*.test.ts',
            'apps/*/src/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: [...COMMON_EXCLUDE, ...NON_UNIT],
        },
      },
      {
        test: {
          ...sharedTest,
          name: 'integration',
          // Forks, because these load native modules (SQLCipher, sqlite-vec, onnxruntime).
          pool: 'forks',
          include: ['packages/**/src/**/*.int.test.ts', 'apps/*/src/**/*.int.test.ts'],
          testTimeout: 30_000,
        },
      },
      {
        test: {
          ...sharedTest,
          name: 'contract',
          pool: 'forks',
          include: ['packages/**/src/**/*.contract.test.ts'],
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
          name: 'bench',
          include: ['packages/**/src/**/*.bench.ts'],
        },
      },
    ],
  },
});
