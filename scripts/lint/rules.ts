/**
 * Lint bans that enforce architecture, not style.
 *
 * Defined here rather than inline in `eslint.config.ts` so the config and the tests that prove each
 * ban bites share one definition. A test that reimplements the rule it is checking proves nothing.
 *
 * Specification: `docs/plan/01-architecture.md` §4 and §11 (core purity), and
 * `docs/plan/08-security-privacy.md` §3.20 (the SAST row's custom lint bans).
 */
import type { Linter } from 'eslint';

/**
 * `core` is pure: deterministic, side-effect-free, and exhaustively testable. Clock, ids and
 * randomness are **injected ports**, not globals (`01` §4, §11.4).
 *
 * This is not pedantry. A `Date.now()` buried in the fairness algorithm makes chore rotation
 * untestable and timezone-dependent; a `Math.random()` in the policy engine makes a conflict
 * resolution unreproducible, so "why did Village say this?" stops having an answer; and `process`
 * would let configuration leak into a layer whose whole value is that it cannot.
 *
 * The pure packages' tsconfigs also set `types: []`, so `process` is a type error there as well.
 * The two catch different mistakes: the type error catches `process.env`, this catches a `process`
 * that someone made compile by widening the types.
 */
/**
 * Restricted globals for `packages/core`, as **data** rather than a finished rules record.
 *
 * Kept separate because ESLint flat config **replaces** a rule's options when a later block sets
 * the same rule — it does not merge them. `no-restricted-globals` is set by both this and
 * `FETCH_BAN`, and for most of M0 the egress block silently won: the effective config for
 * `packages/core/**` banned `fetch` and **not** `Date` or `process`. The isolated rule tests
 * passed, and the config test asserted only that the rule *name* was present, so nothing caught
 * it until the exit gate planted `new Date()` in core and `pnpm lint` came back green.
 *
 * Composing the arrays at the point of use is what makes a collision impossible rather than
 * unlikely.
 */
export const CORE_RESTRICTED_GLOBALS = [
  {
    name: 'Date',
    message:
      'core is pure (01 §4): take the time from the injected Clock port. `new Date()` and ' +
      '`Date.now()` make the module untestable and timezone-dependent. Temporal types are fine.',
  },
  {
    name: 'process',
    message:
      'core is pure (01 §4): configuration arrives as an argument, never from the environment.',
  },
] as const;

/**
 * Where the `fetch` global is banned. Everything must reach the network through `safeFetch`, which
 * applies the egress allowlist — the thing that makes invariant **I5 (guarded egress)** structural
 * rather than a convention (`08` PSC-8).
 */
export const FETCH_RESTRICTED_GLOBALS = [
  {
    name: 'fetch',
    message:
      'Use safeFetch from @comvivo/shared/net instead. It applies the egress allowlist, which is ' +
      'what makes invariant I5 (guarded egress) structural rather than a convention (08 PSC-8). ' +
      'If this module genuinely must speak a platform protocol, add it to FETCH_ALLOWED_GLOBS ' +
      'with a reason.',
  },
] as const;

export const CORE_PURITY_RULES: Linter.RulesRecord = {
  // Both sets, so this block is self-sufficient and no other block's version of
  // `no-restricted-globals` can take the core bans away. `core` is pure, so it must not reach the
  // network either — the fetch ban belongs here on its own merits.
  'no-restricted-globals': ['error', ...CORE_RESTRICTED_GLOBALS, ...FETCH_RESTRICTED_GLOBALS],
  'no-restricted-properties': [
    'error',
    {
      object: 'Math',
      property: 'random',
      message:
        'core is pure (01 §4): take randomness from the injected Rng port, so a fairness decision ' +
        'or a conflict resolution can be replayed exactly.',
    },
  ],
};

/**
 * Where the `fetch` global may be used. Everywhere else must route through `shared/net`'s
 * `safeFetch`, which applies the egress allowlist — the thing that makes invariant **I5 (guarded
 * egress)** structural. `--allow-net` cannot do this: it is all-or-nothing with no host scoping
 * (`01` §14 A31).
 *
 * `fetch` is a global, so dependency-cruiser cannot see it; the equivalent *import* restrictions
 * for `node:net`/`node:http` live in `.dependency-cruiser.cjs`.
 */
export const FETCH_ALLOWED_GLOBS: readonly string[] = [
  'packages/shared/src/net/**',
  'packages/models/src/providers/**',
  'packages/channels/*/src/**',
  'packages/mcp/src/client/**',
  'packages/mcp-bridge/src/**',
  'apps/server/src/http/**',
  'apps/dashboard/src/**',
];

export const FETCH_BAN: Linter.RulesRecord = {
  'no-restricted-globals': ['error', ...FETCH_RESTRICTED_GLOBALS],
};

/**
 * The paths allowed to call a `…Unfiltered` read (`02` §3.7.1).
 *
 * `engine/tools-executor`, because it has already applied the requester's authority itself, and
 * `storage` internals, which includes the retention sweep — a sweep that could only see what
 * somebody is allowed to read would leave the rest behind forever.
 */
export const UNFILTERED_ALLOWED_GLOBS: readonly string[] = [
  'packages/engine/src/tools-executor/**',
  'packages/storage/src/**',
];

/**
 * Ban the `…Unfiltered` **call shape** outside those paths.
 *
 * The import edge is enforced by `.dependency-cruiser.cjs`'s `unfiltered-reads-restricted-callers`,
 * and this is the second layer, because the two fail differently: the import rule cannot be dodged
 * by renaming a method, and this cannot be dodged by re-exporting a module. `02` §3.7.1 asks for
 * the restriction "by dependency-cruiser rule", which cannot see a method name at all — so the
 * naming convention needs a rule that reads the call site.
 *
 * Deliberately a *syntax* ban on the name rather than a type-aware check on the interface: the
 * whole point of the `…Unfiltered` suffix is that it is visible at the call site, to the person
 * writing it and to the person reviewing it.
 */
export const UNFILTERED_READ_BAN: Linter.RulesRecord = {
  'no-restricted-syntax': [
    'error',
    {
      selector: 'CallExpression > MemberExpression[property.name=/Unfiltered$/]',
      message:
        'A `…Unfiltered` read skips the eligible-label filter (02 §3.7.1), so calling one here is ' +
        'a labeled read with the label check taken out — invariant I1, in one line that looks ' +
        'like a convenience. Take an `EligibleLabelSet` from core `canRead` and use the filtered ' +
        "read. Only `engine/tools-executor` (which has already applied the requester's " +
        'authority) and storage internals may call these.',
    },
  ],
};

/**
 * `01` §1 and `02` §3.7.2: a transaction callback must be synchronous.
 *
 * better-sqlite3 is a **synchronous** driver. `db.transaction(fn)` commits the moment `fn`
 * returns, so an `async fn` returns a promise immediately, the transaction commits around nothing,
 * and the work then runs outside it with no isolation and no rollback. **Nothing throws.** The data
 * is simply wrong, intermittently, under concurrency — which is the worst possible failure shape
 * for a product that keeps a family's messages.
 *
 * This is guard 2 of the four in `core/src/ports/storage/store.ts`. `NotPromise<T>` is guard 1 and
 * catches it at the type level; this one catches the cases the type cannot reach — a widened
 * return type, an untyped call site, a callback written against `any`.
 *
 * The selector is `02` §3.7.2's, plus `afterCommit`. It matches an `async` function passed directly
 * to anything named `write`, `read`, `transaction` or `afterCommit`, which does mean a false
 * positive is possible on an unrelated `read` — accepted, because the alternative is narrowing it
 * to one receiver type that a lint rule cannot see, and because an `async` callback to a method
 * called `read` is worth a second look anyway.
 *
 * `afterCommit` was added at the M1 exit gate. It is the same bivariance hole one step later: the
 * hook runs after the commit, so an `async` one turns a rejection into an unhandled rejection and,
 * on Node's default, exits the process having already written. `tx.ts` catches it at run time as
 * well, because a lint rule only sees a callback written at the call site.
 */
export const SYNC_TX_BAN: Linter.RulesRecord = {
  'no-restricted-syntax': [
    'error',
    {
      selector:
        'CallExpression[callee.property.name=/^(write|read|transaction|afterCommit)$/] > ' +
        ':function[async=true]',
      message:
        'Transaction callbacks must be synchronous (01 §1, 02 §3.7.2). better-sqlite3 commits when ' +
        'the callback returns, so an async one commits an empty transaction and then does its work ' +
        'outside it — no isolation, no rollback, and nothing thrown. Move the awaiting outside the ' +
        'transaction, or gather what you need first and pass it in.',
    },
  ],
};

/**
 * `11` §3.1.6: a property suite must not override what `fcConfig()` decided.
 *
 * `{ ...fcConfig(), numRuns: 12 }` reads like "twelve by default". It is not: the spread puts the
 * literal **last**, so it beats the environment, and `FC_NUM_RUNS=20000` silently runs twelve
 * cases. The suite passes either way — which is why this needs a lint rule and not a test. Found
 * at the M1 exit gate in `export/member-scope.prop.int.test.ts`, a file named `.prop.` and
 * therefore in the set `11` §3.1.6 raises nightly.
 *
 * `fcConfig({ numRuns: 12 })` is the correct form and expresses the precedence the other way
 * round: the literal is the fallback and `FC_NUM_RUNS` wins. The same trap applies to every key
 * `fcConfig` computes, so the selector names all five rather than only the one that bit.
 *
 * `:has(SpreadElement > …)` without a child combinator, because esquery rejects `:has(> …)` —
 * measured against the real linter, where the child form matches nothing and would have shipped an
 * inert rule with a passing test. The looser form can only over-match (an object whose *nested*
 * object spreads `fcConfig`), which in a test file is a prompt to write the clearer thing.
 */
export const FC_CONFIG_BAN: Linter.RulesRecord = {
  'no-restricted-syntax': [
    'error',
    {
      selector:
        "ObjectExpression:has(SpreadElement > CallExpression[callee.name='fcConfig']) > " +
        'Property[key.name=/^(numRuns|endOnFailure|seed|path|verbose)$/]',
      message:
        'Spreading `fcConfig()` and then overriding one of its keys reverses the precedence it ' +
        'exists for: the literal wins and `FC_SEED`/`FC_NUM_RUNS` are ignored, with the suite ' +
        'still green. Pass the value in instead — `fcConfig({ numRuns: 12 })` (11 §3.1.6).',
    },
  ],
};

/**
 * Files that may call the driver's own `transaction()`.
 *
 * `packages/storage/src/db/tx.ts` is the implementation — `SqliteStore` *is* the single entry
 * point, so it is the one place that may open a transaction. The spike is measuring the driver
 * itself (`02` §3.6.3), so going through `SqliteStore` there would mean measuring our wrapper
 * instead of the thing under test.
 *
 * `migrate/runner.ts` is the third, added at `M1-T14`, and it is the layer **below** the one the
 * ban protects. A migration installs the tables `SqliteStore`'s repositories read, so routing it
 * through `store.write()` would mean using the domain transaction to create the domain's own
 * schema. Of the four things the wrapper adds, the runner provides two itself and does not want
 * the others: it calls `.immediate()` and its callback is synchronous, it has no `afterCommit`
 * subscribers during an upgrade, and a migration is *expected* to be slow — logging every one as
 * an anomaly would train a host to ignore `storage.slow_tx`.
 */
export const RAW_TRANSACTION_ALLOWED_GLOBS = [
  'packages/storage/src/db/tx.ts',
  'packages/storage/src/migrate/runner.ts',
  'packages/storage/spike/**',
];

/**
 * Paths exempt from **both** the raw-transaction ban and the `…Unfiltered` ban.
 *
 * Enumerated rather than computed, because ESLint flat config cannot express the intersection of
 * two glob sets and the `files`/`ignores` pair can only subtract. Without this class the last
 * matching block re-adds a ban the path is supposed to be exempt from — which is what happened the
 * first time this was written, and `test/boundaries/lint-bans.int.test.ts` asserts all four classes
 * so a new entry in either allowlist cannot silently drift from this one.
 *
 * It is the intersection of `RAW_TRANSACTION_ALLOWED_GLOBS` with
 * `UNFILTERED_ALLOWED_GLOBS ∪ {tests, doubles}`:
 *
 *  - `tx.ts` is under `packages/storage/src/**`, which is an allowlisted `…Unfiltered` caller;
 *  - a spike **test** is a test, and tests are exempt from the `…Unfiltered` ban.
 *
 * A spike file that is *not* a test (`bench.ts`, `open.ts`) is deliberately **not** here: it keeps
 * the `…Unfiltered` ban, because nothing about measuring the driver needs to skip a label filter.
 */
export const RAW_TX_AND_UNFILTERED_EXEMPT_GLOBS = [
  'packages/storage/src/db/tx.ts',
  'packages/storage/spike/**/*.test.ts',
  'packages/storage/spike/*.test.ts',
];

/**
 * `02` §3.7.2 and `CLAUDE.md` §2: `SqliteStore` is the only transaction entry.
 *
 * Banning the driver's `transaction()` elsewhere is what makes that true rather than aspirational.
 * Everything the wrapper adds is lost to a raw call: the `IMMEDIATE` lock (so a read-then-write
 * transaction can fail to upgrade and get `SQLITE_BUSY`), the async guard, the `afterCommit`
 * ordering and its savepoint truncation, and the slow-transaction log. None of those absences
 * produce an error — they produce a transaction that looks like it worked.
 */
export const RAW_TRANSACTION_BAN: Linter.RulesRecord = {
  'no-restricted-syntax': [
    'error',
    {
      selector: 'CallExpression > MemberExpression[property.name="transaction"]',
      message:
        'Only `SqliteStore` may open a transaction (02 §3.7.2, CLAUDE.md §2). Use `store.write(fn)` ' +
        'or `store.read(fn)`: a raw `db.transaction()` loses the IMMEDIATE lock, the ' +
        'synchronous-callback guard, afterCommit ordering and the slow-transaction log — and none ' +
        'of those absences raise an error.',
    },
  ],
};

/**
 * Repository-wide bans from `08` §3.20's SAST row. Each one is a code-execution or injection path
 * that has no legitimate use in this codebase.
 */
export const SECURITY_RULES: Linter.RulesRecord = {
  'no-eval': 'error',
  'no-new-func': 'error',
  'no-implied-eval': 'error',
  'no-script-url': 'error',
  'no-restricted-syntax': [
    'error',
    {
      selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
      message:
        'Never inject HTML. Group content is attacker-controlled by design — any member may be ' +
        'adversarial toward the others (01 §9, trust boundary 2) — and this is a stored-XSS path ' +
        "straight into another member's session (08 §3.20).",
    },
    {
      selector: "MemberExpression[object.name='process'][property.name='binding']",
      message: 'process.binding is a deprecated route into internals. Use a public API.',
    },
    {
      // A *descendant* combinator, not a child one: the argument is almost always wrapped
      // (`process.env.X ?? '{}'`), so a child selector silently matches nothing. And the
      // MemberExpression to match is `process.env` itself, not the property read off it.
      selector:
        "CallExpression[callee.object.name='JSON'][callee.property.name='parse'] " +
        "MemberExpression[object.name='process'][property.name='env']",
      message:
        'Parse configuration through its zod schema (01 §11.2), not by hand off the environment. ' +
        'The config loader validates every boundary; hand-parsing skips that and skips the ' +
        'host-only key rules in A14.',
    },
  ],
};
