# ADR-012 — Background jobs

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A25** (ingestion never downloads attachments inline; it enqueues `attachment.fetch`); related: §14 **A15** (`--role=web|worker|all|drill`)

## Context

- A lot of Village's value happens off the conversation's critical path: memory extraction, embeddings, transcription and vision, reminders, digests, nightly consolidation, retention sweeps, backups, email polling (`01` §6.4; the authoritative catalog is `02` §3.10.1).
- Several of those jobs must be **transactional with domain writes**. A reminder must be marked fired and its outbox row created in **one** transaction, or the member gets it twice (invariant I6). A job that completes must do so in the same transaction as the state it produced.
- Ordering per group is a product requirement: all writes to one group's state happen inside that group's actor, one at a time (`01` §1, §8).
- The deployment target is a self-hosted appliance. Requiring Redis would mean a second container, a second thing to back up and a second thing to fail — for a workload of a few hundred jobs a day.
- **A25:** ingestion has a 20 ms p95 budget, so it records attachment references and enqueues `attachment.fetch` rather than downloading inline.

## Decision

**An in-house durable job queue on SQLite, plus a scheduler loop.**

| Element | Design (`02` §2 D11, D12) |
|---|---|
| Storage | One `jobs` table in the same database as the domain |
| Claim | A single `UPDATE … WHERE id IN (fair selection) RETURNING *` |
| Leases | Carry a fencing `attempts` token, so a resumed worker cannot double-complete |
| Retries | Equal-jitter exponential backoff |
| Idempotency and debounce | Keys enforced by **partial unique indexes** |
| Scheduling | `run_at` for deferral; a `job_schedules` table with cron/daily/weekly specs evaluated by a **pure Temporal-based evaluator** (ADR-011), with a per-fire idempotency key `sched:<id>:<fireEpochMs>` |
| Partitioning | A per-group partition key; `serial` kinds run at most one per partition at a time; partitions are served round-robin by `last_claimed_at` |
| Completion | `completeIn(uow)` — the job completes **inside** the transaction that wrote its result |
| Failure | Dead jobs stay in the table with `status='dead'`; no separate dead-letter store |
| Concurrency caps | Global limits: model calls 4, media jobs 2, embeddings 1 (CPU-bound) (`01` §8) |

## Alternatives considered

| Alternative | Why not |
|---|---|
| **BullMQ / Redis** | Adds a mandatory second service to every install, including the Raspberry Pi and Home Assistant cases. Worse, Redis state cannot participate in a SQLite transaction, so "mark fired and enqueue the message atomically" becomes a two-phase problem and invariant I6 would rest on reconciliation rather than on a commit. |
| **graphile-worker** | Excellent, and Postgres-only. Choosing it would mean choosing Postgres (ADR-005 says no for 1.0) and inheriting an operational dependency the product is designed to avoid. |

## Consequences

**Good**
- Zero extra infrastructure: the queue is backed up, encrypted and restored by the same mechanism as everything else.
- Jobs are transactional with domain writes, which is what makes exactly-once intent (I6) and acknowledged effects (I7) implementable rather than approximate.
- The whole queue is inspectable with SQL and visible in the dashboard, so "why didn't my reminder fire?" is answerable.
- Per-group partitions preserve the actor ordering guarantee into the background layer.

**Bad / accepted costs**
- We own a queue, including its fairness, its backoff and its lease edge cases. It needs property tests and a documented catalog of job kinds.
- Single-writer SQLite means throughput is bounded by one process; a multi-process split must use exactly one worker process in 1.0 (`01` §8).
- Long-running CPU jobs (embeddings, transcription) must be pushed into worker threads or subprocesses to avoid blocking the event loop.
- A poison job stays in the table as `status='dead'` and needs an operator path to retry or discard it.

**Follow-ups**
- `M1-T23` — the durable job queue: kinds registry, debounce, single-flight, leases, retries, worker loop, metrics hooks.
- `M1-T24` — scheduler and the Temporal schedule evaluator.
- `M1-T26` — retention and deletion primitives (`retention.sweep`).
- `M1-T22` — outbox repository and state machine (the transactional send path).

## References
- `docs/plan/01-architecture.md` §2 ADR-012, §6.4, §8, §14 A15, A25
- `docs/plan/02-domain-model-and-storage.md` §2 D11, D12; §3.10.1 (authoritative job catalog)
