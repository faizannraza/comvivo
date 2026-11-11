# `@comvivo/core`

The pure domain. Entities, value objects, ports, the policy engine, information-flow control (labels, join, flow checks), the constitution schema and compiler, fairness algorithms and proactivity scoring. No I/O, no Date, no Math.random, no process, no node:* imports.

## Status

Scaffolded in **M0-T1**. The implementation lands in this package's own milestone — see
[`docs/plan/14-milestones.md`](../../docs/plan/14-milestones.md) for the task table, and
[`docs/plan/01-architecture.md`](../../docs/plan/01-architecture.md) §3–§4 for where this
package sits and what it is allowed to import.

## Boundaries

Dependency rules are enforced by dependency-cruiser in `pnpm verify`, not by convention.
This package may import: `@comvivo/shared`.
Never weaken a rule to make an import work; fix the design.

## Mutation testing

Coverage says a line ran; mutation testing asks whether anything would have noticed if the line
were wrong. That is the question that matters here, because this package's tests are the only
thing standing between an invariant and a silent breach — and the first run (`M1-T34`) found
`every` → `some` surviving in `canRead`, which is containment weakened to overlap with the suite
green either way.

```bash
pnpm run mutation:ifc   # src/ifc and src/policy, break threshold 75
pnpm run mutation       # the rest of core, break threshold 60
```

Both read a configuration in this directory, run from the repository root, and write an HTML report
to `reports/mutation/`. `11` §3.1.5 owns the thresholds and `.github/workflows/mutation.yml` runs
them: incrementally on a pull request that touches this package, in full every Monday. A surviving
mutant under `src/ifc` or `src/policy` opens an issue labelled `mutation-survivor`.

A mutant that **cannot** change an answer for any input is an equivalent mutant, not a test gap.
Say so where it is, with the reason:

```ts
// Stryker disable next-line StringLiteral: member ids are fixed-length typeids, so no two
// distinct sorted sets concatenate to the same string and the separator cannot change a key.
```

## License

Apache-2.0. See [`LICENSE`](../../LICENSE).
