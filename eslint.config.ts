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
import type { Linter } from 'eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import {
  CORE_PURITY_RULES,
  FETCH_ALLOWED_GLOBS,
  FETCH_BAN,
  RAW_TRANSACTION_ALLOWED_GLOBS,
  RAW_TRANSACTION_BAN,
  RAW_TX_AND_UNFILTERED_EXEMPT_GLOBS,
  SECURITY_RULES,
  SYNC_TX_BAN,
  UNFILTERED_ALLOWED_GLOBS,
  UNFILTERED_READ_BAN,
} from './scripts/lint/rules.js';

/**
 * The selectors from one `no-restricted-syntax` rules record, without the severity.
 *
 * ESLint flat config **replaces** a rule's options rather than merging them — the defect that left
 * core's `Date` ban inert for most of M0 — so every block that sets `no-restricted-syntax` has to
 * restate every selector that should apply to its paths. This makes that composition readable
 * instead of a line of `.slice(1)` casts, and `test/boundaries/lint-bans.int.test.ts` asserts the
 * **effective options** per path, which is the assertion that would have caught the original.
 */
const selectors = (rules: typeof SECURITY_RULES): unknown[] =>
  (rules['no-restricted-syntax'] as unknown[]).slice(1);

/** One `no-restricted-syntax` rules record from a selector list. */
const restrict = (list: readonly unknown[]): Linter.RulesRecord => ({
  'no-restricted-syntax': ['error', ...list] as unknown as Linter.RuleEntry,
});

/**
 * Every `no-restricted-syntax` block, one per exemption class.
 *
 * Four bans share this one rule, and two of them have allowlists:
 *
 * | ban | applies to |
 * |---|---|
 * | `08` §3.20 security selectors | all of `packages/**`, `apps/**` |
 * | `01` §1 synchronous transactions | all of `packages/**`, `apps/**` — tests included |
 * | `02` §3.7.2 single transaction entry | except `tx.ts` and the spike |
 * | `02` §3.7.1 `…Unfiltered` reads | except the allowlisted callers, tests and doubles |
 *
 * ESLint flat config **replaces** a rule's options rather than merging them, and the **last
 * matching block wins**. So a block cannot "add" a ban: whichever block matches last decides the
 * whole list for that path, and every other block's selectors vanish from it. Two independent
 * allowlists therefore produce **four** path classes, each of which has to restate its own union.
 *
 * Both halves of that have already bitten this repository. `comvivo/guarded-egress` silently took
 * core's `Date` and `process` bans away for most of M0 — found at the exit gate by planting
 * `new Date()` in `core` and finding `pnpm lint` green. And the first version of *this* function
 * put the raw-transaction ban on one block with `ignores` for the spike, which a later block
 * overrode: the spike's three legitimate `db.transaction()` calls were flagged, and `tx.ts` — the
 * transaction implementation itself — was handed back the `…Unfiltered` ban it is allowlisted
 * against.
 *
 * Hence the enumerated intersection in `scripts/lint/rules.ts`: flat config's `files`/`ignores`
 * pair can only subtract, so the overlap of two allowlists cannot be expressed and has to be
 * named. `test/boundaries/lint-bans.int.test.ts` asserts the **effective options** for a
 * representative path in each of the four classes, which is the only assertion that catches this.
 */
function restrictedSyntaxBlocks(): ReturnType<typeof defineConfig> {
  const files = ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'];
  const base = [...selectors(SECURITY_RULES), ...selectors(SYNC_TX_BAN)];
  const rawTx = selectors(RAW_TRANSACTION_BAN);
  const unfiltered = selectors(UNFILTERED_READ_BAN);
  const unfilteredExempt = [...UNFILTERED_ALLOWED_GLOBS, '**/*.test.ts', '**/testing/**'];

  return defineConfig(
    {
      // 1. Neither exemption: the full set.
      name: 'comvivo/restricted-syntax',
      files,
      rules: restrict([...base, ...rawTx, ...unfiltered]),
    },
    {
      // 2. Tests, doubles and the allowlisted `…Unfiltered` callers.
      name: 'comvivo/restricted-syntax-unfiltered-exempt',
      files: unfilteredExempt,
      rules: restrict([...base, ...rawTx]),
    },
    {
      // 3. The transaction implementation and the spike, which measures the driver itself.
      //
      //    No `ignores` for the overlap: block 4 comes **after** this one and last-wins, which is
      //    what actually hands it the both-exempt paths. An `ignores` here looked like the
      //    mechanism and was removed once it was shown to be inert — removing it changes nothing,
      //    while removing block 4 fails two cases in `lint-bans.int.test.ts`. **The ordering is
      //    the mechanism**, so do not reorder these.
      name: 'comvivo/restricted-syntax-raw-tx-exempt',
      files: [...RAW_TRANSACTION_ALLOWED_GLOBS],
      rules: restrict([...base, ...unfiltered]),
    },
    {
      // 4. Both, because the allowlists overlap: `tx.ts` is under `packages/storage/src/**`, and a
      //    spike test is a test.
      name: 'comvivo/restricted-syntax-both-exempt',
      files: [...RAW_TX_AND_UNFILTERED_EXEMPT_GLOBS],
      rules: restrict(base),
    },
  );
}

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
    // `.tsx` as well as `.ts`. The M0 independent review found the glob covered only `.ts`, so
    // `no-floating-promises`, `no-misused-promises` and `switch-exhaustiveness-check` — the three
    // `CLAUDE.md` §2 names as non-negotiable — would have been absent from every dashboard
    // component from M9 onward, silently.
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    // Test files, benches and scenarios are excluded from the emitting TS projects so they never
    // reach `dist`, which means the project service cannot type them. They are still fully
    // typechecked, by `tsc -p tsconfig.test.json` in `pnpm typecheck`.
    ignores: [
      '**/*.test.{ts,tsx}',
      '**/*.bench.ts',
      '**/*.scenario.ts',
      // Build tooling at a package root: see `comvivo/scripts-type-aware` below.
      'packages/*/*.config.ts',
      // Spike helpers live outside `src/`, so the project service cannot type them either. See
      // `comvivo/spike-helpers` below, which names `tsconfig.test.json` explicitly.
      'packages/*/spike/**/*.ts',
    ],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true },
    },
    rules: {
      // Keep this config to its one job. Everything stylistic belongs to Biome, and running both
      // would produce contradictory fixes.
      // A leading underscore marks a parameter kept to satisfy an interface's shape rather than
      // to be used — `generate(prefix, _brand)` implements `IdGenerator` without needing the brand
      // at runtime, since it is a phantom type.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
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
    // `no-restricted-syntax` is deliberately **not** set here — `restrictedSyntaxBlocks()` below
    // owns every path's selector list, because flat config replaces options rather than merging
    // them and two blocks setting the same rule on overlapping paths is how one silently wins.
    rules: Object.fromEntries(
      Object.entries(SECURITY_RULES).filter(([rule]) => rule !== 'no-restricted-syntax'),
    ),
  },
  {
    // `08` PSC-8: everything must reach the network through `safeFetch`, which applies the egress
    // allowlist. The equivalent *import* restrictions are in `.dependency-cruiser.cjs`; this covers
    // the `fetch` global, which dependency-cruiser cannot see.
    name: 'comvivo/guarded-egress',
    files: ['packages/**/*.{ts,tsx}', 'apps/**/*.{ts,tsx}'],
    // `packages/core/**` is excluded because `comvivo/core-purity` above already carries the fetch
    // ban as part of its own `no-restricted-globals`. ESLint flat config **replaces** a rule's
    // options rather than merging them, so a block that matched core here would silently take the
    // `Date` and `process` bans away — which is exactly what happened for most of M0, and what
    // the exit gate caught by planting `new Date()` in core and finding `pnpm lint` green.
    ignores: ['packages/core/**', ...FETCH_ALLOWED_GLOBS, '**/*.test.ts', '**/testing/**'],
    rules: FETCH_BAN,
  },
  ...restrictedSyntaxBlocks(),
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
    // The guards get the type-aware rules too, via `tsconfig.scripts.json`.
    //
    // They were previously in `no-type-info` below, which meant a floating promise in a guard —
    // the one place it is most expensive, because the guard then exits 0 having checked nothing —
    // was not reported. Found by the M0 independent review.
    name: 'comvivo/scripts-type-aware',
    // `packages/*/drizzle.config.ts` belongs here, not in `comvivo/type-aware`: it sits at a
    // package root, outside that package's `include`, so the project service cannot type it —
    // which is how `scripts/**` ended up with 24 files of configured-but-inert rules during M0.
    // `tsconfig.scripts.json` covers it instead.
    files: ['scripts/**/*.ts', 'tools/**/*.ts', 'packages/*/*.config.ts'],
    ignores: ['**/*.test.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      // `project`, not `projectService`. The service discovers the nearest `tsconfig.json`, and
      // there is none under `scripts/` — the root one is a solution file with only `references`.
      // So `projectService: true` left every rule here configured and **inert**: 24 files reported
      // "was not found by the project service" rather than being checked. Naming the tsconfig that
      // actually covers them is what makes the rules run.
      parserOptions: {
        project: ['./tsconfig.scripts.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A guard reads untyped JSON and YAML by nature, so the unsafe-* family would fire on every
      // boundary read. The four rules `CLAUDE.md` §2 calls non-negotiable stay on; the rest of
      // `strictTypeChecked`'s unsafe-value rules are the ones a parser legitimately trips.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // A script's whole job is to print and exit.
      'no-console': 'off',
      // The same three rules, with the same options, as `comvivo/type-aware`. Set explicitly
      // because `switch-exhaustiveness-check` is not part of `strictTypeChecked`.
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
    // The storage spike's helpers (`02` M1-T2 keeps the suite permanently). They sit in
    // `packages/*/spike/`, outside the package's `include`, so `projectService` reports them as
    // "not found by the project service" and every type-aware rule goes inert — the M0 defect, in
    // a new directory. `tsconfig.test.json` covers them; naming it is what makes the rules run.
    name: 'comvivo/spike-helpers',
    files: ['packages/*/spike/**/*.ts'],
    ignores: ['**/*.test.ts'],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A spike talks to an untyped native module by nature.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
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
    // `.mjs` and `.cjs` had **no** ESLint block at all, so `tools/changelog/index.mjs`,
    // `scripts/pending.mjs` and `.dependency-cruiser.cjs` were linted by Biome only — which does
    // cover `eval` and `any`, but none of the ESLint-only rules. Found by the M0 independent
    // review. Not type-aware: they are not in a TS project, and `projectService` would report
    // them as not found, which is how a rule ends up configured and inert.
    name: 'comvivo/plain-javascript',
    files: ['**/*.{mjs,cjs,js}'],
    ignores: ['**/dist/**', '**/node_modules/**'],
    languageOptions: { globals: { ...globals.node, ...globals.es2024 } },
    rules: {
      ...SECURITY_RULES,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    name: 'comvivo/no-type-info',
    files: ['**/*.test.{ts,tsx}', '**/*.bench.ts', '**/*.scenario.ts', '*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
