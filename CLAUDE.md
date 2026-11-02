# CLAUDE.md — Working agreement for building Village

You are implementing **Village**, an open-source, self-hosted AI agent that belongs to a *group* rather than one person. The complete implementation plan is in `docs/plan/`. It is the source of truth. Start every session by reading `docs/plan/README.md` and `docs/plan/STATUS.md`.

## 1. How to execute the plan

1. **Work milestone by milestone** in the order in `docs/plan/14-milestones.md` (M0 → M15). Do not start a milestone until the previous milestone's exit gate is green, unless `14-milestones.md` explicitly marks the work as parallelizable.
2. **Before starting a milestone:**
   - Read its section in `14-milestones.md`.
   - Read the referenced sections of the subsystem specs (`02`–`13`). Read only the sections you need; the specs are long.
   - Write a short execution note into `docs/plan/STATUS.md` covering the task order, risks and any spikes.
3. **For each task** (IDs like `M5-T3`):
   1. Implement it with tests, following the spec.
   2. Run `pnpm verify` (lint, typecheck, dependency rules, tests, build). Fix all failures.
   3. Update `docs/plan/STATUS.md`: tick the task and log any decisions or deviations.
   4. Commit with a Conventional Commit message that references the task ID, e.g. `feat(core): add IFC join and canRead (M5-T2)`.
4. **At the end of each milestone:**
   1. Run the milestone's exit gate from `14-milestones.md` / `11-quality-evals-observability.md` §Quality gates.
   2. Write a short milestone report in `STATUS.md`: what shipped, gate results, known gaps.
   3. Only then move on.
5. **Parallelism.** You may use sub-agents for independent, well-specified work, such as separate channel adapters, dashboard screens or eval scenario authoring. Never parallelize work on `packages/core` policy/IFC code or on database migrations; do that serially and carefully.

## 2. Non-negotiables (from `docs/plan/01-architecture.md`)

- **Invariants I1–I7 are sacred** (no read-up, no write-down, requester authority, group isolation, guarded egress, exactly-once intent, acknowledged effects). Any change touching context building, tools, policy, IFC, outbox or the turn journal must keep or add property-based tests for these invariants.
- **`@village/core` is pure:**
  - no I/O, no `Date`, no `Math.random`, no `process`, no `node:*` imports;
  - clock, IDs and RNG are injected.
- **better-sqlite3 transactions never span an `await`.** Use the `db.tx(syncFn)` helper only.
- **Validate every boundary with zod:** config, HTTP, adapters, tool I/O, LLM outputs, JSON columns.
- **TypeScript strict:**
  - no `any` outside tests;
  - exhaustive switches with `never` checks;
  - no floating promises.
- **Logs never contain message or memory content** above `debug`.
- **Dependency boundaries** are enforced by dependency-cruiser (`01` §4). Do not weaken the rules to make an import work; fix the design.
- **Platform APIs:**
  - only official ones;
  - never unofficial WhatsApp/iMessage clients;
  - no scraping;
  - zero telemetry.
- **Copy is product.** Bot messages, tool descriptions and the behavior charter live in versioned template files, not inline strings.

## 3. Anthropic / model API rules

- **Before writing or changing any code that calls Claude, load the `claude-api` skill** and follow it. Use the official `@anthropic-ai/sdk`. Never guess SDK shapes.
- Default models:
  - chat: `claude-opus-5-5`
  - route, extract, declassify and guard: `claude-haiku-5-5`
  - consolidate: `claude-sonnet-5-5` via the Batches API
- Never send `temperature`, `top_p` or `top_k`. Never use assistant prefill. Never use forced `tool_choice` (`any`/`tool`); use `auto` + `strict: true` tools, or structured outputs (`output_config.format`).
- Thinking on Opus 5.5:
  - adaptive thinking cannot be disabled;
  - control cost with `output_config.effort` and set it explicitly.
- Enable the server-side refusal fallback on Opus 5.5 requests.
- Tool loops:
  - always check `stop_reason`;
  - append `response.content` unchanged;
  - return all parallel `tool_result`s in one message.
- Verify prompt caching with `usage.cache_read_input_tokens` in tests.

## 4. Commands

These are created in M0; keep them working:

| Command | Purpose |
|---|---|
| `pnpm install` | install |
| `pnpm verify` | everything CI runs on a PR (lint, typecheck, depcruise, test, build, evals-smoke) |
| `pnpm test` / `pnpm test:watch` | Vitest |
| `pnpm test:prop` | property-based suites (longer runs) |
| `pnpm evals:smoke` | deterministic scenario suite with FakeModelGateway |
| `pnpm evals:live` | live-model evals (needs API keys; costs money; ask before running) |
| `pnpm dev` | server + dashboard in watch mode with the simulator channel |
| `pnpm db:generate` / `pnpm db:migrate` | drizzle-kit |

## 5. When to stop and ask the human

- Before changing the spine (`01-architecture.md`) or any normative decision. Propose the change in `STATUS.md` → "Decisions needing approval".
- Before adding a runtime dependency not named in the plan. Write a 5-line mini-ADR in `docs/adr/`.
- Before running anything that costs money (live evals, live model calls beyond a smoke test) or needs real credentials.
- Before publishing anything (npm, GHCR, GitHub releases, posts).
- When a spec is ambiguous in a way that changes user-visible behavior or privacy semantics.

## 6. Plan maintenance

- The plan is a living document. If implementation proves a spec wrong or incomplete, fix the spec in the same commit as the code and log it in `STATUS.md` → "Plan changes".
- Never silently diverge from the plan.
- Keep `docs/architecture/<package>.md` notes current for non-trivial modules.

## 7. Definition of done (per task)

- Code meets the spec, and the tests listed in the spec exist and pass.
- `pnpm verify` is green.
- No new lint suppressions without a justification comment.
- User-visible changes have docs (user docs land fully in M15; keep a running stub in `apps/docs` from M3).
- `STATUS.md` is updated.
