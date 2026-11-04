/**
 * Shared Vitest options, tag definitions and the coverage ratchet.
 *
 * Specification: `docs/plan/11-quality-evals-observability.md` §3.1.1–§3.1.4.
 *
 * Vitest 5 note (`01` §14 A31): projects are declared with `test.projects` in `vitest.config.ts`.
 * The old `vitest.workspace.ts` / `defineWorkspace` was removed in Vitest 4 and now fails
 * **silently**, which is worse than failing loudly — a repo can look configured and run nothing.
 */
import type { UserWorkspaceConfig, ViteUserConfig } from 'vitest/config';

type TestOptions = NonNullable<ViteUserConfig['test']>;

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

/**
 * The closed set of tags (`11` §3.1.3). `strictTags` defaults to true in Vitest 5, so a typo in a
 * test's tag is an error rather than a tag that silently matches nothing — which would quietly
 * exclude a test from every filtered run.
 */
export const TAGS: NonNullable<TestOptions['tags']> = [
  { name: 'prop', description: 'Property-based (fast-check). Run counts rise in nightly.' },
  { name: 'db', description: 'Needs a real SQLite database rather than core port fakes.' },
  { name: 'slow', description: 'Legitimately slow; gets a 30s timeout.', timeout: 30_000 },
  {
    name: 'live',
    description: 'Calls a real model or platform API. Never runs on a pull request.',
    // The only place retries are allowed (`11` §3.1.11), and only for transport errors.
    retry: 2,
  },
  { name: 'chaos', description: 'Kills or stalls the process to test recovery.', timeout: 60_000 },
  {
    name: 'flaky',
    description:
      'Quarantined: has passed and failed on the same commit. Filtered out of required checks, ' +
      'still run nightly. Max 10 at once, 14-day fix-or-delete SLA, and forbidden entirely for ' +
      'core/{ifc,policy}, engine/{context,guard,declassifier,tools-executor}, chaos oracles and ' +
      'red-team suites.',
  },
  { name: 'pi', description: 'Runs only on the Raspberry Pi self-hosted runner.' },
  { name: 'golden', description: 'Compares against a curated golden transcript.' },
];

/**
 * Per-glob coverage targets from `11` §3.1.4. Ordered most specific first, because a file is
 * measured against the first glob it matches.
 *
 * `perFile` must be set on **every** glob: Vitest documents that per-glob thresholds do not
 * inherit the top-level value, so omitting it silently measures the aggregate instead of each file
 * — which lets one well-tested module hide several untested ones (`01` §14 A31).
 */
export const COVERAGE_THRESHOLDS: Record<string, Record<string, number | boolean>> = {
  // The leak and authority guarantees live here. Also the Stryker target (break 75).
  'packages/core/src/{ifc,policy}/**': { lines: 95, branches: 90, perFile: true },
  'packages/engine/src/{context,declassifier,guard,tools-executor}/**': {
    lines: 90,
    branches: 85,
    perFile: true,
  },
  'packages/core/**': { lines: 90, branches: 85, perFile: true },
  'packages/shared/**': { lines: 90, branches: 80, perFile: true },
  'packages/channels/sdk/**': { lines: 90, branches: 80, perFile: true },
  'packages/storage/**': { lines: 85, branches: 75, perFile: true },
  'packages/tools/**': { lines: 85, branches: 75, perFile: true },
  'packages/mcp/**': { lines: 85, branches: 75, perFile: true },
  'packages/plugin-sdk/**': { lines: 85, branches: 75, perFile: true },
  'packages/engine/**': { lines: 85, branches: 75, perFile: true },
  'packages/models/**': { lines: 80, branches: 70, perFile: true },
  'packages/channels/{telegram,discord,slack,web,simulator}/**': {
    lines: 80,
    branches: 70,
    perFile: true,
  },
  // Beta and experimental adapters.
  'packages/channels/{matrix,signal}/**': { lines: 70, branches: 60, perFile: true },
  'apps/server/**': { lines: 75, branches: 65, perFile: true },
  'apps/cli/**': { lines: 70, branches: 60, perFile: true },
  'packages/evals/**': { lines: 70, branches: 60, perFile: true },
  // Journeys are covered by Playwright, so the unit bar is lower on purpose.
  'apps/dashboard/**': { lines: 60, branches: 50, perFile: true },
};

export const COVERAGE_EXCLUDE = [
  '**/testing/**',
  '**/__fixtures__/**',
  '**/*.d.ts',
  '**/*.bench.ts',
  '**/*.test.ts',
  '**/*.config.ts',
  '**/dist/**',
  // Generated: the drizzle metadata and the OpenAPI client are outputs, not code we write.
  'packages/api-client/src/generated/**',
  // `drizzle.config.ts` writes to `./migrations` (`02` §3.1). This read `drizzle/**` until
  // 2026-11-03, naming a directory that will never exist.
  'packages/storage/migrations/**',
  'scripts/**',
  'apps/docs/**',
];

export const sharedTest: UserWorkspaceConfig['test'] = {
  globals: false,
  // Zero retries in required checks (`11` §3.1.11). The `live` tag overrides this for itself.
  retry: 0,
  // A unit test slower than this is an integration test wearing a disguise.
  testTimeout: 5_000,
  hookTimeout: 10_000,
  exclude: [...COMMON_EXCLUDE],
  setupFiles: ['./vitest.setup.ts'],
  tags: TAGS,
  // Restated rather than inherited: Vitest 5 changed this default, and a reader should not have to
  // know the version to know the behaviour.
  clearMocks: true,
  unstubEnvs: true,
  unstubGlobals: true,
};
