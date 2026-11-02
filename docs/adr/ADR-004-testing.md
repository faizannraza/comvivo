# ADR-004 — Testing stack

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A17** (`@village/evals` is published; `village eval` imports it dynamically as an optional dependency)

## Context

- Village's central promise is that it does not leak between members. A promise like that cannot be supported by example-based tests: the interesting cases are the ones nobody thought to write. Invariants I1–I7 and C1 (`01` §1, §14 A4) need generated inputs.
- `@village/core` is pure and deterministic by construction (ADR-001, ADR-020), so it is exhaustively testable with no fixtures and no clock.
- Every channel adapter talks to a platform we cannot call in CI, so adapters need contract tests against recorded payloads (`fixtures/`).
- The dashboard is a user-facing surface with an accessibility bar (WCAG 2.2 AA, `01` §11.11), so it needs browser-level tests with axe checks.
- Features are only "done" with eval scenarios (`01` §11.5), and those scenarios must run deterministically on every PR without spending API budget.

## Decision

| Layer | Tool |
|---|---|
| Unit and integration | **Vitest** — one workspace with per-package projects, tags, a network guard and coverage thresholds (`M0-T3`) |
| Property-based | **fast-check**, **mandatory** for policy, IFC and fairness, plus time logic. Shared `fcConfig` in `M0-T7`; longer runs behind `pnpm test:prop` |
| Dashboard end-to-end | **Playwright**, with `@axe-core/playwright` for accessibility assertions |
| Scenario / behavioural | the **`@village/evals`** simulation harness: persona agents, a scenario DSL, red-team suites and metrics, driven by the in-memory simulator channel and `FakeModelGateway` |

Supporting decisions that make the above deterministic:

- Testing primitives in `M0-T7`: `VirtualClock`, `SeededRng`, `DeterministicIds`.
- `FakeModelGateway` plus `ScriptedModel`, `CassetteModel` and a recorder (`M2-T7`), and a wire-level `FakeProviderServer` for chaos and contract tests (`M2-T10`).
- `pnpm evals:smoke` is part of `pnpm verify`; `pnpm evals:live` spends budget and is run deliberately.
- **A17:** `@village/evals` is a published package so plugin authors can use the simulator kit, and the CLI's `village eval` imports it dynamically as an optional dependency.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Jest** | Not ESM-native at the time of the decision; the repo is ESM-only (ADR-001). Its transform pipeline would add a second module system to reason about, and its watch mode is slower on a monorepo of this size. |
| **Mocha** | A test runner only. We would assemble assertions, mocking, coverage and a workspace model ourselves, and still not get Vitest's watch and ESM behaviour. |

## Consequences

**Good**
- The leak-prevention claim rests on generated inputs and noninterference ("twin") tests, which is the only credible basis for it (`15` §3 R-1).
- With an injected clock, RNG and ID generator, core tests have no flake surface at all.
- The per-PR guarantee does not depend on a model provider: adversarial fake models carry it (`15` §3 R-14).

**Bad / accepted costs**
- Property tests are slower and occasionally surface a failure that is hard to minimise; `test:prop` is therefore a separate, longer command.
- Playwright adds browser downloads to CI and a second kind of flake to manage.
- Publishing `@village/evals` (A17) makes the harness a semver surface, so its DSL cannot be refactored freely after 1.0.

**Follow-ups**
- `M0-T3` — Vitest workspace, projects, tags, network guard, coverage thresholds.
- `M0-T7` — `VirtualClock`, `SeededRng`, `DeterministicIds`, `fcConfig`.
- `M0-T10` — test-hygiene lints (no `.only`, no sleeps, no unjustified skips).
- `M2-T7`, `M2-T10` — model doubles and the wire-level fake provider.

## References
- `docs/plan/01-architecture.md` §2 ADR-004, §11.5, §14 A4, A17
- `docs/plan/11-quality-evals-observability.md` §2, §3
- `docs/plan/15-risks-and-open-questions.md` §3 R-1, R-14
