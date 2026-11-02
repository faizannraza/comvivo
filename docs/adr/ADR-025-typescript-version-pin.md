# ADR-025 — Pin TypeScript to 6.x, not 7.x

- **Status:** Accepted (revisit when typescript-eslint ships TS 7 support)
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode — `CLAUDE.md` §5)
- **Amends:** ADR-001 (which says "TypeScript 5.x (strict)") and ADR-003 (lint and format)

## Context

`CLAUDE.md` §6 requires third-party facts to be re-verified at implementation time. Doing that
before writing the monorepo scaffold turned up a hard incompatibility between the two newest
versions of tools the spine depends on.

Verified from the npm registry on 2026-11-01:

- `typescript` latest is **7.0.2** (published 2026-07-08). `typescript@6.0.3` (2026-04-16) is the
  previous major. ADR-001's "TypeScript 5.x" is simply stale — 5.x is two majors behind.
- `typescript-eslint` latest is **8.72.1** (2026-10-26), and it declares a **required** peer
  dependency of `typescript: >=4.8.4 <6.1.0`.

That peer range is not a stale constant. TS 7 support is closed **`not_planned`** upstream
(typescript-eslint#12518, duplicated by #12720), with the maintainers' stated reason being that
there is no TS 7 JavaScript API to build on; the tracking issue #10940 ("Use TS 7 / tsgo for type
information") is open and locked. Work exists but has not landed: PR #12803 adds
`projectService.EXPERIMENTAL_backend` for a TS 7.1 native parser over IPC, still open as of
2026-11-01.

The registry manifests corroborate it mechanically: `typescript@7.0.2` ships `bin: {tsc}` only —
**no `tsserver`** — with `main: null` and exports limited to `.`, `./package.json` and
`./unstable/*`. `typescript@6.0.3` ships `bin: {tsc, tsserver}` and `main: ./lib/typescript.js`.
typescript-eslint drives the compiler through that API surface, so it genuinely cannot run on 7.x
yet.

This matters because four type-aware lint rules are **non-negotiable** in this codebase, not
stylistic preferences:

| Rule | Why the spine requires it |
|---|---|
| `no-floating-promises` | `01` §11.1 bans floating promises outright. This is an event-driven server with per-group actors, a durable job queue and a transactional outbox; a dropped promise silently loses a reminder or an outbound message, which breaks **I6** (exactly-once intent) and **I7** (acknowledged effects) |
| `no-misused-promises` | An `async` function passed where a sync predicate is expected always reads truthy. In the policy engine or the disclosure guard that is a silent `allow` |
| `switch-exhaustiveness-check` | `01` §11.3 requires exhaustive switches over discriminated unions with a `never` assertion. `PolicyDecision`, `FlowDecision`, `ToolOutcome` and the channel capability unions all depend on it: a new variant must break the build, not fall through |
| `strict-boolean-expressions` | Required in `core`. With `noUncheckedIndexedAccess` on, `if (x)` on a possibly-`undefined` label or member is exactly the bug class that produces an IFC labelling failure |

Biome 2.6.4 does now have its own type-aware engine (`linter.domains.types`) offering
`noFloatingPromises`, `noMisusedPromises` and `useExhaustiveSwitchCases` without a tsconfig. All
three are **nursery** rules with default severity `information`, and no fidelity comparison
against typescript-eslint is published. That is not a foundation for a gate that the leak and
reliability guarantees rest on.

## Decision

**Pin `typescript` to `6.0.3`** across the workspace, as an exact version in the root
`devDependencies`, and keep `typescript-eslint` as the authority for type-aware rules.

- `tsdown@0.23.4` accepts `typescript: ^5.0.0 || ^6.0.0 || ^7.0.0`, so the bundler is not the
  constraint. typescript-eslint is the only binding one.
- Biome stays responsible for formatting and for the fast non-type-aware lint pass, exactly as
  ADR-003 says. Its nursery type-aware rules may be enabled later as a cheap pre-filter, never as
  the gate.
- ADR-001's "TypeScript 5.x (strict)" is read as **"TypeScript 6.x (strict)"**. Every strictness
  flag it names is unchanged: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- A `renovate.json5` rule (`M0-T13`) holds `typescript` on the 6.x range so a well-meaning
  automatic major bump cannot silently disable the type-aware lint gate.
- **Revisit trigger:** typescript-eslint#12803 landing, or any typescript-eslint release whose peer
  range admits `typescript@7`. At that point this ADR gets an addendum and `pnpm verify` is re-run
  on both compilers before the pin moves.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **TypeScript 7.0.2 + drop typescript-eslint, rely on Biome's type-aware rules** | The three Biome equivalents are nursery-grade at `information` severity, the fourth (`strict-boolean-expressions`) has no equivalent at all, and no fidelity data is published. Trading a proven lint gate for an experimental one, on precisely the rules that protect I6, I7 and the IFC labelling, is the wrong trade for a 1.0 that claims zero leaks |
| **TypeScript 7.0.2 + typescript-eslint without type-aware rules** | Keeps the formatter-grade rules and loses all four rules that matter. `01` §11.1 and §11.3 would be unenforceable |
| **Run TS 7 for builds and TS 6 only for linting** (Microsoft documents side-by-side installs) | Two compilers means two type-checking semantics in one repo: code can pass `tsc -b` on 7 and be mistyped under the 6 program the linter builds, or vice versa. The whole value of type-aware linting is that it shares the build's program. Rejected as a false economy |
| **Stay on TypeScript 5.x as ADR-001 literally says** | Two majors behind, so it forgoes real fixes for no benefit. typescript-eslint's peer range admits 6.x, so there is nothing to gain |
| **Wait for typescript-eslint TS 7 support before scaffolding** | Upstream has closed it `not_planned` pending an API that does not exist. Blocking M0 on another project's roadmap is not an option |

## Consequences

**Good**
- The type-aware lint gate works from the first commit, so `no-floating-promises` and the
  exhaustive-switch check are enforced on `core`'s policy and IFC code from the moment it exists —
  which is when they are most valuable.
- One compiler, one set of semantics, shared by `tsc -b`, the linter and the editor.
- Everything else in the toolchain is on its current latest: Vitest 5.0.5, Biome 2.6.4, tsdown
  0.23.4, dependency-cruiser 18.7.1, zod 4.6.7, pnpm 12.16.1, Node 26.13.0.

**Bad / accepted costs**
- One major behind on the compiler, so TS 7's performance work and any 7-only syntax are
  unavailable. Nothing in the plan needs them.
- A pin that must be actively watched. Mitigated by the Renovate rule and the explicit revisit
  trigger above, both of which fail loudly rather than drifting.
- `typescript@6.0.3` is from 2026-04-16, so it will age. If a security advisory lands against 6.x
  before typescript-eslint supports 7, the escape hatch is to move the type-aware rules to
  `warn` for one release while bumping — recorded here so that decision is not reinvented under
  pressure.

**Follow-ups**
- `M0-T1` pins the exact version in the root `devDependencies`.
- `M0-T4` wires the four rules with `projectService: true` and proves each one with a
  planted-violation fixture that makes `pnpm verify` fail.
- `M0-T13` adds the Renovate rule holding `typescript` on 6.x.
- `M14-T24` (Drizzle v1 re-evaluation) is the natural place to re-check this pin as well, since
  both are "newest major deliberately deferred" decisions.

## References
- `docs/plan/01-architecture.md` §2 ADR-001, ADR-003; §11.1, §11.3
- `docs/adr/ADR-001-language-and-runtime.md`, `docs/adr/ADR-003-lint-and-format.md`
- `https://registry.npmjs.org/typescript` · `https://registry.npmjs.org/typescript-eslint`
- typescript-eslint issues #12518 (closed `not_planned`), #12720, #10940 (open, locked); PR #12803
- `https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0`
