# ADR-003 — Lint and format

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** —

## Context

- Village is an event-driven server. The bugs that hurt are async bugs: a floating promise that drops a turn, a promise passed where a boolean was expected, a `switch` that silently ignores a new union member.
- `01` §11.3 requires exhaustive `switch` over discriminated unions with a `never` assertion, and §11.1 bans `any` outside tests. Those rules need a type-aware linter; a syntactic one cannot see them.
- Lint has to run on every PR inside `pnpm verify`, across ~24 workspaces, so a full type-aware ESLint pass over the whole repo would be the slowest job in CI.
- `core` has stricter rules than the rest of the repo: no `Date`, no `Math.random`, no `process`, no `node:*`, no I/O (ADR-020, A11).

## Decision

**Two tools, with a deliberate split.**

| Tool | Scope |
|---|---|
| **Biome** | Formatting and all syntactic linting, repo-wide. Single source of formatting truth; no Prettier |
| **typescript-eslint** | **Only** type-aware rules, which Biome cannot express: `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check`, and `strict-boolean-expressions` **in `core`** |

Additional bans and lints that live alongside this configuration rather than in a separate ADR:

- Core purity bans (`Date`, `Math.random`, `process`, `node:*`) and the A11 module restrictions are enforced by dependency-cruiser plus lint rules in `M0-T4`.
- A lint rule forbids an `async` function being passed to `store.write`/`store.read` so a better-sqlite3 transaction can never span an `await` (`02` §2 D10, `M1-T9`).
- Test-hygiene lints (`M0-T10`): no `.only`, no sleeps, no unjustified `skip`, snapshot policy, workflow lint.
- A new lint suppression requires a justification comment (`CLAUDE.md` §7).

## Alternatives considered

| Alternative | Why not |
|---|---|
| **ESLint only** (format with Prettier, lint with ESLint) | Running the full rule set type-aware over 24 workspaces is slow enough to dominate `pnpm verify`, and the formatting half duplicates what Biome already does in a fraction of the time. |
| **oxlint** | Fast and promising, but it does not (at decision time) provide the type-aware rules that are the entire reason we keep a second linter. Adopting it would mean losing `no-floating-promises` and `switch-exhaustiveness-check`, which are the rules that protect the turn engine. |

## Consequences

**Good**
- Formatting is instant and uncontested; contributors never argue with it.
- The four type-aware rules that actually catch production bugs are enforced, and only those, so the slow linter has a small surface.
- Core purity is machine-checked, which is what makes "`@village/core` is pure" a claim rather than a hope.

**Bad / accepted costs**
- Two lint configurations to keep in sync, and contributors must learn which tool owns which complaint.
- typescript-eslint needs a type-aware program per project; adding a package means wiring it into the lint config as well as the build.
- Biome and typescript-eslint can disagree about a style detail; Biome wins, and the overlapping ESLint rule is disabled explicitly.

**Follow-ups**
- `M0-T4` — dependency boundaries and lint bans, including core purity.
- `M0-T10` — test-hygiene lints.
- `M1-T9` — the no-`await`-in-transaction lint.

## References
- `docs/plan/01-architecture.md` §2 ADR-003, §4, §11.1, §11.3, §14 A11
- `docs/plan/02-domain-model-and-storage.md` §2 D10
