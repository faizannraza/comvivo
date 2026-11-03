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
import globals from 'globals';
import tseslint from 'typescript-eslint';
import {
  CORE_PURITY_RULES,
  FETCH_ALLOWED_GLOBS,
  FETCH_BAN,
  SECURITY_RULES,
} from './scripts/lint/rules.js';

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
    'test/fixtures/**',
  ]),
  {
    // Parse every TypeScript file with the TypeScript parser, whether or not it is in a project.
    // Without this, anything outside packages/** and apps/** (the repo scripts, for instance) falls
    // back to espree and fails on the first `as`.
    name: 'comvivo/ts-parser',
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tseslint.parser,
      // Globals must be declared or several rules go quiet rather than failing: `no-implied-eval`
      // only fires when `setTimeout` resolves to a known global, so without this it reports
      // nothing at all. Found by the ban test in `test/boundaries/lint-bans.int.test.ts` — a lint
      // rule that is configured but inert is the worst kind of guard.
      globals: { ...globals.node, ...globals.es2024 },
    },
  },
  {
    // The dashboard runs in a browser, not in Node.
    name: 'comvivo/dashboard-globals',
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.es2024 } },
  },
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
    // `01` §4 and §11.4: core is deterministic and side-effect-free. Clock, ids and randomness are
    // injected ports. Rule definitions live in `scripts/lint/rules.ts`, shared with the tests that
    // prove each ban bites (`test/boundaries/lint-bans.test.ts`).
    name: 'comvivo/core-purity',
    files: ['packages/core/**/*.ts'],
    ignores: ['**/*.test.ts', '**/testing/**'],
    rules: CORE_PURITY_RULES,
  },
  {
    // `08` §3.20: code-execution and injection paths with no legitimate use here.
    name: 'comvivo/security-bans',
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    rules: SECURITY_RULES,
  },
  {
    // `08` PSC-8: everything must reach the network through `safeFetch`, which applies the egress
    // allowlist. The equivalent *import* restrictions are in `.dependency-cruiser.cjs`; this covers
    // the `fetch` global, which dependency-cruiser cannot see.
    name: 'comvivo/guarded-egress',
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    ignores: [...FETCH_ALLOWED_GLOBS, '**/*.test.ts', '**/testing/**'],
    rules: FETCH_BAN,
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
    name: 'comvivo/no-type-info',
    files: ['**/*.test.ts', '**/*.bench.ts', '**/*.scenario.ts', 'scripts/**/*.ts', '*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
