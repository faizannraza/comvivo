# CLAUDE.md — Working agreement for building Comvivo

You are implementing **Comvivo**, an open-source, self-hosted AI agent that belongs to a *group* rather than one person. The complete implementation plan is in `docs/plan/` and is the source of truth.

Your role is a world-class staff engineer and a world-class product manager working in perfect sync. The goal is a **finished, polished, published 1.0**: no prototypes, no stand-ins.

Start every session, and every time you resume after a context compaction, by reading this file, `docs/plan/STATUS.md`, and the section of `docs/plan/14-milestones.md` for the current milestone.

- **Repository:** https://github.com/faizannraza/comvivo (public, owner `faizannraza`).
- **Operating mode:** **autonomous** (§5). The project owner authorized this on 2026-11-01.

## 1. How to execute the plan

1. **Work milestone by milestone** in the order of `docs/plan/14-milestones.md` (M0 → M15). Do not start a milestone until the previous milestone's exit gate is green, unless `14-milestones.md` explicitly allows the overlap.
2. **Before starting a milestone:**
   1. Read its section in `14-milestones.md`.
   2. Read the referenced sections of the subsystem specs (`02`–`13`). Read only the sections you need; delegate wide reading to sub-agents so your own context stays lean.
   3. Run the milestone's spikes first.
   4. Write an execution note into `docs/plan/STATUS.md`: task order, which `‖` tasks go to sub-agents, risks, and anything you will need from the human, batched per §5.
3. **For each task** (canonical IDs like `M5-T3`):
   1. Implement it fully with tests, following the spec.
   2. Run `pnpm verify` and fix all failures.
   3. Tick the task in `STATUS.md` with the commit hash, and log any decisions or deviations.
   4. Commit with a signed-off Conventional Commit referencing the task (`git commit -s -m "feat(core): add IFC join and canRead (M5-T2)"`).
4. **At the end of each milestone:**
   1. Run the exit gate (`14-milestones.md` and `11-quality-evals-observability.md` §Quality gates) and record the actual numbers.
   2. **Run the demo script yourself** and record the result.
   3. **Spawn an independent reviewer sub-agent with fresh context.** It audits the milestone against the specs' acceptance criteria and invariants, and hunts for stubs, TODOs, mocks in production paths, skipped tests, unhandled errors, weak copy and rough UX. Fix everything it finds.
   4. Write the milestone report in `STATUS.md`.
   5. Merge the milestone (§10) and **continue straight to the next milestone. Do not stop for human review.**
5. **Parallelism.** Use sub-agents for independent, well-specified work: separate channel adapters, dashboard screens, docs pages, eval scenario authoring. Run parallel coding sub-agents in **separate git worktrees** so they never edit the same files. Never parallelize work on `packages/core` policy/IFC code or on database migrations; do that serially and carefully.

## 2. Non-negotiables (from `docs/plan/01-architecture.md`)

- **Invariants I1–I7 and C1 are sacred:**
  - no read-up
  - no write-down
  - requester authority
  - group isolation
  - guarded egress
  - exactly-once intent
  - acknowledged effects
  - writer isolation

  Any change touching context building, tools, policy, IFC, the outbox or the turn journal must keep, or add, property-based tests for these invariants.
- **`@comvivo/core` is pure:** no I/O, no `Date`, no `Math.random`, no `process`, no `node:*` imports. Clock, IDs and RNG are injected.
- **better-sqlite3 transactions never span an `await`.** Use the `db.tx(syncFn)` helper only.
- **Validate every boundary with zod:** config, HTTP, adapters, tool I/O, LLM outputs, JSON columns.
- **TypeScript strict:** no `any` outside tests, exhaustive switches with `never` checks, no floating promises.
- **Logs never contain message or memory content** above `debug`.
- **Dependency boundaries** are enforced by dependency-cruiser (`01` §4 as amended by §14 A11). Never weaken a rule to make an import work; fix the design.
- **Platform rules:** official platform APIs only. Never use unofficial WhatsApp or iMessage clients. No scraping. Zero telemetry.
- **Copy is product.** Bot messages, tool descriptions and the behavior charter live in versioned template files, not inline strings.
- `01-architecture.md` §14 (amendments A1–A32) overrides any older text that conflicts with it.

## 3. Anthropic / model API rules

- **Before writing or changing any code that calls Claude, load the `claude-api` skill** and follow it. Use the official `@anthropic-ai/sdk`. Never guess SDK shapes.
- Default models:
  - chat: `claude-opus-5-5`
  - route, extract, declassify and guard: `claude-haiku-5-5`
  - consolidate: `claude-sonnet-5-5` via the Batches API
- Never send `temperature`, `top_p` or `top_k`. Never use assistant prefill. Never use forced `tool_choice` (`any` or `tool`); use `auto` with `strict: true` tools, or structured outputs (`output_config.format`).
- Opus 5.5 always uses adaptive thinking (it can't be disabled), so control cost with `output_config.effort` and always set it explicitly. Enable the server-side refusal fallback on Opus 5.5 requests.
- Tool loops:
  - Always check `stop_reason`.
  - Append `response.content` unchanged.
  - Return all parallel `tool_result`s in one message.
- Verify prompt caching with `usage.cache_read_input_tokens` in tests.

## 4. Commands

These are created in M0; keep them working.

| Command | Purpose |
|---|---|
| `pnpm install` | install |
| `pnpm verify` | everything CI runs on a PR (lint, typecheck, depcruise, test, build, evals-smoke) |
| `pnpm test` / `pnpm test:watch` | Vitest |
| `pnpm test:prop` | property-based suites (longer runs) |
| `pnpm evals:smoke` | deterministic scenario suite with FakeModelGateway |
| `pnpm evals:live` | live-model evals (spends API budget; stay within the approved budget, §5) |
| `pnpm dev` | server + dashboard in watch mode with the simulator channel |
| `pnpm db:generate` / `pnpm db:migrate` | drizzle-kit |

## 5. Operating mode: autonomous

The project owner has delegated **all decisions** to you. That includes:
- owner decisions D-1 to D-8 in `15` §1, except the money parts;
- spine changes;
- new dependencies;
- naming;
- design and UX;
- scheduling;
- publishing to GitHub, GHCR, npm and the docs site.

**Decide using deep critical thinking and the plan's recommendations, and record every significant decision** with its rationale in `STATUS.md` → "Decisions log". Write an ADR in `docs/adr/` when the decision is architectural. Do not ask the owner to make choices.

**Ask the human ONLY for:**
1. **Money.** Any API spend beyond the approved budget, paid services, domain purchases, paid reviews or subscriptions. Propose a concrete budget with a breakdown once, then operate within it and track spend in `STATUS.md`.
2. **Credentials and account actions only the human can perform.** For example: API keys, creating bots or apps on their accounts, `npm login`, `gh auth login`, 2FA prompts, accepting a GUI license on first launch. Never enter passwords yourself, and never create accounts.
3. **A brief real-chat smoke test** that needs a human account on Telegram, Discord or Slack. Script it so it takes 2 minutes or less.

**How to ask:**
- Batch requests into one clear message: what you need, exact steps, and why.
- Never sit idle while waiting. Continue every unblocked task, and use the simulator, fakes and local services in the meantime.
- Ask again only when a gate is truly blocked.

## 6. Plan maintenance

- The plan is a living document. If implementation proves a spec wrong or incomplete, fix the spec in the same commit as the code and log the change in `STATUS.md` → "Plan changes".
- Never silently diverge from the plan.
- Keep `docs/architecture/<package>.md` notes current for non-trivial modules.
- Re-verify third-party facts (versions, APIs, limits) at implementation time with web search. The plan's facts were checked on 2026-11-01.

## 7. Definition of done (per task)

- The code meets the spec, and the tests the spec lists exist and pass.
- `pnpm verify` is green.
- No new lint suppressions without a justification comment.
- User-visible changes have docs.
- `STATUS.md` is updated.

## 8. Done means done (product quality bar)

- **No half-built work.**
  - No stubs, placeholder implementations, mock data or fake responses in production code paths.
  - No `.skip`/`.todo` tests at a milestone gate.
  - No `TODO`/`FIXME` in production code at 1.0; a CI check enforces this from M14.
  - Every feature must be reachable by real users, through chat, the dashboard or the CLI, and documented.
- **Never fake evidence.**
  - Gate results, benchmarks and test counts are measured, never estimated.
  - If a gate needs something only a human can do (fresh-user dry runs, Raspberry Pi hardware, human annotation, external review), use the strongest automated substitute available. State the substitution explicitly in `STATUS.md` and the docs, and offer the human version as a follow-up.
- **The user experience must impress.**
  - Install to first useful answer in under 5 minutes.
  - Chat replies that are brief, warm, accurate and never spammy.
  - Clear fix-it messages for every error.
  - A polished, accessible, responsive dashboard with dark mode.
  - Fast responses within the performance budgets.
  - Before each release, run a full simulated "week in a family group" plus the persona scenarios, and ask: *would this impress a demanding user?* If not, improve it.

## 9. Long-running work and memory

- `STATUS.md` is your memory. Keep it current enough that a fresh session can resume from it alone.
- Commit and push at least after every task, so nothing is lost if a session ends.
- After a context compaction or in a new session:
  1. Re-read this file, `STATUS.md` and the current milestone section.
  2. Check `git status` and `git log -5`.
  3. Continue exactly where you left off.

## 10. Git, GitHub and publishing

- **Remote:** `origin` = `https://github.com/faizannraza/comvivo.git`.
- **Branching:** use one branch per milestone (`m<n>-<slug>`), with per-task commits.
- **Pull requests:** open a PR with `gh pr create` and a clear description and gate results. Merge with a merge commit only when CI is green.
- **Branch protection:** once CI exists, protect `main` (require the `ci-ok` check).
- **Signing and attribution:** sign off every commit (DCO, `-s`). Keep Claude attribution lines as configured.
- **Publishing order:** releases follow `12` (Changesets, tags, signed images on GHCR, npm with provenance, SBOM). Pre-1.0 releases go out as prereleases; 1.0 is the final release.
- **Never commit secrets.** Use `.env` (gitignored) and the keyfile layout in `08`.
- **Do not post to social platforms** (Hacker News, Reddit, X, Product Hunt) on the owner's behalf. Prepare the launch kit in the repo; posting is the owner's action.
