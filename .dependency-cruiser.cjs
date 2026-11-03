/**
 * Dependency boundaries, enforced rather than documented.
 *
 * Specification: `docs/plan/01-architecture.md` §4 as amended by §14 **A11**, plus the security
 * import restrictions resolved from `08` **PSC-8** into A11. The architecture stays true only
 * because this file fails the build; **never weaken a rule to make an import work.**
 *
 * CommonJS on purpose: this repository is `"type": "module"`, and dependency-cruiser's documented
 * ESM-safe config name is `.dependency-cruiser.cjs`.
 *
 * `path` / `pathNot` are **regular expressions**, not globs, matched against the path from the
 * repository root with forward slashes.
 *
 * Every rule here is covered twice (`M0-T4`):
 *   - `test/boundaries/rules.test.ts` asserts each rule's regexes against representative paths, so
 *     a rule is proven correct even when the modules it protects do not exist yet;
 *   - `test/boundaries/fixtures.test.ts` cruises the planted violations under
 *     `test/fixtures/depcruise/**` and asserts each rule actually fires.
 */

// --- Path fragments, named once -----------------------------------------------------------------
const SHARED = '^packages/shared/';
const CORE = '^packages/core/';
const CHANNEL_SDK = '^packages/channels/sdk/';
const PLUGIN_SDK = '^packages/plugin-sdk/';
const TOOLS = '^packages/tools/';
const ANY_PACKAGE = '^packages/';

/** Everything test-shaped. Used wherever a rule must not apply to tests. */
const TEST_SHAPED =
  '(\\.test\\.ts$|\\.bench\\.ts$|\\.scenario\\.ts$|/testing/|/__fixtures__/|^test/)';

/**
 * Packages that must stay runnable in a browser and free of platform APIs (`01` §4, A11). Their
 * tsconfigs also carry `types: []`, so a `node:*` import is a type error as well as a boundary
 * violation — belt and braces, because the two catch different mistakes.
 */
const PURE_PACKAGES =
  '^packages/(core|tools|channels/sdk|channels/simulator|plugin-sdk|api-client)/';

/**
 * Where network calls may be made (`08` PSC-8 → A11). Everything else must route through
 * `shared/net`'s `safeFetch`, which is what makes invariant **I5 (guarded egress)** structural
 * rather than a convention — and `--allow-net` cannot do it, being all-or-nothing (`01` §14 A31).
 */
const NET_ALLOWED =
  '(^packages/shared/src/net/|^packages/models/src/providers/|^packages/channels/[^/]+/src/|^packages/mcp/src/client/|^packages/mcp-bridge/src/|^apps/server/src/http/)';

/** Where cryptography may be implemented (`08` PSC-8 → A11). */
const CRYPTO_ALLOWED = '(^packages/shared/src/crypto/|^packages/storage/src/crypto/)';

/** Where a subprocess may be spawned (`08` PSC-8 → A11). */
const CHILD_PROCESS_ALLOWED =
  '(^packages/plugin-host/src/sandbox/|^packages/engine/src/media/transcription/|^packages/mcp/src/client/stdio)';

/**
 * The only callers allowed to reach memory **search** (`01` §14 A11, amending §4). Both must apply
 * the eligible-label filter, so widening this list silently widens who can read whose memories.
 */
const MEMORY_SEARCH_CALLERS = '^packages/engine/src/(context|readmodels)/';
const MEMORY_SEARCH_PORT = '^packages/core/src/ports/memory-search';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // --- Graph hygiene -------------------------------------------------------------------------
    {
      name: 'no-circular',
      comment:
        'A cycle between modules means the boundary between them is not real. Extract the shared ' +
        'part instead of importing backwards.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      comment:
        'A dependency that cannot be resolved is a typo, a missing package.json entry, or an ' +
        'import that pnpm is already refusing. All three should fail here rather than at runtime.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-dev-dep-in-src',
      comment:
        'Production code may import only runtime dependencies. A devDependency that ships is a ' +
        'broken install for every user.',
      severity: 'error',
      from: { path: '^(packages|apps)/', pathNot: TEST_SHAPED },
      to: { dependencyTypes: ['npm-dev'] },
    },

    // --- 01 §4: the package graph, bottom up ---------------------------------------------------
    {
      name: 'shared-imports-nothing-internal',
      comment: '`shared` is the bottom of the graph (§4). It must not import any other package.',
      severity: 'error',
      from: { path: SHARED, pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE, pathNot: SHARED },
    },
    {
      name: 'core-only-imports-shared',
      comment:
        '`core` is pure domain logic: entities, policy, information-flow control, the constitution ' +
        'compiler, fairness and proactivity maths. It may import only `shared` (§4).',
      severity: 'error',
      from: { path: CORE, pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE, pathNot: `(${CORE}|${SHARED})` },
    },
    {
      name: 'storage-only-core-shared',
      comment: '`storage` implements core ports. It may import only `core` and `shared` (§4).',
      severity: 'error',
      from: { path: '^packages/storage/', pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE, pathNot: `(^packages/storage/|${CORE}|${SHARED})` },
    },
    {
      name: 'models-only-core-shared',
      comment:
        '`models` holds provider adapters behind the ModelGateway port. It may import only `core` ' +
        'and `shared` (§4).',
      severity: 'error',
      from: { path: '^packages/models/', pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE, pathNot: `(^packages/models/|${CORE}|${SHARED})` },
    },
    {
      name: 'channel-sdk-only-core-shared',
      comment:
        'The channel SDK is the adapter contract. It may import only `core` and `shared`, and must ' +
        'never depend on a concrete adapter (§4).',
      severity: 'error',
      from: { path: CHANNEL_SDK, pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE, pathNot: `(${CHANNEL_SDK}|${CORE}|${SHARED})` },
    },
    {
      name: 'channels-only-sdk-core-shared',
      comment:
        'An adapter talks to one platform and emits envelopes. It may import `channels/sdk`, ' +
        '`core` and `shared`, and nothing else — including no sibling adapter (§4).',
      severity: 'error',
      from: { path: '^packages/channels/(?!sdk/)', pathNot: TEST_SHAPED },
      to: {
        path: ANY_PACKAGE,
        pathNot: `(${CHANNEL_SDK}|${CORE}|${SHARED}|^packages/channels/(?!sdk/)[^/]+/)`,
      },
    },
    {
      name: 'channels-never-engine-or-storage',
      comment:
        'Adapters never reach into the engine or the database (§4). An adapter that thinks it ' +
        'needs engine state actually wants a wider `AdapterContext` (A26).',
      severity: 'error',
      from: { path: '^packages/channels/', pathNot: TEST_SHAPED },
      to: { path: '^(packages/(engine|storage|tools|mcp|plugin-host|evals)|apps)/' },
    },
    {
      name: 'tools-never-storage',
      comment:
        'Tools receive repositories through `ToolContext` ports, so the executor can scope them to ' +
        'a group and an acting member. Importing storage directly bypasses that scoping, and with ' +
        'it invariant I3 (§4).',
      severity: 'error',
      from: { path: TOOLS, pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE, pathNot: `(${TOOLS}|${CORE}|${SHARED}|${PLUGIN_SDK})` },
    },
    {
      name: 'engine-never-storage-or-models',
      comment:
        'The engine depends on ports, not implementations: `apps/server` wires the concrete storage ' +
        'and model adapters in. This is what lets the engine be tested against fakes (§4).',
      severity: 'error',
      from: { path: '^packages/engine/', pathNot: TEST_SHAPED },
      to: { path: '^packages/(storage|models)/' },
    },
    {
      name: 'engine-allowed-imports',
      comment:
        '`engine` may import `core`, `shared`, `tools` (registry types), `channels/sdk` (types) and ' +
        '`plugin-sdk` (types, per A11) — and nothing else.',
      severity: 'error',
      from: { path: '^packages/engine/', pathNot: TEST_SHAPED },
      to: {
        path: ANY_PACKAGE,
        pathNot: `(^packages/engine/|${CORE}|${SHARED}|${TOOLS}|${CHANNEL_SDK}|${PLUGIN_SDK})`,
      },
    },
    {
      name: 'plugin-sdk-is-public-surface-only',
      comment:
        'The plugin SDK is semver-stable third-party surface. It may import `core` and `shared` ' +
        'public types and `channels/sdk` types only (A11). Anything else it exposes becomes a ' +
        'compatibility promise we did not mean to make.',
      severity: 'error',
      from: { path: PLUGIN_SDK, pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE, pathNot: `(${PLUGIN_SDK}|${CORE}|${SHARED}|${CHANNEL_SDK})` },
    },
    {
      name: 'plugin-host-allowed-imports',
      comment:
        '`plugin-host` supervises plugin processes and brokers their capabilities. It may import ' +
        '`core`, `shared` and `plugin-sdk` (A11) — never storage, so a plugin can never be handed ' +
        'a repository.',
      severity: 'error',
      from: { path: '^packages/plugin-host/', pathNot: TEST_SHAPED },
      to: {
        path: ANY_PACKAGE,
        pathNot: `(^packages/plugin-host/|${CORE}|${SHARED}|${PLUGIN_SDK})`,
      },
    },
    {
      name: 'mcp-never-storage-models-channels',
      comment:
        "`mcp` may use the engine's public service interfaces, and must reach data only through " +
        "them so a member's own agent inherits that member's authority (§4, A12).",
      severity: 'error',
      from: { path: '^packages/mcp/', pathNot: TEST_SHAPED },
      to: { path: '^packages/(storage|models|channels|plugin-host)/' },
    },
    {
      name: 'mcp-bridge-only-shared',
      comment:
        "`mcp-bridge` is installed inside a member's own agent (Claude Desktop, Cursor). It talks " +
        'to the server over HTTP and must not pull the product in with it (A11).',
      severity: 'error',
      from: { path: '^packages/mcp-bridge/', pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE, pathNot: `(^packages/mcp-bridge/|${SHARED})` },
    },
    {
      name: 'api-client-is-generated-and-standalone',
      comment:
        '`api-client` is generated from the OpenAPI document and consumed by a browser bundle. It ' +
        'must import no other workspace package (A11).',
      severity: 'error',
      from: { path: '^packages/api-client/', pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE, pathNot: '^packages/api-client/' },
    },
    {
      name: 'dashboard-only-api-client',
      comment:
        'The dashboard is a browser SPA. It talks to the server over HTTP through the generated ' +
        'client, and must never bundle server-side code — which would ship the policy engine, and ' +
        'possibly secrets, to every browser (§4).',
      severity: 'error',
      from: { path: '^apps/dashboard/', pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE, pathNot: '^packages/api-client/' },
    },
    {
      name: 'cli-allowed-imports',
      comment:
        'The CLI may import `shared`, `storage` (migrations and backup), `apps/server` (to start ' +
        'it) and the channel/model **probe** entry points (A11). It is a thin wrapper, not a second ' +
        'composition root.',
      severity: 'error',
      from: { path: '^apps/cli/', pathNot: TEST_SHAPED },
      to: {
        path: '^(packages|apps)/',
        pathNot:
          `(^apps/cli/|^apps/server/|${SHARED}|^packages/storage/|${CORE}` +
          '|^packages/channels/[^/]+/src/probe|^packages/models/src/probe)',
      },
    },
    {
      name: 'docs-site-imports-nothing-internal',
      comment:
        'The documentation site is a static build. Importing product code would couple a doc page ' +
        'to a refactor and let the docs build fail for reasons that have nothing to do with docs.',
      severity: 'error',
      from: { path: '^apps/docs/', pathNot: TEST_SHAPED },
      to: { path: ANY_PACKAGE },
    },
    {
      name: 'evals-is-test-only',
      comment:
        '`evals` is the simulation harness: persona agents, red-team suites, judges, arbitraries. ' +
        'Production code importing it would ship the adversarial fakes (§4). The documented ' +
        'exception is `apps/server/src/test-mode/**` (A15).',
      severity: 'error',
      from: {
        path: '^(packages|apps)/',
        pathNot: `(^packages/evals/|${TEST_SHAPED}|^apps/server/src/test-mode/)`,
      },
      to: { path: '^packages/evals/' },
    },
    {
      name: 'testing-subpath-only-from-tests',
      comment:
        '`*/testing` holds test doubles. Importing one from production code means a fake can reach ' +
        'a real user — a VirtualClock in production would freeze every reminder (`11` §3.1.2). The ' +
        'one documented exception is `apps/server/src/test-mode/**`.',
      severity: 'error',
      from: {
        path: '^(packages|apps)/',
        pathNot: `(${TEST_SHAPED}|^packages/evals/|^apps/server/src/test-mode/)`,
      },
      to: { path: '/testing/' },
    },
    {
      name: 'memory-search-restricted-callers',
      comment:
        'Only `engine/context` and `engine/readmodels` may reach memory search, and both must apply ' +
        'the eligible-label filter (A11, amending §4). Any other caller is a path by which one ' +
        "member's private memories could reach another — invariant I1.",
      severity: 'error',
      from: { path: '^(packages|apps)/', pathNot: `(${MEMORY_SEARCH_CALLERS}|${TEST_SHAPED})` },
      to: { path: MEMORY_SEARCH_PORT },
    },

    // --- Purity (01 §4, A11) -------------------------------------------------------------------
    {
      name: 'no-node-builtins-in-pure-packages',
      comment:
        '`core`, `tools`, `channels/sdk` and `channels/simulator` must not import `node:*`: it is ' +
        'what keeps `core` deterministic and the browser demo possible (§4, A11). Clock, ids and ' +
        'randomness are injected ports, not globals. `plugin-sdk` and `api-client` are included ' +
        'because both are consumed outside Node.',
      severity: 'error',
      from: { path: PURE_PACKAGES, pathNot: TEST_SHAPED },
      to: { dependencyTypes: ['core'] },
    },

    // --- Security import restrictions (08 PSC-8 → A11) -----------------------------------------
    {
      name: 'network-apis-only-in-shared-net-and-adapters',
      comment:
        'Network APIs belong in `shared/net` (`safeFetch`, with the egress allowlist) plus the ' +
        'provider and channel adapters that must speak a platform protocol. Everywhere else, a ' +
        'direct socket is an unguarded egress path and breaks invariant I5 (08 PSC-8).',
      severity: 'error',
      from: { path: '^(packages|apps)/', pathNot: `(${NET_ALLOWED}|${TEST_SHAPED})` },
      to: { path: '^(node:)?(net|http|https|http2|dns|tls|dgram)$', dependencyTypes: ['core'] },
    },
    {
      name: 'crypto-only-in-shared-crypto-and-storage-crypto',
      comment:
        'Cryptography lives in `shared/crypto` and `storage/crypto` so there is one place to ' +
        'review, one place to run known-answer tests against, and one place to rotate (08 PSC-8). ' +
        'Ad-hoc crypto elsewhere is how nonce reuse happens.',
      severity: 'error',
      from: { path: '^(packages|apps)/', pathNot: `(${CRYPTO_ALLOWED}|${TEST_SHAPED})` },
      to: { path: '^(node:)?crypto$', dependencyTypes: ['core'] },
    },
    {
      name: 'child-process-only-in-sandbox-and-transcription',
      comment:
        'Spawning a process is allowed only in the plugin sandbox launcher, the transcription ' +
        'runner (whisper-cli and ffmpeg) and the MCP stdio client (08 PSC-8). Anywhere else it is ' +
        'an unreviewed execution path.',
      severity: 'error',
      from: { path: '^(packages|apps)/', pathNot: `(${CHILD_PROCESS_ALLOWED}|${TEST_SHAPED})` },
      to: { path: '^(node:)?child_process$', dependencyTypes: ['core'] },
    },
  ],

  options: {
    doNotFollow: { path: '(node_modules|/dist/)' },
    exclude: {
      path: '(/\\.turbo/|/\\.vitest/|^packages/api-client/src/generated/)',
    },
    // Type-only imports are architecture too: `import type { Db } from '@comvivo/storage'` couples
    // two packages just as much as a value import, and several §4 rules exist precisely to allow
    // *types only* across a boundary.
    tsPreCompilationDeps: true,
    // `tsconfig.depcruise.json` maps every `@comvivo/*` specifier to that package's `src/index.ts`,
    // so the graph is the architecture rather than whatever happens to be built. Without it every
    // workspace import resolves into `dist/`, which an earlier `/dist/` exclude then swallowed —
    // the rules reported success over an empty graph. Caught by planting a violation.
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
