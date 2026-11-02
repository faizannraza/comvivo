# `@comvivo/server`

The composition root: dependency wiring, the Hono HTTP API, worker loops and process lifecycle.

## Status

Scaffolded in **M0-T1**. The implementation lands in this package's own milestone — see
[`docs/plan/14-milestones.md`](../../docs/plan/14-milestones.md) for the task table, and
[`docs/plan/01-architecture.md`](../../docs/plan/01-architecture.md) §3–§4 for where this
package sits and what it is allowed to import.

## Boundaries

Dependency rules are enforced by dependency-cruiser in `pnpm verify`, not by convention.
This package may import: `@comvivo/core`, `@comvivo/shared`, `@comvivo/storage`, `@comvivo/models`, `@comvivo/engine`, `@comvivo/tools`, `@comvivo/channel-sdk`, `@comvivo/plugin-sdk`, `@comvivo/plugin-host`, `@comvivo/mcp`, `@comvivo/channel-telegram`, `@comvivo/channel-web`, `@comvivo/channel-simulator`.
Never weaken a rule to make an import work; fix the design.

## License

Apache-2.0. See [`LICENSE`](../../LICENSE).
