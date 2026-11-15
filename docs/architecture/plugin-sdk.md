# `@comvivo/plugin-sdk` — the tool contract

What a tool is, what a tool is handed, and which of those decisions the host makes regardless of
what a plugin's code says.

Specs: `10` §3.2.1–§3.2.4 (package layout, `defineTool`, `ToolOutcome`, `ToolContext`), `01` §7.4
(the spine's tool shape) and `01` §14 **A23** (the additive fields). Built at `M2-T5`;
`definePlugin`, the manifest schema, the RPC protocol, the child runtime, the test kit and the
author CLI land in M12.

## One definition type, two kinds of author

`@comvivo/tools`' built-ins and a stranger's npm package use the same `ToolDefinition`. Everything
downstream — `05`'s turn loop, the catalog hash, the MCP bridge, `11`'s evals — reads tools through
that one shape, which is why a plugin's feature is as reachable from chat as a built-in's.

The consequence that shapes this package: **it is published**. Every name in
`etc/plugin-sdk.api.md` is a compatibility promise, and `pnpm api:check` fails when the built
`.d.ts` and that file disagree. Adding an export is cheap. Removing one is a major version.

## The five rules the host enforces anyway

`10` §3.2.3 lists them. Three are pure functions and live in `src/tool.ts`, so the host,
`comvivo plugin check` and a plugin's own tests compute the same answer from the same code:

| Rule | Function | Why it cannot be advisory |
|---|---|---|
| Effective risk is `max(definition.risk, action().risk ?? 'low')` | `effectiveRisk` | A tool that declared `high` and then returned a `low` draft for the one call that mattered would skip the confirmation the group was promised. |
| A plugin `write` tool is at least `medium` | `effectiveRisk` | The approval screen's risk badge is the only thing most hosts read. |
| A plugin's capability is always `plugin:<id>:<name>` | `effectiveCapability` | A plugin that could name its own capability could name `calendar.write` and borrow a grant the group gave to the calendar. |

The remaining two belong to the executor and cannot be computed from a definition: `dataLabels`
and `provenance` on an `ActionRequest` are the executor's (`M5-T9`), and an output that fails its
schema becomes `{ kind: 'error', code: 'internal' }` logged as `plugin.output_invalid`.

Built-ins are exempt from the `write` floor, deliberately: their risk is reviewed in this
repository against `03`'s action registry, and forcing `lists.addItems` to `medium` would ask a
family to confirm adding milk.

## Permissions are a type parameter

`10` §3.2.2 asks for `ToolContext<P>` to expose `repos.calendar` only when the manifest declared
it, and `http` only when it declared `network`. `src/permissions.ts` does that with three helpers
(`Grants`, `GrantsSecrets`, `RepoGrant`) and a mapped type whose `as` clause **removes** undeclared
keys rather than making them optional.

The difference matters. With optional members, `ctx.http?.fetch(url)` compiles for a plugin that
never asked for the network and fails at runtime on somebody else's instance, in their family
group, at the moment they needed it. With the key removed it is a red squiggle in the author's
editor. `src/context.types.test.ts` pins every one of those compile errors with
`@ts-expect-error`, so the narrowing cannot quietly stop working.

Two refinements of the same kind:

- `secrets.reveal` takes `RevealableSecretKeyOf<P>`, which is `never` for a plugin that did not
  declare `reveal: true`. The permission denial moved to compile time, where it costs nothing.
- `repos.memory` and `repos.members` accept only `'read'`, and `repos.reminders` only `'write'`
  (`10` §3.2.4 gives reminders one method and nothing to read). A manifest that asks for the wrong
  one fails to typecheck instead of receiving a facade with no methods on it.

## Why the views are projections

`@comvivo/core` already has `Event`, `Task` and `List`. Handing one to a plugin would be shorter to
write and would also hand over `labelId`, `rid`, `version`, `tzdataVersion`, `occurrenceKey` and
`contentHash` — storage mechanics that a plugin would come to depend on and that we could then
never change.

The field types are spelled out rather than written as `Event['title']`. The indexed access would
keep them in lockstep, but it puts `Event` — a type this package deliberately does not export —
into the published `.d.ts`, where an author's editor sends them chasing a name they cannot import.
The mapping lives in `M5-T9`'s facade, which is where a domain change should surface as a type
error.

Every view carries `label` and `provenance`, so a plugin propagates them on a derived write
instead of inventing a label — which is a write-down (I2) waiting to happen. `provenance` says
*who or what* produced the row; trust lives on `label.untrusted` and is not duplicated.

## `"types": ["node"]`, and the six bans that pay for it

`ToolContext.signal` is an `AbortSignal` and `EgressHttp.fetch` returns a `Response`. Neither
exists under `lib.es2024` with an empty `types` array, so the package's tsconfig takes Node's
types — the same trade `packages/core` made at `M2-T1`, and for the same reason the DOM lib is
worse (it brings `window` and `document` into a package third parties compile against).

Until then `types: []` was doing part of the enforcement by accident. Trading an accident for a
rule means naming what the accident covered, which is `Date`, `process`, `setTimeout`,
`setInterval`, `setImmediate`, `Buffer` — plus `fetch` and `Math.random`, which were already
banned elsewhere. `comvivo/plugin-sdk-purity` in `eslint.config.ts` carries all of them, and
`test/boundaries/lint-bans.int.test.ts` plants each one.

The argument is stronger here than in `core`: every banned global has a replacement **on the
context object a tool is handed** — `ctx.clock`, `ctx.http`, `ctx.settings`, `ctx.store`. This is
the package whose examples people copy, and a plugin that reads the wall clock cannot be replayed
in the simulator, which is where `07`'s recurrence and quiet-hours bugs get found.

## `zod` is a peer dependency, and that needed a rule change

`10` §3.2.1 makes `zod@^4` a peer, and it has to be: a plugin builds its schemas with its own copy
of zod, and `toStrictJsonSchema` walks the schema object it is given. A second copy resolved under
the SDK would be walking a structure it did not create.

`no-dev-dep-in-src` in `.dependency-cruiser.cjs` refused that import, because pnpm resolves a peer
through the matching devDependency and dependency-cruiser reported `['npm-peer', 'npm-dev', …]`.
The rule now carries `dependencyTypesNot: ['npm-peer']`: a peer dependency is a declared runtime
requirement of the consumer, not something we ship. A devDependency that is *not* also a peer still
fails — the planted `vitest` import in `test/boundaries/fixtures.int.test.ts` proves it.

## Where the strict-schema converter lives

In `@comvivo/shared`, not here. `05` §3.6.2 named `models/src/schema/to-strict-json-schema.ts` and
`10` §3.5.2 named `plugin-sdk/src/schema/strict.ts`; two converters producing "the same" schema is
two sets of edge cases, and this schema is what a provider's `strict: true` validation checks
arguments against. A disagreement between them means a tool whose arguments validate for the host
and not for the provider, or the reverse. `M2-T4` built one, and this package re-exports it so a
plugin author still needs a single import.

`defineTool` runs it eagerly on both the input and the output schema. A schema that cannot be made
strict — recursive, or rooted at something other than an object — throws at module load, in the
author's own `pnpm test`, rather than during `comvivo plugin add` after the package is published.
`toolSchemas` caches the conversion in a `WeakMap` keyed by the definition, so the catalog
(`M2-T17`) hashes exactly the bytes `defineTool` proved convertible.
