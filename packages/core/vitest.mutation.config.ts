/**
 * The Vitest configuration Stryker runs against (`11` §3.1.5).
 *
 * A config of its own, not the root one, for a reason the root config makes unavoidable: it
 * defines five **projects** (unit, integration, contract, scenario, dashboard), and Stryker starts
 * a Vitest instance per mutant. Pointing it at the root config would make every mutant discover
 * the integration and scenario tiers as well — database work, for a package whose own tests are
 * pure by construction (`01` §4). So this one includes exactly `packages/core`'s tests, and
 * inherits `vitest.shared.ts` so a timeout or tag change stays in one place.
 */
import { defineConfig } from 'vitest/config';
import { sharedTest } from '../../vitest.shared.js';

const repoRoot = new URL('../../', import.meta.url).pathname;

export default defineConfig({
  test: {
    ...sharedTest,
    name: 'core-mutation',
    root: new URL('.', import.meta.url).pathname,
    include: ['src/**/*.test.ts'],
    // `setupFiles` is restated because `sharedTest` names it relatively (`./vitest.setup.ts`) and
    // this config's root is the package, not the repository.
    setupFiles: [`${repoRoot}vitest.setup.ts`],
    // Property suites are `11` §3.1.6's job at 500 cases each, which is the right number for
    // finding a counterexample and the wrong one to repeat per mutant. There are none in core
    // today; the exclusion is here so adding one does not quietly multiply a mutation run.
    exclude: ['src/**/*.prop.test.ts', '**/node_modules/**', '**/dist/**'],
    coverage: { enabled: false },
  },
});
