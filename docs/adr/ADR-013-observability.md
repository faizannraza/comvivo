# ADR-013 — Observability and explainability

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** —

## Context

- Village decides, on its own, whether to speak and what to recall. When it gets that wrong, the member's question is not "what is your p99?" — it is **"why did you say that?"**. Explainability is therefore a product feature with a UI, not an ops concern.
- The same information must *not* become a privacy hole. Logs must never contain message or memory content above `debug`, and debug content logging requires an explicit `VILLAGE_DEBUG_CONTENT=1` plus a visible warning banner (`01` §11.7).
- There is **zero product telemetry** (ADR-017). Nothing is exported off the host unless the host configures an exporter themselves.
- Traces hold the most sensitive derivation of all — what was retrieved, what was considered, what was withheld — so their retention is bounded.

## Decision

| Layer | Choice |
|---|---|
| Logs | **pino** structured logs, through a wrapper with a **typed field allowlist** and a `SecretString` type, so content cannot be logged by accident (`M0-T8`) |
| Metrics and traces | An **optional OpenTelemetry exporter**, off by default, using the **GenAI semantic conventions**. Facades default to no-op so instrumenting code costs nothing when it is disabled (`M0-T9`) |
| Explainability | **`TurnTrace` records in the database**, which power the dashboard's "Why did Village say this?" view |
| Trace content | **Manifests only, never content.** Retention is **30 days** by default, configurable 7–365 via `traces.retentionDays` |
| Model telemetry | Spans and metrics with **no content attributes** (`M2-T15`) |

## Alternatives considered

`01` §2 records **no alternatives** for this ADR: structured logs plus an optional OTel exporter plus in-database traces are additive and mutually independent, and no hosted APM is a candidate because the product has no phone-home (ADR-017). The two genuine choice points were resolved inside the decision above rather than as alternatives:

| Choice point | Resolution |
|---|---|
| Exporter on by default? | **No.** Off by default; the host opts in. Anything else would be telemetry by another name. |
| Content in traces? | **No.** Manifests only, with a bounded default retention (30 days), because a trace store full of message text would be the richest target on the host. `08` asked for 30 days and `11` for 90; 30 days won (`15` §2). |

## Consequences

**Good**
- "Why did Village say this?" is answerable by a member, in the dashboard, without a maintainer and without logs.
- A content leak through logging is prevented structurally by the field allowlist, not by reviewer vigilance.
- Hosts who already run OTel get real spans; hosts who do not pay nothing, because the facades are no-ops.
- Bounded trace retention keeps the most sensitive derived data from accumulating forever.

**Bad / accepted costs**
- Content-free traces are harder to debug from: a maintainer reading a bug report sees structure, not text, and needs the reporter's cooperation (`doctor --bundle`) for anything more.
- `TurnTrace` rows add write volume to every turn and have to be swept.
- The typed-allowlist logger is more friction than `logger.info(obj)`, and every new field has to be declared.
- No telemetry means no aggregate quality signal from the field; `11`'s evals and the dogfooding log have to substitute.

**Follow-ups**
- `M0-T8` — pino wrapper, redaction and `SecretString`.
- `M0-T9` — metrics/tracer facades with no-op defaults and the GenAI semconv constants.
- `M2-T15` — model telemetry with no content attributes.
- `M11` — the observability and quality milestone (`11`) owns the trace UI, the eval metrics and the gates.

## References
- `docs/plan/01-architecture.md` §2 ADR-013, §11.7
- `docs/plan/11-quality-evals-observability.md` §2, §3 (traces, metrics, gates)
- `docs/plan/15-risks-and-open-questions.md` §2 (TurnTrace retention)
