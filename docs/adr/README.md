# Architecture Decision Records

This directory holds one file per architecture decision. ADR-001 … ADR-023 are the decisions recorded in the implementation plan's spine, `docs/plan/01-architecture.md` §2, **with the resolved amendments in `01` §14 (A1–A30) folded in**. Where §2 and §14 disagree, **§14 wins**, and each ADR names the amendments that changed it in its "Supersedes / Amended by" line.

## Index

| # | Decision | Status |
|---|---|---|
| [ADR-001](ADR-001-language-and-runtime.md) | Language and runtime — TypeScript strict, ESM, Node 26 LTS primary / Node 24 ≥ 24.11 supported | Accepted |
| [ADR-002](ADR-002-monorepo.md) | Monorepo tooling — pnpm workspaces, Turborepo, TS project references, tsdown | Accepted |
| [ADR-003](ADR-003-lint-and-format.md) | Lint and format — Biome, plus typescript-eslint for type-aware rules only | Accepted |
| [ADR-004](ADR-004-testing.md) | Testing stack — Vitest, fast-check, Playwright, `@village/evals` | Accepted |
| [ADR-005](ADR-005-storage.md) | Storage — encrypted SQLite, Drizzle, FTS5, sqlite-vec | **Accepted (addendum pending SP-1)** |
| [ADR-006](ADR-006-llm-access.md) | LLM access — own `ModelGateway` port with native provider SDKs | Accepted |
| [ADR-007](ADR-007-embeddings.md) | Embeddings — local by default via transformers.js; default model from SP-6 | **Accepted (addendum pending SP-6)** |
| [ADR-008](ADR-008-http.md) | HTTP layer — Hono, `@hono/zod-openapi`, SSE | Accepted |
| [ADR-009](ADR-009-dashboard.md) | Dashboard — React 19 + Vite + TanStack + Tailwind v4 + shadcn/ui, served as static assets | Accepted |
| [ADR-010](ADR-010-validation-and-types.md) | Validation and types — zod v4 everywhere, branded ids, discriminated-union outcomes | Accepted |
| [ADR-011](ADR-011-time.md) | Time, timezones and recurrence — Temporal via `temporal-polyfill`; RRULE library from SP-7 | **Accepted (addendum pending SP-7)** |
| [ADR-012](ADR-012-jobs.md) | Background jobs — in-house durable queue on SQLite | Accepted |
| [ADR-013](ADR-013-observability.md) | Observability and explainability — pino, optional OTel, in-database `TurnTrace` | Accepted |
| [ADR-014](ADR-014-configuration.md) | Configuration — YAML + env/keyfile + DB settings, with host-only keys | Accepted |
| [ADR-015](ADR-015-packaging.md) | Packaging and distribution — Docker, Compose, thin CLI + server runtime, appliances | Accepted |
| [ADR-016](ADR-016-license-and-contributions.md) | License and contributions — Apache-2.0, DCO, no CLA, Contributor Covenant 2.1 | Accepted |
| [ADR-017](ADR-017-telemetry.md) | Telemetry — none | Accepted |
| [ADR-018](ADR-018-i18n.md) | Internationalization — model-driven bot language, i18next dashboard, per-member locale | Accepted |
| [ADR-019](ADR-019-ids.md) | Identifiers — TypeID with branded types per entity | Accepted |
| [ADR-020](ADR-020-dependency-boundaries.md) | Dependency boundaries — `01` §4 as amended by A11, enforced by dependency-cruiser | Accepted |
| [ADR-021](ADR-021-mcp-sdk-v2.md) | MCP — spec 2026-07-28, SDK v2, `/mcp` on the main listener, per-member bearer tokens | Accepted |
| [ADR-022](ADR-022-docs-site-analytics.md) | Docs-site analytics — self-hosted cookieless Umami, docs site only (product telemetry stays zero) | Accepted |
| [ADR-023](ADR-023-tool-catalog.md) | Tool catalog strategy — one stable ordered catalog keyed by `catalogHash` | **Proposed** (decided by SP-5 / `M2-T20`, finalised by `M13-T15`) |
| [ADR-024](ADR-024-product-name.md) | Product name — **Comvivo**; resolves owner decision **D-2** and supersedes the naming half of `01` §14 A2 | Accepted |
| [ADR-025](ADR-025-typescript-version-pin.md) | TypeScript pinned to 6.x, because `typescript-eslint` cannot yet run on TS 7 — amends ADR-001 and ADR-003 | Accepted (revisit on typescript-eslint TS 7 support) |

ADR-001 … ADR-023 are the spine's own decisions; **ADR-024 onward are decisions taken during implementation** and are recorded here the same way. Each is logged in `docs/plan/STATUS.md` → Decisions log with its rationale (ADR-024 = DL-8, ADR-025 = DL-9).

**Addenda.** Three decisions are deliberately not final, because they depend on a measurement rather than an argument. Each is marked *addendum pending* above, states its fallback in its own file, and gets an addendum written by the task that runs the spike: ADR-005 by `M1-T2` (SP-1, SP-3), ADR-007 by `M6-T7` (SP-6, which writes `ADR-007-addendum.md` in this directory), and ADR-011 by `M7-T1` (SP-7). ADR-023 is `Proposed` and becomes `Accepted` at `M13-T15`.

**Package names.** These files use the plan's `@village/*` package names and the `village.yaml` / `VILLAGE_` spellings, because that is how `02`–`13` are written. The real names are `@comvivo/*`, `comvivo.yaml` and `COMVIVO_` (ADR-024). Per `01` §14 A2 as superseded by ADR-024, read every published name through `BRAND` (`BRAND.npmScope`, `BRAND.npmCliPackage`, `BRAND.configFileName`, `BRAND.envPrefix`) and `deploy/names.json`; package *directory* names are unchanged, and `BRAND.legacy` keeps the old config name and env prefix working with a deprecation warning until 1.1.

## The ADR process

These files are the **record** of decisions, not the forum for making them. The plan in `docs/plan/` is the source of truth for what gets built; `01` §2 and `01` §14 are where the spine's decisions are made, and these files restate them in full with their context, alternatives and consequences so a contributor can understand a trade-off without reading a 600-line spine. A decision changes in one of two ways: a **spine change** follows `14-milestones.md` §0.5 rule 2 — it is proposed in `STATUS.md`, resolved as a new `01` §14 amendment row, and the affected specs and the ADR are updated in **one** commit; a **spike or measurement outcome** lands as an addendum to the existing ADR plus a `STATUS.md` → Spikes entry, and never as a silent edit. The project operates in the autonomous mode described in `CLAUDE.md` §5, so new architectural decisions taken during implementation are made with deep critical thinking against the plan's recommendations, recorded here as a new ADR (the next free number after the highest in the index above) and logged in `STATUS.md` → Decisions log — the human is asked only for money, credentials and account actions, and a brief real-chat smoke test. Never silently diverge from the plan: if implementation proves a decision wrong, fix the ADR and the spec in the same commit as the code.

## When a mini-ADR is required

A **new runtime dependency that is not named in the plan** needs a 5-line mini-ADR in this directory (`14-milestones.md` §0.5 rule 6). Use [`TEMPLATE-mini.md`](TEMPLATE-mini.md), name the file `MINI-<package-name>.md`, and add a line to `STATUS.md` → Decisions log. The five fields are: **Dependency**, **Why it is needed**, **Alternatives rejected**, **Risk + license + maintenance check**, and **Decision + date**. A mini-ADR is *not* needed for a dev-only dependency, or for anything already named in `01` §2, in a spec's §2 key-decisions table, or in a spec's own "runtime dependencies introduced by this document" list — `09` §2.1 names its dependencies there for exactly this reason. Anything bigger than a dependency — a change to the spine, a new package, a new dependency-boundary edge, a new published artefact — is a spine change under §0.5 rule 2 and needs a full ADR, not a mini one.

## Writing a new ADR

Copy the structure every file here uses: a header block (Status, Date, Deciders, Supersedes / Amended by), then **Context**, **Decision**, **Alternatives considered** (a table, one row per real alternative with a real reason — never padded with invented ones), **Consequences** (Good / Bad or accepted costs / Follow-ups, with canonical task ids like `M5-T2` or spike ids like `SP-1`), and **References**. Keep internal links pointing only at files that exist; name future work by its task id in prose instead of linking to a file that has not been written yet.
