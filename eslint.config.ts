/**
 * typescript-eslint, scoped deliberately narrowly.
 *
 * Biome owns formatting and the fast non-type-aware lint pass (ADR-003). typescript-eslint is here
 * for one reason: the **type-aware** rules, which Biome's own engine only offers as nursery rules at
 * `information` severity. Those four rules are load-bearing for this codebase, not stylistic:
 *
 * - `no-floating-promises`    a dropped promise in the actor/outbox/job loop silently loses a
 *                             reminder or an outbound message, breaking I6 and I7.
 * - `no-misused-promises`     an async function used where a sync predicate is expected always
 *                             reads truthy; in the policy engine or the disclosure guard that is a
 *                             silent `allow`.
 * - `switch-exhaustiveness-check`  a new `PolicyDecision` / `FlowDecision` / `ToolOutcome` variant
 *                             must break the build, not fall through (`01` §11.3).
 * - `strict-boolean-expressions`   with `noUncheckedIndexedAccess`, `if (x)` on a possibly
 *                             `undefined` label is exactly the bug class that mislabels data.
 *
 * This is why TypeScript is pinned to 6.x: typescript-eslint cannot run on TS 7 yet. See
 * `docs/adr/ADR-025-typescript-version-pin.md` and `01` §14 A31.
 *
 * The remaining core purity bans (`Date`, `Math.random`, `process`) and the planted-violation
 * fixtures that prove every rule bites land in **M0-T4**.
 */
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/dist/**',
    '**/node_modules/**',
    '**/.turbo/**',
    '**/.vitest/**',
    '**/coverage/**',
    '**/reports/**',
    'packages/api-client/src/generated/**',
    'apps/docs/.astro/**',
  ]),
  {
    name: 'comvivo/type-aware',
    files: ['packages/**/*.ts', 'apps/**/*.ts'],
    // Test files, benches and scenarios are excluded from the emitting TS projects so they never
    // reach `dist`, which means the project service cannot type them. They are still fully
    // typechecked, by `tsc -p tsconfig.test.json` in `pnpm typecheck`.
    ignores: ['**/*.test.ts', '**/*.bench.ts', '**/*.scenario.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      // Keep this config to its one job. Everything stylistic belongs to Biome, and running both
      // would produce contradictory fixes.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        {
          allowDefaultCaseForExhaustiveSwitch: false,
          considerDefaultExhaustiveForUnions: false,
          requireDefaultForNonUnion: true,
        },
      ],
    },
  },
  {
    // `strict-boolean-expressions` is required in `core`, where a truthiness slip on a label or a
    // member becomes an information-flow bug. Elsewhere it is advisory for now and tightens in M0-T4.
    name: 'comvivo/core-strictness',
    files: ['packages/core/**/*.ts'],
    rules: {
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        { allowNumber: false, allowString: false, allowNullableObject: false },
      ],
    },
  },
  {
    // Doubles and fixtures legitimately need looser typing than production code.
    name: 'comvivo/testing-helpers',
    files: ['**/testing/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    name: 'comvivo/tests-no-type-info',
    files: ['**/*.test.ts', '**/*.bench.ts', '**/*.scenario.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
