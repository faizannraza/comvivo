# ADR-002 — Monorepo tooling

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A11** (new packages: `packages/plugin-host`, `packages/mcp-bridge`, `packages/plugins/*`, `packages/api-client`, `templates/skills/`, `packages/shared/src/brand.ts`)

## Context

- The repository holds ~20 publishable or privately-bundled packages plus four apps (`01` §3, as amended by A11): a pure core, storage, model adapters, an engine, eight channel adapters, two SDKs, MCP, evals, the server, the CLI, the dashboard and the docs site.
- Dependency direction is a **product** constraint, not a preference: `core` must stay pure and `tools` must never import `storage` (ADR-020). The build system has to make those boundaries real rather than aspirational.
- Only five packages are ever published (`12` §2 P11); everything else is bundled into the server runtime. So the build must produce both library output for the published few and a bundle for the rest.
- CI must stay fast enough that a contributor's PR is not a coffee break. `pnpm verify` runs lint, typecheck, depcruise, test, build and the smoke evals (`CLAUDE.md` §4).

## Decision

| Concern | Choice |
|---|---|
| Workspaces | **pnpm workspaces** (`pnpm-workspace.yaml`), with pnpm pinned by the `packageManager` field and installed explicitly in CI (ADR-001, A1) |
| Task graph and caching | **Turborepo** — one task graph for `lint`, `typecheck`, `test`, `build`, `depcruise`, with local and CI caching |
| Type boundaries | **TypeScript project references**, one `tsconfig.json` per package, so a forbidden import fails `typecheck` and not only dependency-cruiser |
| Library builds | **tsdown** (the maintained successor to tsup) for every package and app bundle |
| Published surface | Only the five packages in `12` §2 P11 get publish config; all others are `"private": true` |

Supply-chain policy belongs to the same scaffold and is set in `M0-T2`: pnpm `minimumReleaseAge` (3 days), `trustPolicy`, and an explicit `allowBuilds` list so no dependency runs install scripts by accident (`15` §3 R-11).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Nx** | More machinery than this repo needs: generators, plugins and an inferred task graph we would have to learn and then constrain. Turborepo's whole configuration fits in one file we can read in a minute, and the boundary enforcement we care about comes from dependency-cruiser and project references, not from the task runner. |
| **Rush** | Heavier policy model and its own install flow; it buys governance for large multi-team monorepos, which is not the shape of this project. |
| **Plain `tsc` with no task runner** | Would work, but loses cache-aware ordering across ~24 workspaces. Full-repo rebuilds on every PR would make the `pnpm verify` gate the slowest part of contributing. |

## Consequences

**Good**
- A forbidden import is a compile error in the contributor's editor, before CI.
- Turborepo caching keeps `pnpm verify` usable as the single pre-PR command.
- tsdown produces both the published library output and the single-file server bundle, so there is one build tool to understand.

**Bad / accepted costs**
- Project references mean `tsconfig` churn whenever a package is added; A11 already adds six entries.
- Turborepo cache correctness depends on declaring task inputs honestly; a missed input produces a stale pass, which is the worst kind of green.
- tsdown is younger than tsup was at adoption time, so a build-tool regression is a real (if small) risk; it is pinned and bumped deliberately.

**Follow-ups**
- `M0-T1` — the scaffold itself: every package and app from `01` §3 and A11 as a skeleton, plus root scripts.
- `M0-T2` — runtime pins and the pnpm supply-chain policy.
- `M0-T4` — dependency-cruiser encoding of `01` §4 as amended by A11 (ADR-020).
- `M0-T14` — Changesets configuration on top of this layout (`12` §2 P12).

## References
- `docs/plan/01-architecture.md` §2 ADR-002, §3, §14 A11
- `docs/plan/12-packaging-release-ops.md` §2 P11, P12
- `docs/plan/15-risks-and-open-questions.md` §3 R-11
