/**
 * Dependency boundaries, enforced rather than documented.
 *
 * `docs/plan/01-architecture.md` §4 as amended by §14 A11 is the specification. The architecture
 * stays true only because this file fails the build; never weaken a rule to make an import work.
 *
 * CommonJS on purpose: this repository is `"type": "module"`, and dependency-cruiser's documented
 * ESM-safe config name is `.dependency-cruiser.cjs`.
 *
 * `path` / `pathNot` are **regular expressions**, not globs, matched against the path from the
 * repository root with forward slashes.
 *
 * M0-T1 encodes the package graph. **M0-T4** adds the security import rules (`08` PSC-8), the core
 * purity bans and a planted-violation fixture per rule.
 */

/** Packages that may be imported by anyone. */
const SHARED = '^packages/shared/';
const CORE = '^packages/core/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment:
        'A cycle between modules means the boundary between them is not real. Split the shared ' +
        'part out instead.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'A dependency that cannot be resolved is a typo or a missing package.json entry.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-dev-dep-in-src',
      comment:
        'Production code may only import runtime dependencies. A devDependency that ships is a ' +
        'broken install for every user.',
      severity: 'error',
      from: {
        path: '^(packages|apps)/',
        pathNot: '(\\.test\\.ts$|\\.bench\\.ts$|/testing/|/__fixtures__/)',
      },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'shared-imports-nothing-internal',
      comment: '`shared` is the bottom of the graph (01 §4). It must not import any other package.',
      severity: 'error',
      from: { path: SHARED },
      to: { path: '^packages/', pathNot: SHARED },
    },
    {
      name: 'core-only-imports-shared',
      comment: '`core` is pure domain logic and may import only `shared` (01 §4).',
      severity: 'error',
      from: { path: CORE },
      to: { path: '^packages/', pathNot: `(${CORE}|${SHARED})` },
    },
    {
      name: 'storage-only-core-shared',
      comment: '`storage` implements core ports. It may import only `core` and `shared` (01 §4).',
      severity: 'error',
      from: { path: '^packages/storage/' },
      to: { path: '^packages/', pathNot: `(^packages/storage/|${CORE}|${SHARED})` },
    },
    {
      name: 'models-only-core-shared',
      comment: '`models` holds provider adapters. It may import only `core` and `shared` (01 §4).',
      severity: 'error',
      from: { path: '^packages/models/' },
      to: { path: '^packages/', pathNot: `(^packages/models/|${CORE}|${SHARED})` },
    },
    {
      name: 'channels-never-engine-or-storage',
      comment:
        'Adapters talk to platforms and emit envelopes. They never reach into the engine or the ' +
        'database (01 §4). An adapter that needs engine state wants a wider AdapterContext.',
      severity: 'error',
      from: { path: '^packages/channels/' },
      to: { path: '^(packages/(engine|storage|tools|mcp|plugin-host)|apps)/' },
    },
    {
      name: 'tools-never-storage',
      comment:
        'Tools receive repositories through ToolContext ports so the executor can scope them to a ' +
        'group and an actor. Importing storage directly bypasses that (01 §4).',
      severity: 'error',
      from: { path: '^packages/tools/' },
      to: { path: '^packages/(storage|engine|models|channels)/' },
    },
    {
      name: 'engine-never-storage-or-models',
      comment:
        'The engine depends on ports, not implementations: `apps/server` wires the concrete ' +
        'storage and model adapters in (01 §4).',
      severity: 'error',
      from: { path: '^packages/engine/' },
      to: { path: '^packages/(storage|models)/' },
    },
    {
      name: 'plugin-sdk-is-public-surface-only',
      comment:
        'The plugin SDK is semver-stable third-party surface. It may import `core` and `shared` ' +
        'types and `channels/sdk` types only (01 §14 A11).',
      severity: 'error',
      from: { path: '^packages/plugin-sdk/' },
      to: {
        path: '^packages/',
        pathNot: `(^packages/plugin-sdk/|${CORE}|${SHARED}|^packages/channels/sdk/)`,
      },
    },
    {
      name: 'mcp-engine-public-only',
      comment: "`mcp` may use the engine's public service interfaces, never storage (01 §4).",
      severity: 'error',
      from: { path: '^packages/mcp/' },
      to: { path: '^packages/(storage|models|channels)/' },
    },
    {
      name: 'dashboard-only-api-client',
      comment:
        'The dashboard is a browser SPA. It talks to the server over HTTP through the generated ' +
        'client and must never bundle server-side code (01 §4).',
      severity: 'error',
      from: { path: '^apps/dashboard/' },
      to: { path: '^packages/', pathNot: '^packages/api-client/' },
    },
    {
      name: 'testing-subpath-only-from-tests',
      comment:
        '`*/testing` holds test doubles. Importing one from production code means a fake can reach ' +
        'a user (11 §3.1.2). The one documented exception is apps/server/src/test-mode/**.',
      severity: 'error',
      from: {
        path: '^(packages|apps)/',
        pathNot:
          '(\\.test\\.ts$|\\.bench\\.ts$|\\.scenario\\.ts$|/testing/|/__fixtures__/|^packages/evals/|^apps/server/src/test-mode/)',
      },
      to: { path: '/testing/' },
    },
  ],
  options: {
    doNotFollow: { path: '(node_modules|/dist/)' },
    exclude: {
      path: '(/\\.turbo/|/\\.vitest/|^packages/api-client/src/generated/)',
    },
    // Type-only imports are architecture too: `import type { Db } from '@comvivo/storage'` couples
    // two packages just as much as a value import, and several of the §4 rules exist precisely to
    // allow *types only* across a boundary.
    tsPreCompilationDeps: true,
    // `tsconfig.depcruise.json` maps every `@comvivo/*` specifier to that package's `src/index.ts`,
    // so the graph is the architecture rather than whatever happens to be built. Without it every
    // workspace import resolves into `dist/`, which the old `/dist/` exclude then swallowed — so
    // the cross-package rules were silently enforcing nothing. Caught by planting a violation.
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    // Each workspace package resolves against its own package.json, which is what independent
    // packages require.
    combinedDependencies: false,
    reporterOptions: {
      archi: { collapsePattern: '^(packages|apps)/[^/]+/' },
      text: { highlightFocused: true },
    },
  },
};
