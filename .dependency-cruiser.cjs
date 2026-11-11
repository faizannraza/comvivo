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
 * Every rule here is covered by a **planted violation**, not by inspection (`M0-T4`).
 *
 * The fixtures live in a synthetic package tree built in a temp directory by
 * `test/boundaries/plant.ts` and asserted by `test/boundaries/fixtures.int.test.ts`. That tree
 * symlinks the real `node_modules`, so npm dependency types classify identically — which is what
 * makes the `no-dev-dep-in-src` fixture possible at all.
 *
 * `test/boundaries/depcruise-paths.test.ts` covers the other half: every workspace export must
 * have a `paths` entry in `tsconfig.depcruise.json`, because without one an import resolves into
 * `dist/` and a rule anchored on a `src/` path then matches nothing and reports success.
 *
 * (An earlier version of this comment claimed the fixtures were files under
 * `test/fixtures/depcruise/**` and the suite was `fixtures.test.ts`. Neither has ever existed.)
 */

// --- Path fragments, named once -----------------------------------------------------------------
const SHARED = '^packages/shared/';
const CORE = '^packages/core/';
const CHANNEL_SDK = '^packages/channels/sdk/';
const PLUGIN_SDK = '^packages/plugin-sdk/';
const TOOLS = '^packages/tools/';
const ANY_PACKAGE = '^packages/';

/**
 * Everything test-shaped. Used wherever a rule must not apply to tests.
 *
 * `/spike/` is in here for the same reason `/testing/` is: it is test apparatus, not product code.
 * `02` M1-T2 defines `packages/storage/spike/` as the encryption spike's permanent regression
 * suite, and its helper (`spike/open.ts`) transcribes `02` §3.6.2's pragma sequence and generates
 * throwaway keys with `node:crypto` — which `crypto-only-in-shared-crypto-and-storage-crypto`
 * correctly refused until this directory was classified.
 *
 * Classifying the directory rather than adding a third entry to `CRYPTO_ALLOWED` is deliberate:
 * "cryptography lives in two reviewed modules" is a claim worth keeping exactly true, and
 * threading a key through a helper's signature to satisfy a path regex is the kind of workaround
 * that makes a guard look arbitrary. Nothing under `spike/` ships — `packages/storage`'s `files`
 * list is `["dist"]`, and `tsconfig.json` includes only `src/`.
 *
 * A **package-root `bench/`** joins them at `M1-T33`, by the same argument and with the same
 * evidence: `packages/storage/bench/` holds the fixture builder and the `dbstat` size reader
 * beside the `*.bench.ts` files that were already test-shaped by suffix, it is outside
 * `tsconfig.json`'s `include` so it cannot ship, and the fixture legitimately needs
 * `applyMigrations`, `silentLogger` and `SeededRng` — three imports from a `testing` subpath that
 * `testing-subpath-only-from-tests` rightly refused while the directory was unclassified. That
 * refusal is also *why* `src/perf/seed.ts` takes an already-open database rather than opening one:
 * the generator is production code and must not reach a `testing` subpath, so the test-shaped
 * half of the pair opens the database and the production half fills it. Anchored to a package
 * root, so a `bench` directory nested under `src` does not inherit the exemption by accident.
 */
const TEST_SHAPED =
  '(\\.test\\.ts$|\\.bench\\.ts$|\\.scenario\\.ts$|/testing/|/spike/|^packages/[^/]+/bench/|/__fixtures__/|^test/)';

/**
 * Build tooling that sits at a package root rather than under `src/`.
 *
 * Two files, each named in full: `drizzle.config.ts` (drizzle-kit is a devDependency and the
 * config imports it) and `vitest.mutation.config.ts` (`11` §3.1.5's Stryker runner needs a Vitest
 * config of its own, and it imports `vitest/config`). Both sit outside every package's `files`
 * list and outside its `tsconfig` `include`, so neither can ship. Named by exact filename rather
 * than by a `*.config.ts` wildcard, because the point of `no-dev-dep-in-src` is that an exemption
 * is a decision somebody made once and wrote down — a glob invites the next config file to inherit
 * it silently, which is how the `apps/docs` exclusion disabled a working rule during M0.
 */
const PACKAGE_BUILD_TOOLING = '^packages/[^/]+/(drizzle|vitest\\.mutation)\\.config\\.ts$';

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
 *
 * `^packages/storage/src/search/` is the third entry and is **not** a widening of that: it is the
 * directory that *implements* the port, and an implementation has to import the interface it
 * implements. Measured at `M1-T18`, where the rule refused exactly that import. The sibling
 * `UNFILTERED_CALLERS` below already carries `^packages/storage/src/` for the same reason, so this
 * closes a gap between two rules of the same shape rather than opening one — and it is kept to the
 * `search/` subtree, which is tighter than that precedent. Nothing above storage gains access:
 * a module that wants to search still cannot import the port.
 */
const MEMORY_SEARCH_CALLERS =
  '(^packages/engine/src/(context|readmodels)/|^packages/storage/src/search/)';
const MEMORY_SEARCH_PORT = '^packages/core/src/ports/memory-search';

/**
 * The unfiltered reads (`02` §3.7.1, §3.14 "IFC enforcement in storage").
 *
 * Every labeled read takes a branded `EligibleLabelSet`, computed by core `canRead`, **except** a
 * handful named `…Unfiltered` that deliberately bypass it: the tool executor needs them because it
 * has already applied the requester's authority itself, and retention needs them because a sweep
 * that could only see what somebody is allowed to read would leave the rest behind forever.
 *
 * `02` §3.7.1 asks for this as "a dependency-cruiser rule", and dependency-cruiser cannot see a
 * **method name** — so the unfiltered reads get their own module instead, and the restriction is
 * on the import edge, which is the thing a module graph can actually enforce. An ESLint rule bans
 * the `…Unfiltered` call *shape* outside the same paths, so a method added to an ordinary
 * interface by mistake is still caught. Two layers, because they fail differently: the import rule
 * cannot be dodged by renaming a method, and the call rule cannot be dodged by re-exporting a
 * module. See STATUS → Plan changes (2026-11-03).
 *
 * Widening either list widens who can read a family's data without a policy check, which is why
 * both are named here rather than inline.
 */
const UNFILTERED_READS =
  '^packages/(core/src/ports/storage/unfiltered|storage/src/repos/unfiltered/)';
const UNFILTERED_CALLERS = '(^packages/engine/src/tools-executor/|^packages/storage/src/)';

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
      from: { path: '^(packages|apps)/', pathNot: `(${TEST_SHAPED}|${PACKAGE_BUILD_TOOLING})` },
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
      name: 'engine-plugin-sdk-types-only',
      comment:
        'A11 says `engine` may import `plugin-sdk` **types**. A runtime value import pulls the ' +
        'third-party SDK into the turn loop, which is the opposite of what the SDK is for: it is a ' +
        "compatibility surface for other people's code, not a library the engine depends on. " +
        'The allow-list rule above permitted any import, so the "types" half of A11 was a comment.',
      severity: 'error',
      from: { path: '^packages/engine/', pathNot: TEST_SHAPED },
      to: { path: PLUGIN_SDK, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'plugin-sdk-channel-sdk-types-only',
      comment:
        'A11 says `plugin-sdk` may import `channels/sdk` **types**. A value import would make the ' +
        "channel SDK part of the plugin SDK's runtime surface, and therefore part of a semver " +
        'promise to plugin authors that nobody decided to make.',
      severity: 'error',
      from: { path: PLUGIN_SDK, pathNot: TEST_SHAPED },
      to: { path: CHANNEL_SDK, dependencyTypesNot: ['type-only'] },
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

    {
      name: 'unfiltered-reads-restricted-callers',
      comment:
        'Reads named `…Unfiltered` skip the eligible-label filter by design (`02` §3.7.1). Only ' +
        "the tool executor — which has already applied the requester's authority — and storage " +
        'internals, including the retention sweep, may reach them. Any other caller is a labeled ' +
        'read with the label check removed, which is invariant I1 deleted in one import.',
      severity: 'error',
      from: { path: '^(packages|apps)/', pathNot: `(${UNFILTERED_CALLERS}|${TEST_SHAPED})` },
      to: { path: UNFILTERED_READS },
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
      name: 'libsodium-only-in-shared-crypto-and-storage-crypto',
      comment:
        'The sibling rule above restricts `node:crypto` and stops there, so the other half of ' +
        "this project's cryptography — libsodium — was unrestricted. `libsodium-wrappers` is a " +
        'runtime dependency of `@comvivo/storage` with no importer under `src/`, which means any ' +
        'storage module could have reached for secretstream directly and passed every rule. ' +
        '`08` PSC-8 wants one place to review and one place to run known-answer tests against, ' +
        'and that argument does not depend on which library the primitive comes from.',
      severity: 'error',
      from: { path: '^(packages|apps)/', pathNot: `(${CRYPTO_ALLOWED}|${TEST_SHAPED})` },
      to: { path: 'node_modules/(libsodium-wrappers(-sumo)?|sodium-native)(/|$)' },
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
      /**
       * The docs site's **build machinery** is excluded, not the site.
       *
       * Astro consumes `src/` at build time and emits `dist/`; nothing in `src/` ships, so Astro
       * and Starlight are correctly devDependencies and `no-dev-dep-in-src` fires on every import
       * in the config files. `content.config.ts` imports Astro's virtual `astro:content`, which is
       * unresolvable by design, and `.astro/` is generated.
       *
       * Everything else under `apps/docs` stays cruised, because
       * `docs-site-imports-nothing-internal` is a real rule with a planted fixture
       * (`test/boundaries/fixtures.int.test.ts`) and excluding the whole app silently disabled it.
       * The fixture caught that, which is the entire argument for having one.
       */
      path:
        '(/\\.turbo/|/\\.vitest/|^packages/api-client/src/generated/' +
        '|^apps/docs/\\.astro/|^apps/docs/astro\\.config\\.mjs$|^apps/docs/src/content\\.config\\.ts$)',
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
