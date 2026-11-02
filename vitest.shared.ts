/**
 * Shared Vitest options every project and package config merges.
 *
 * `docs/plan/11-quality-evals-observability.md` §3.1.3 is the specification. Note for Vitest 5
 * (`01` §14 A31): projects are declared with `test.projects` in `vitest.config.ts` — the old
 * `vitest.workspace.ts` / `defineWorkspace` was removed in Vitest 4 and now fails *silently*.
 */
import type { UserWorkspaceConfig } from 'vitest/config';

/** Test files that are never unit tests, whatever glob picked them up. */
export const NON_UNIT = [
  '**/*.int.test.ts',
  '**/*.contract.test.ts',
  '**/*.scenario.ts',
  '**/*.bench.ts',
] as const;

export const COMMON_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.turbo/**',
  '**/.vitest/**',
  '**/__fixtures__/**',
] as const;

export const sharedTest: UserWorkspaceConfig['test'] = {
  globals: false,
  // Zero retries in required checks (11 §3.1.11). The only exception is the `live` tag, which the
  // live workflows set explicitly.
  retry: 0,
  // A unit test that takes longer than this is an integration test wearing a disguise.
  testTimeout: 5_000,
  hookTimeout: 10_000,
  exclude: [...COMMON_EXCLUDE],
  setupFiles: ['./vitest.setup.ts'],
  // Vitest 5 defaults `clearMocks` to true; stated here so it is not mistaken for inheritance.
  clearMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
};
