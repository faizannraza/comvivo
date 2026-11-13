/**
 * Every dependency-boundary rule is proven to bite.
 *
 * `M0-T4`'s acceptance criterion is that each rule has a planted-violation fixture that fails the
 * build. The lesson behind that criterion was learned here the hard way: the first version of
 * `.dependency-cruiser.cjs` excluded `/dist/`, and because workspace imports resolve through
 * `node_modules` into `dist/`, every cross-package edge was invisible. It printed "no dependency
 * violations found" over an essentially empty graph. **A guard is not done until it has been seen
 * to fail.**
 *
 * One synthetic tree, one depcruise run, every rule asserted — so the whole suite costs a single
 * subprocess rather than one per rule.
 *
 * Tagged as integration because it spawns a process and touches a temp directory.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { cruisePlanted, type PlantedFile } from './plant.js';

/**
 * One planted file per rule. The comment on each is the mistake a real contributor would make —
 * these are not arbitrary imports, they are the plausible wrong turns.
 */
const PLANTED: Record<string, PlantedFile> = {
  // --- Graph hygiene ---------------------------------------------------------------------------
  'not-to-unresolvable': {
    path: 'packages/shared/src/typo.ts',
    imports: ['@comvivo/does-not-exist'],
  },
  'no-dev-dep-in-src': {
    // "I just need the test matcher types here" — and now vitest ships to every user.
    path: 'packages/engine/src/ships-a-devdep.ts',
    imports: ['vitest'],
  },

  // --- 01 §4: the package graph ----------------------------------------------------------------
  'shared-imports-nothing-internal': {
    // "the error helper needs the GroupId type" — this is how `shared` stops being the bottom.
    path: 'packages/shared/src/reaches-up.ts',
    imports: ['@comvivo/core'],
  },
  'core-only-imports-shared': {
    // "the policy engine needs to read the members table" — and core stops being pure.
    path: 'packages/core/src/reaches-storage.ts',
    imports: ['@comvivo/storage'],
  },
  'storage-only-core-shared': {
    path: 'packages/storage/src/reaches-engine.ts',
    imports: ['@comvivo/engine'],
  },
  'models-only-core-shared': {
    path: 'packages/models/src/reaches-engine.ts',
    imports: ['@comvivo/engine'],
  },
  'channel-sdk-only-core-shared': {
    path: 'packages/channels/sdk/src/reaches-tools.ts',
    imports: ['@comvivo/tools'],
  },
  'channels-only-sdk-core-shared': {
    // "the adapter wants to count tokens before sending" — adapters do not get the model gateway.
    path: 'packages/channels/telegram/src/reaches-models.ts',
    imports: ['@comvivo/models'],
  },
  'channels-never-engine-or-storage': {
    // The confused-deputy shortcut: an adapter writing straight to the database, with no policy
    // check and no acting member.
    path: 'packages/channels/discord/src/reaches-storage.ts',
    imports: ['@comvivo/storage'],
  },
  'tools-never-storage': {
    // The most dangerous plausible mistake in the whole graph: a tool that bypasses ToolContext
    // loses its group scoping and its authority check, and with them invariant I3.
    path: 'packages/tools/src/reaches-storage.ts',
    imports: ['@comvivo/storage'],
  },
  'engine-never-storage-or-models': {
    path: 'packages/engine/src/reaches-storage.ts',
    imports: ['@comvivo/storage'],
  },
  'engine-allowed-imports': {
    path: 'packages/engine/src/reaches-mcp.ts',
    imports: ['@comvivo/mcp'],
  },
  'plugin-sdk-is-public-surface-only': {
    // Anything the SDK re-exports becomes a semver promise we did not mean to make.
    path: 'packages/plugin-sdk/src/reaches-engine.ts',
    imports: ['@comvivo/engine'],
  },
  'engine-plugin-sdk-types-only': {
    // A value import, not a `import type`. A11 allows the type edge and nothing more; the
    // allow-list rule it was written against permitted either.
    path: 'packages/engine/src/values-from-plugin-sdk.ts',
    imports: ['@comvivo/plugin-sdk'],
  },
  'plugin-sdk-channel-sdk-types-only': {
    path: 'packages/plugin-sdk/src/values-from-channel-sdk.ts',
    imports: ['@comvivo/channel-sdk'],
  },
  'plugin-host-allowed-imports': {
    // A plugin must never be able to receive a repository.
    path: 'packages/plugin-host/src/reaches-storage.ts',
    imports: ['@comvivo/storage'],
  },
  'mcp-never-storage-models-channels': {
    path: 'packages/mcp/src/reaches-storage.ts',
    imports: ['@comvivo/storage'],
  },
  'mcp-bridge-only-shared': {
    // The bridge is installed inside someone's Claude Desktop; it must not drag the product along.
    path: 'packages/mcp-bridge/src/reaches-core.ts',
    imports: ['@comvivo/core'],
  },
  'api-client-is-generated-and-standalone': {
    path: 'packages/api-client/src/reaches-shared.ts',
    imports: ['@comvivo/shared'],
  },
  'dashboard-only-api-client': {
    // This one would ship the policy engine, and possibly a secret, to every browser.
    path: 'apps/dashboard/src/reaches-engine.ts',
    imports: ['@comvivo/engine'],
  },
  'cli-allowed-imports': {
    path: 'apps/cli/src/reaches-engine.ts',
    imports: ['@comvivo/engine'],
  },
  'docs-site-imports-nothing-internal': {
    path: 'apps/docs/src/reaches-shared.ts',
    imports: ['@comvivo/shared'],
  },
  'evals-is-test-only': {
    // Importing the harness from production ships the adversarial fake gateways.
    path: 'packages/engine/src/reaches-evals.ts',
    imports: ['@comvivo/evals'],
  },
  'testing-subpath-only-from-tests': {
    // A VirtualClock reaching production would freeze every reminder in the product.
    path: 'packages/engine/src/reaches-testing.ts',
    imports: ['@comvivo/shared/testing'],
  },
  'memory-search-restricted-callers': {
    // A job that searches memories without the eligible-label filter is a direct route from one
    // member's private data into another's context — invariant I1.
    path: 'packages/engine/src/jobs/searches-memory.ts',
    imports: ['../../../core/src/ports/memory-search.js'],
  },
  'unfiltered-reads-restricted-callers': {
    // The `…Unfiltered` reads skip the eligible-label filter on purpose (`02` §3.7.1). Reached
    // from anywhere but the tool executor or storage itself, they are a labeled read with the
    // label check taken out — I1 deleted in one import, and it would look like a convenience.
    path: 'packages/engine/src/digest/reads-unfiltered.ts',
    imports: ['../../../core/src/ports/storage/unfiltered.js'],
  },

  // --- Purity ----------------------------------------------------------------------------------
  'no-node-builtins-in-pure-packages': {
    // "the compiler just needs to read the YAML off disk" — and now core is neither deterministic
    // nor loadable in the browser demo.
    path: 'packages/core/src/reads-a-file.ts',
    imports: ['node:fs'],
  },
  'no-node-builtins-in-plugin-sdk-testing': {
    // "it's only the test kit" — except `./testing` is a PUBLIC entry point of a published SDK
    // (`10` §3.2.1), so a fake ToolContext that reads a fixture off disk ships to every plugin
    // author and breaks the browser target.
    path: 'packages/plugin-sdk/src/testing/reads-a-fixture.ts',
    imports: ['node:fs'],
  },

  // --- Security import restrictions (08 PSC-8) -------------------------------------------------
  'network-apis-only-in-shared-net-and-adapters': {
    // An unguarded egress path: no allowlist, no audit, invariant I5 gone.
    path: 'packages/engine/src/opens-a-socket.ts',
    imports: ['node:net'],
  },
  'crypto-only-in-shared-crypto-and-storage-crypto': {
    // Ad-hoc crypto outside the two reviewed modules is how nonce reuse happens.
    path: 'packages/engine/src/rolls-its-own-crypto.ts',
    imports: ['node:crypto'],
  },
  'libsodium-only-in-shared-crypto-and-storage-crypto': {
    // `libsodium-wrappers` is a runtime dependency of `@comvivo/storage`, so this is reachable
    // today: a module outside `storage/src/crypto/` importing it resolves and type-checks.
    path: 'packages/storage/src/db/reaches-libsodium.ts',
    imports: ['libsodium-wrappers'],
  },
  'child-process-only-in-sandbox-and-transcription': {
    path: 'packages/engine/src/spawns-a-process.ts',
    imports: ['node:child_process'],
  },
};

/** Two modules importing each other: the shape of a boundary that is not real. */
const CYCLE: readonly PlantedFile[] = [
  { path: 'packages/core/src/cycle-a.ts', imports: ['./cycle-b.js'] },
  { path: 'packages/core/src/cycle-b.ts', imports: ['./cycle-a.js'] },
];

describe('the clean synthetic tree', { tags: ['slow'] }, () => {
  it('reports no violations, so the fixtures below are the only cause', async () => {
    const result = await cruisePlanted([]);
    expect(result.violations).toEqual([]);
    // If this ever drops to a handful, the tree stopped being representative — which is exactly
    // the failure the `/dist/` bug produced in the real config.
    expect(result.modulesCruised).toBeGreaterThan(20);
  });
});

describe('A11 allows the type edge it forbids as a value', { tags: ['slow'] }, () => {
  // The positive control for the two `*-types-only` rules. Without it, a rule that fired on every
  // import — the state the config was in, where the allow-list permitted both and the "types" half
  // of A11 was only a comment — would look identical to a working one.
  it('does not fire on an `import type` across either edge', async () => {
    const result = await cruisePlanted([
      {
        path: 'packages/engine/src/types-from-plugin-sdk.ts',
        imports: [],
        typeImports: ['@comvivo/plugin-sdk'],
      },
      {
        path: 'packages/plugin-sdk/src/types-from-channel-sdk.ts',
        imports: [],
        typeImports: ['@comvivo/channel-sdk'],
      },
    ]);
    expect(
      [...result.violatedRules],
      'A11 permits these two edges as types. A violation here means the rule cannot tell a type ' +
        'import from a value import, which makes it a ban on the edge rather than on the value.',
    ).toEqual([]);
    // Non-vacuous: the modules really were cruised, so "no violations" is a verdict rather than an
    // empty graph.
    expect(result.modulesCruised).toBeGreaterThan(20);
  });
});

describe('a peer dependency is not a devDependency that ships', { tags: ['slow'] }, () => {
  // The positive control for `no-dev-dep-in-src`'s `dependencyTypesNot: ['npm-peer']`, added at
  // `M2-T5` when `@comvivo/plugin-sdk` became the first package to declare a peer (`10` §3.2.1
  // makes `zod` one, and it has to be: a plugin builds its schemas with its own copy of zod).
  // pnpm resolves a peer through the matching devDependency, so depcruise reports
  // `['npm-peer', 'npm-dev', …]` and the rule fired on a perfectly correct import.
  it('allows a peer import in src and still refuses a dev-only one', async () => {
    const result = await cruisePlanted([
      { path: 'packages/plugin-sdk/src/uses-a-peer.ts', imports: ['zod'] },
      { path: 'packages/engine/src/ships-a-devdep-too.ts', imports: ['vitest'] },
    ]);
    const devDep = result.violations.filter((v) => v.rule === 'no-dev-dep-in-src');
    expect(
      devDep.map((v) => v.from),
      'A peer dependency is a declared runtime requirement of the consumer, not something we ' +
        'ship. A dev-only import must still fail, or the exemption swallowed the rule.',
    ).toEqual(['packages/engine/src/ships-a-devdep-too.ts']);
  });
});

describe('the fixture set covers the config', () => {
  // `M0-T4`'s criterion is "each rule has a planted-violation fixture that makes `pnpm verify`
  // fail". The three tests below prove every rule **in `PLANTED`** fires and that no rule outside
  // it does — but nothing read the rule inventory out of `.dependency-cruiser.cjs`, so a 30th
  // `forbidden` rule added without a fixture passed silently and the criterion guarded itself.
  // Found by the M0 independent review; coverage was complete at the time and unenforced.
  const require_ = createRequire(import.meta.url);
  const config = require_('../../.dependency-cruiser.cjs') as {
    forbidden: { name: string }[];
  };

  it('plants a fixture for every forbidden rule', () => {
    const covered = new Set([...Object.keys(PLANTED), 'no-circular']);
    const unplanted = config.forbidden
      .map((rule) => rule.name)
      .filter((name) => !covered.has(name));
    expect(
      unplanted,
      'Every rule in `.dependency-cruiser.cjs` needs an entry in `PLANTED` (or, for `no-circular`, ' +
        'in `CYCLE`). A rule with no fixture has never been shown to fire.',
    ).toEqual([]);
  });

  it('plants no fixture for a rule the config no longer has', () => {
    // The other direction: a fixture for a deleted rule is a test that can never fail, and it
    // would make the "fires every expected rule" test above fail confusingly rather than clearly.
    const names = new Set(config.forbidden.map((rule) => rule.name));
    const orphans = Object.keys(PLANTED).filter((name) => !names.has(name));
    expect(orphans).toEqual([]);
  });

  it('read the real config, so neither comparison is two empty sets', () => {
    expect(config.forbidden.length).toBeGreaterThan(20);
    expect(Object.keys(PLANTED).length).toBeGreaterThan(20);
  });
});

describe('every boundary rule bites', { tags: ['slow'] }, () => {
  const planted = [...Object.values(PLANTED), ...CYCLE];

  it('fires every expected rule from a single cruise', async () => {
    const result = await cruisePlanted(planted);
    const expectedRules = [...Object.keys(PLANTED), 'no-circular'].sort();
    const missing = expectedRules.filter((rule) => !result.violatedRules.has(rule));
    expect(
      missing,
      "These rules did not fire against a planted violation. Either the rule's regex is wrong, " +
        'or the fixture does not actually violate it — both mean the rule is not protecting ' +
        'anything.',
    ).toEqual([]);
  });

  it('attributes each violation to the file that caused it', async () => {
    const result = await cruisePlanted(planted);
    for (const [rule, file] of Object.entries(PLANTED)) {
      const hit = result.violations.find((v) => v.rule === rule && v.from === file.path);
      expect(hit, `${rule} fired, but not from ${file.path}`).toBeDefined();
    }
  });

  it('reports no rule we did not plant, so the fixtures are exact', async () => {
    const result = await cruisePlanted(planted);
    const expected = new Set([...Object.keys(PLANTED), 'no-circular']);
    const unexpected = [...result.violatedRules].filter((rule) => !expected.has(rule));
    expect(
      unexpected,
      'A rule fired that no fixture targets. Usually this means one fixture violates two rules, ' +
        'which makes the suite ambiguous — give the extra rule its own fixture or narrow this one.',
    ).toEqual([]);
  });
});
