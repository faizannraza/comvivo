/**
 * Every path an exemption names must be real, or declared as not-yet-written.
 *
 * The M2 independent review found two exemptions in `NET_ALLOWED` pointing at directories that do
 * not exist: `^packages/models/src/providers/` (the adapters are at
 * `src/{anthropic,openai,google,openai-compatible}/` and reach the network through their SDKs) and
 * `^packages/evals/src/chaos/` (`FakeProviderServer` moved to `@comvivo/models/testing`). Fourteen
 * lines of comment justified the second in detail. Both were dead.
 *
 * A dead exemption is worse than no exemption. It reads as a reviewed decision that something in
 * that directory needs a socket, so the next person to hit the rule widens it to match the fiction
 * instead of fixing their design — which is exactly what `CLAUDE.md` §2 forbids. And because
 * dependency-cruiser reports success for a rule that matches nothing, nothing fails.
 *
 * So this test walks **every** `path`/`pathNot` in the config, pulls out every literal directory
 * fragment, and requires each one to be either a real directory today or listed in `PENDING` with
 * the milestone that creates it. It fails in both directions: a fragment that is neither real nor
 * pending is stale, and a `PENDING` fragment that has since appeared must be promoted — which is
 * how you find out that a forward-looking exemption went live.
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Only the parts of the config this test reads. */
interface RuleSide {
  readonly path?: string | readonly string[];
  readonly pathNot?: string | readonly string[];
}
interface Rule {
  readonly name?: string;
  readonly from?: RuleSide;
  readonly to?: RuleSide;
}

/**
 * The config, loaded through `require` because it is CommonJS with no type declarations.
 *
 * The shape is asserted at runtime rather than asserted by a cast, because a cast is a promise and
 * this file's whole subject is guards that promise more than they check: if dependency-cruiser's
 * config format changed, a silent `undefined` here would make every assertion below vacuous.
 */
function loadConfig(): readonly Rule[] {
  const loaded: unknown = createRequire(import.meta.url)('../../.dependency-cruiser.cjs');
  const forbidden =
    typeof loaded === 'object' && loaded !== null
      ? (loaded as { forbidden?: unknown }).forbidden
      : undefined;
  if (!Array.isArray(forbidden) || forbidden.length === 0) {
    throw new Error('.dependency-cruiser.cjs has no non-empty `forbidden` array; the format moved');
  }
  return forbidden as readonly Rule[];
}

/**
 * Directories the plan specifies but no milestone has written yet.
 *
 * Each is a subdirectory of a package that **does** exist — M0 scaffolded every workspace — so the
 * exemption is forward-looking rather than stale. The milestone is the one that creates it, from
 * `14-milestones.md`; when it lands, this test fails and the entry moves out of this list.
 */
const PENDING: ReadonlyMap<string, string> = new Map([
  ['packages/mcp/src/client', 'the MCP client (10 §3.4) — M9'],
  ['packages/mcp/src/client/stdio', 'the stdio transport (10 §3.4.2) — M9'],
  ['apps/server/src/http', 'the HTTP server (09 §3.2) — M3'],
  ['packages/plugin-host/src/sandbox', 'the plugin sandbox (10 §3.6) — M10'],
  ['packages/engine/src/media/transcription', 'the transcription runner (06 §3.9) — M6'],
  ['apps/server/src/test-mode', 'test-mode guards (11 §4.3, 01 §14 A15) — M3-T45'],
  // `09` §3.11.5's `ProviderProbe` interface lives at `@comvivo/models/probe`, a subpath export
  // with no heavy dependencies so the CLI can run a key check without loading three SDKs. The
  // wizard is its first caller (M3-T42); `M0-T4`'s AC names the `cli→probe` edge, which is why
  // the exemption exists before the directory does.
  ['packages/models/src/probe', '`ProviderProbe` (09 §3.11.5) — M3-T42'],
  // `10` §3.2.1 marks this a PUBLIC entry point and §3.12 specifies its contents. Note this one
  // is a rule's `from`, not an exemption: `no-node-builtins-in-plugin-sdk-testing` currently
  // matches no files, so it protects nothing yet. It was written at `M2-T5` because that task's
  // AC names the clause. `M7-T6` is the first AC that requires the suite to exist and pass.
  ['packages/plugin-sdk/src/testing', 'the public conformance kit (10 §3.12) — M7-T6'],
  // The two callers `01` §14 A11 allows to reach memory **search**, and the rule that names them
  // (`memory-search-restricted-callers`) is what protects invariant **I1 (no read-up)**. Neither
  // directory exists yet, which makes the rule maximally strict today — nothing can import the
  // port at all — and that is the safe direction. They arrive with the context builder and the
  // read models; when they do, this test says so.
  ['packages/engine/src/context', 'the context builder (05 §3.4) — M5-T12/M5-T18'],
  ['packages/engine/src/readmodels', 'the read-model layer (09 §3.3) — M9-T9/M9-T10'],
  ['packages/core/src/ports/memory-search', 'already arrived as a file; see the test below'],
]);

/**
 * Expand a pattern's alternation groups into the concrete strings they can match.
 *
 * `^packages/(models|engine)/src/x/` becomes two fragments. Without this, the M2 second-pass
 * review's planted exemptions `^packages/(models|engine)/src/totally-made-up/` and
 * `^scripts/also-made-up/` both passed the check and both widened `node:net` access — the first
 * because the group made the fragment look like a shape rather than a path, the second because the
 * extraction only looked under `packages/` and `apps/`.
 *
 * Bounded at 64 expansions, because a pattern with many groups multiplies: beyond that, a config
 * is doing something this check should not pretend to understand, and the count assertion below
 * would notice the coverage drop.
 */
function expandAlternations(pattern: string): readonly string[] {
  let out = [pattern];
  for (let depth = 0; depth < 6; depth += 1) {
    const next: string[] = [];
    let changed = false;
    for (const candidate of out) {
      // An innermost group of plain alternatives — no nested groups, no character classes.
      const match = /\(([A-Za-z0-9_.@:/|-]+)\)/.exec(candidate);
      if (match === null) {
        next.push(candidate);
        continue;
      }
      changed = true;
      for (const alternative of (match[1] ?? '').split('|')) {
        next.push(
          candidate.slice(0, match.index) +
            alternative +
            candidate.slice(match.index + match[0].length),
        );
      }
    }
    out = next.slice(0, 64);
    if (!changed) break;
  }
  return out;
}

/**
 * Every top-level entry in the repository, so a fragment's first segment can be recognised.
 *
 * Read from disk rather than listed, because a hardcoded list is how the previous version came to
 * check `packages/` and `apps/` and silently ignore `scripts/`, `test/`, `tools/` and `.github/`.
 */
const ROOT_ENTRIES: ReadonlySet<string> = new Set(readdirSync(ROOT));

/**
 * Literal path fragments inside a `path` regex.
 *
 * A fragment is checkable when every alternation has been expanded, nothing else regex-shaped is
 * left, and its **first segment is a real entry at the repository root** — that last test is what
 * lets this find a `scripts/…` exemption without hardcoding which roots exist.
 * `^packages/channels/[^/]+/src/` still names a shape, not a directory, and is skipped.
 */
function literalFragments(pattern: string): readonly string[] {
  return expandAlternations(pattern)
    .flatMap((expanded) => [
      ...expanded.matchAll(/\^?([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@:-]+)+\/?)/g),
    ])
    .map((match) => (match[1] ?? '').replace(/\/$/, ''))
    .filter((fragment) => !/[[\](){}*+?|\\]/.test(fragment))
    .filter((fragment) => ROOT_ENTRIES.has(fragment.split('/')[0] ?? ''));
}

/** Every `path`/`pathNot` string on one side of one rule. */
function patternsOf(side: RuleSide | undefined): readonly string[] {
  const values = [side?.path, side?.pathNot].flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
  return values.filter((value): value is string => typeof value === 'string');
}

function allPatterns(): readonly { rule: string; pattern: string }[] {
  return loadConfig().flatMap((rule) =>
    [rule.from, rule.to].flatMap((side) =>
      patternsOf(side).map((pattern) => ({ rule: rule.name ?? '(unnamed)', pattern })),
    ),
  );
}

describe('dependency-cruiser names no directory that does not exist', () => {
  const fragments = allPatterns().flatMap(({ rule, pattern }) =>
    literalFragments(pattern).map((fragment) => ({ rule, fragment })),
  );

  it('found enough fragments to be checking something', () => {
    // The positive control. If the extraction broke — a config format change, a regex typo — this
    // test would pass by finding nothing to check, which is the failure mode it exists to prevent.
    expect(fragments.length).toBeGreaterThan(30);
    expect(new Set(fragments.map((entry) => entry.fragment)).size).toBeGreaterThan(15);
  });

  it('points every exemption at a real directory, or declares it pending', () => {
    const stale = [...new Set(fragments.map((entry) => entry.fragment))]
      .filter(
        (fragment) =>
          !existsSync(`${ROOT}${fragment}`) &&
          !existsSync(`${ROOT}${fragment}.ts`) &&
          !PENDING.has(fragment),
      )
      .map((fragment) => {
        const rules = fragments
          .filter((entry) => entry.fragment === fragment)
          .map((entry) => entry.rule);
        return `${fragment} (in ${[...new Set(rules)].join(', ')})`;
      });
    expect(
      stale,
      'stale exemptions: delete them, or add them to PENDING with the milestone',
    ).toEqual([]);
  });

  it('promotes a pending directory once it exists', () => {
    const arrived = [...PENDING.keys()].filter(
      (fragment) => existsSync(`${ROOT}${fragment}`) || existsSync(`${ROOT}${fragment}.ts`),
    );
    // `packages/core/src/ports/memory-search` is here as the one that already arrived as a file,
    // which is what makes this assertion a demonstration rather than a promise: it proves the
    // existence check sees files as well as directories.
    expect(arrived).toEqual(['packages/core/src/ports/memory-search']);
  });
});
