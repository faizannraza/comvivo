# ADR-017 — Telemetry

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** scope clarified by §14 **A21** / **ADR-022** (docs-site analytics are *not* product telemetry; product telemetry stays at zero)

## Context

- The product's proposition is that a group's private life stays on hardware the group controls. An instance holds family messages, private memories, children's conversations and a labelled map of who may know what.
- Any outbound connection that the host did not configure is, from the user's side, indistinguishable from exfiltration — and it would be the first thing a skeptical reader of the README looks for.
- A known risk is that members misunderstand who can see what (`15` §3 R-16). Adding a phone-home would make an honest answer to "does it send anything?" impossible to give in one sentence.
- Maintainers still need *some* signal about whether the project is working, and there are honest sources for that: GitHub's own APIs, npm download counts, and traffic on our own website (ADR-022).

## Decision

**No telemetry. None.**

| Item | Decision |
|---|---|
| Analytics in the product | **None** |
| Phone-home | **None** |
| Crash reporting | **None** by default — diagnostics are produced locally (`doctor --bundle`, content-free traces) and shared by the host if they choose |
| Update check | **Opt-in**, off by default. When enabled it performs a single `GET` of a **static** `release-manifest.json` with a generic User-Agent and **no identifiers**, and never auto-updates |
| Update-check counting | The manifest is hosted on the main repo's **GitHub Pages**, where maintainers have **no access to request logs or counts** — so update checks cannot be counted even by accident. It is never served from the docs site |
| Observability | Local only: structured logs and in-database `TurnTrace` records; an OpenTelemetry exporter exists but is **off by default** and points wherever the host configures (ADR-013) |

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Opt-in analytics** | Tempting, and still wrong here. Even opt-in requires a prompt that asks a family to share something about their private instance, which spends trust at the exact moment the product is trying to earn it; it adds an egress path and a consent-state machine to maintain; and an opt-in sample from self-hosters is biased enough that the data would not be worth acting on. The honest substitutes — GitHub metrics, npm downloads, docs traffic, voluntary reports — cover the maintainer need. |

## Consequences

**Good**
- "Does it send anything?" has a one-word answer, which is the single most valuable sentence in the README (`15` §3 R-16).
- There is no analytics pipeline to secure, no identifier to accidentally make stable, and no consent state to get wrong.
- The architecture gets a useful forcing function: diagnostics have to be good enough locally, because there is no remote fallback.

**Bad / accepted costs**
- No usage data: adoption, retention, which features are used and where installs fail are all invisible. The substitutes are deliberately weaker — the dogfooding log, beta hosts, GitHub metrics, docs funnel, and voluntary reports.
- Install failures at scale are discovered from issues, not dashboards, which is one reason the launch plan staffs a 72-hour response rota (`15` §3 R-15).
- Hosting the update manifest on GitHub Pages is a deliberate capability sacrifice: we could not count update checks later even if we wanted to.
- Quality has to be proven by evals and red-team suites rather than by field metrics (`11`).

**Follow-ups**
- `M0-T9` — observability facades with no-op defaults (nothing exported unless configured).
- `M14` — the update-check implementation, off by default, and the release manifest on GitHub Pages (`12` §2 P18).
- ADR-022 — docs-site analytics, which are explicitly outside this ADR's scope and do not change it.

## References
- `docs/plan/01-architecture.md` §2 ADR-017, §14 A21
- `docs/plan/12-packaging-release-ops.md` §2 P18; §3.1 (release manifest on GitHub Pages)
- `docs/plan/13-docs-launch-community.md` §3.G (metrics without telemetry)
- `docs/plan/15-risks-and-open-questions.md` §3 R-15, R-16
