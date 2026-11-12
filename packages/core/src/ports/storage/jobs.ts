/**
 * The durable job queue port (`02` §3.7.1, §3.10; ADR-012).
 *
 * `02` §3.10.2 splits it in two, and the split is the design rather than tidiness:
 *
 *  - **`JobQueueTx`** lives on `UnitOfWork`. Enqueuing is part of the transaction that decided to
 *    enqueue — a job scheduled by a turn that then rolled back must not exist — and `completeIn`
 *    is how a handler's final write and its own completion commit together. Without that, a
 *    handler could do its work and then be retried because the completion failed separately.
 *  - **`JobQueue`** is the worker loop's, outside any transaction: claiming, heartbeating, failing
 *    and recovering are each their own write, and a worker that held a transaction open across a
 *    handler would block every other write for the handler's duration.
 *
 * ## Three guarantees the shapes here exist to make
 *
 * **Exactly-once enqueue** is `idempotency_key UNIQUE` (Q-JOB-3), answered as `duplicate` rather
 * than refused — a retried trigger must be safe.
 *
 * **No double-run** is the lease plus the fencing token. `attempts` is incremented by the claim, so
 * `complete`, `heartbeat` and `fail` all carry it and a worker whose lease expired finds its write
 * matching no row. `02` §3.10.3 calls that `lease_lost`, and the handler's transaction rolls back.
 *
 * **Fairness** is `job_partitions.last_claimed_at`. At most one job per partition per claim round,
 * partitions ordered least-recently-served — so a group with 10 000 backlogged extractions and a
 * group with one job each get a slot per round. `02` §9 pins it as `queue.fairness`.
 */
import type { JobId, z } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { ErrorInfo } from '../../domain/error-info.js';
import type { TxToken } from './uow.js';

/** `02` §3.10.1: `groupId` for a group's work, `'_instance'` for the host's. */
export type PartitionKey = string;

/** `02` §3.3.8's `jobs.status`. */
export const JOB_STATUSES = ['queued', 'leased', 'succeeded', 'dead', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * `01` §8's global concurrency pools.
 *
 * A pool is a *shared budget*, not a per-kind limit: `model` is capped at 4 because that is how
 * many concurrent model calls the instance will make, however many kinds want one. `embed` is 1
 * because the embedder is a single ONNX session.
 */
export const JOB_POOLS = ['model', 'media', 'embed', 'io', 'maintenance'] as const;
export type JobPool = (typeof JOB_POOLS)[number];

/** `01` §8's limits, which the worker loop reads rather than restates. */
export const POOL_LIMITS: Readonly<Record<JobPool, number>> = {
  model: 4,
  media: 2,
  embed: 1,
  io: 8,
  maintenance: 2,
};

/**
 * One kind of job (`02` §3.10.1).
 *
 * The payload **schema** is here and the handler is not: `02` §3.10.1 puts handlers in
 * engine/apps, and a definition carrying one would make the storage layer depend on every
 * subsystem that has work to do. The schema is validated on enqueue **and** on claim, because a
 * row can outlive the code that wrote it — a payload that no longer parses after an upgrade is
 * `JOB_PAYLOAD_INVALID` and goes straight to the dead letter rather than crashing a worker.
 */
export interface JobKindDef<P> {
  readonly kind: string;
  readonly payload: z.ZodType<P>;
  /** True for kinds that mutate group state: at most one leased per partition. */
  readonly serial: boolean;
  /** `04` R11: at most one leased job per `debounce_key`, e.g. `extract.conversation`. */
  readonly singleFlightByKey?: boolean | undefined;
  readonly concurrency: number;
  readonly pool: JobPool;
  /** Default 60 s; a handler needing longer heartbeats. */
  readonly leaseMs: number;
  /** The `AbortSignal` fires at this. `02` §3.10.1: must be ≤ `leaseMs * 0.8`. */
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoff: { readonly baseMs: number; readonly capMs: number };
  /** Higher first, −10..10. `reminder.fire` is 10, `digest.*` 5, maintenance −5. */
  readonly priority: number;
}

/** A job handed to a worker, with the lease it holds (`02` §3.10.3). */
export interface ClaimedJob {
  readonly id: JobId;
  readonly kind: string;
  readonly partitionKey: PartitionKey;
  readonly serial: boolean;
  /** The raw JSON. The worker parses it with the kind's schema (`02` §3.10.4). */
  readonly payload: string;
  readonly priority: number;
  readonly runAt: Temporal.Instant;
  readonly idempotencyKey: string | undefined;
  readonly debounceKey: string | undefined;
  /** The fencing token: every write by this worker carries it. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string;
  readonly leaseUntil: Temporal.Instant;
  readonly enqueuedBy: string | undefined;
  readonly traceId: string | undefined;
  readonly createdAt: Temporal.Instant;
  readonly startedAt: Temporal.Instant;
}

/** A queued or finished job, for the dashboard and `comvivo doctor` (`09`, `11`). */
export interface Job {
  readonly id: JobId;
  readonly kind: string;
  readonly partitionKey: PartitionKey;
  readonly serial: boolean;
  readonly payload: string;
  readonly status: JobStatus;
  readonly priority: number;
  readonly runAt: Temporal.Instant;
  readonly idempotencyKey: string | undefined;
  readonly debounceKey: string | undefined;
  readonly debounceDeadlineAt: Temporal.Instant | undefined;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leaseOwner: string | undefined;
  readonly leaseUntil: Temporal.Instant | undefined;
  readonly lastError: ErrorInfo | undefined;
  readonly enqueuedBy: string | undefined;
  readonly traceId: string | undefined;
  readonly createdAt: Temporal.Instant;
  readonly startedAt: Temporal.Instant | undefined;
  readonly finishedAt: Temporal.Instant | undefined;
  readonly durationMs: number | undefined;
}

/** `02` §3.10.2's enqueue result. `duplicate` names the row already under that key. */
export type EnqueueResult =
  | { readonly kind: 'enqueued'; readonly id: JobId }
  | { readonly kind: 'duplicate'; readonly id: JobId };

/** `02` §3.10.3: a write that found no row because the lease moved on. */
export type LeaseResult = 'ok' | 'lease_lost';

/** `02` §3.10.2: what a failure did with the job. */
export type FailResult = 'requeued' | 'dead' | 'lease_lost';

/** What one claim round asks for (`02` §3.10.3). */
export interface ClaimRequest {
  readonly kinds: readonly string[];
  readonly max: number;
  /**
   * `02` §3.10.3: "`:leaseMs` is bound per claim call."
   *
   * Per call rather than per kind, because the worker loop claims **per pool** and every kind in a
   * pool shares the pool's lease. One statement cannot grant leases of several lengths.
   */
  readonly leaseMs: number;
  /**
   * The kinds with `singleFlightByKey`, so the claim can add `02` §3.10.3's extra exclusion.
   *
   * Passed rather than looked up, because the queue has no registry — the kind's definition lives
   * with its owner (`02` §3.10.1), and the worker is the one holding it. Named explicitly rather
   * than inferred from "has a debounce key": the two coincide today, and a kind that debounced
   * without wanting single-flight would then get it silently.
   */
  readonly singleFlightKinds?: readonly string[] | undefined;
}

export interface EnqueueArgs<P> {
  readonly partitionKey: PartitionKey;
  readonly payload: P;
  readonly runAt?: Temporal.Instant | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly priority?: number | undefined;
  /** `trn_…`, `jsch_…`, `job_…`, `'boot'` or `'cli'` — what caused this job to exist. */
  readonly enqueuedBy?: string | undefined;
  readonly traceId?: string | undefined;
}

export interface DebounceArgs<P> {
  readonly partitionKey: PartitionKey;
  readonly debounceKey: string;
  readonly payload: P;
  /** How long a quiet period ends the debounce (`01` §6.1: 12 messages / 90 s). */
  readonly quietMs: number;
  /** The latest the job may be pushed to, so a busy chat is still processed. */
  readonly maxWaitMs: number;
  /** How a new payload folds into the one already queued. */
  readonly merge: (previous: P, next: P) => P;
  readonly enqueuedBy?: string | undefined;
}

export interface JobQueueTx {
  /**
   * Enqueue a job inside the caller's transaction (`02` §3.10.2).
   *
   * In the transaction because a job scheduled by work that then rolled back must not exist. The
   * `id` is minted here, so a caller cannot hand in one that collides with a live job.
   */
  enqueue<P>(uow: TxToken, def: JobKindDef<P>, args: EnqueueArgs<P>): EnqueueResult;
  /**
   * Enqueue or push forward a debounced job (`02` §3.10.2).
   *
   * `run_at = min(debounce_deadline_at, now + quietMs)` and the payload is merged. The `min` is
   * what stops a continuously busy conversation from never being processed: the deadline is fixed
   * when the first message arrives, and no amount of further activity can push past it.
   */
  enqueueDebounced<P>(uow: TxToken, def: JobKindDef<P>, args: DebounceArgs<P>): EnqueueResult;
  /**
   * Complete a claimed job **inside the handler's own transaction** (`02` §3.10.2).
   *
   * This is what makes a handler's work and its completion atomic. `lease_lost` means the fence
   * matched no row — the lease expired and somebody else owns the attempt — and `02` §3.10.4 says
   * the handler's transaction then rolls back, so the work is not committed under a lease it no
   * longer holds.
   */
  completeIn(
    uow: TxToken,
    job: ClaimedJob,
    result?: { readonly note?: string | undefined },
  ): LeaseResult;
  /** Cancel a partition's queued work, e.g. while a group is being deleted. Returns the count. */
  cancelPartition(uow: TxToken, partitionKey: PartitionKey, kinds?: readonly string[]): number;
}

export interface JobQueue {
  /**
   * Claim up to `max` jobs for this worker (`02` §3.10.3).
   *
   * One statement plus the `job_partitions` upsert, in one `BEGIN IMMEDIATE`. At most one job per
   * partition per round, partitions ordered least-recently-served — which is the fairness `02` §9
   * pins, and the reason a `priority`-only ordering would not do: a group with a thousand
   * high-priority jobs would starve every other group indefinitely.
   */
  claim(workerId: string, request: ClaimRequest): readonly ClaimedJob[];
  /** Extend a lease for a handler still working. Fenced, so a lost lease is reported. */
  heartbeat(job: ClaimedJob, extendMs: number): LeaseResult;
  /** Complete a job outside a transaction, for handlers with no writes of their own. */
  complete(job: ClaimedJob): LeaseResult;
  /**
   * Record a failure: requeued with a backoff, or dead (`02` §3.10.3).
   *
   * `dead` when the error is not retryable or the attempts are spent. A platform `retryAfterMs`
   * overrides the computed backoff when it is longer.
   */
  fail(
    job: ClaimedJob,
    error: ErrorInfo,
    options: { readonly retryable: boolean; readonly retryAfterMs?: number | undefined },
  ): FailResult;
  /**
   * `02` §3.10.3: leases that expired, or that belong to a previous incarnation.
   *
   * Run every 5 s and at boot. The `lease_owner NOT LIKE :bootId` half is what makes the boot case
   * immediate — a restarted process must not wait out its predecessor's leases.
   */
  recoverExpiredLeases(bootId: string): number;
  /** `02` §3.10.3's `retryDead`, from the CLI or the dashboard. `attempts = 0`, `run_at = now`. */
  retryDead(id: JobId): 'requeued' | 'not_found';
  job(id: JobId): Job | undefined;
  /** Jobs in a status, for the dashboard and the observability gauges (`02` §3.10.4). */
  jobsByStatus(status: JobStatus, limit: number): readonly Job[];
  /** `jobs_queued{kind}` and `jobs_due_oldest_age_ms{kind}` (`02` §3.10.4). */
  queueDepth(now: Temporal.Instant): readonly {
    readonly kind: string;
    readonly queued: number;
    readonly oldestDueAgeMs: number;
  }[];
}

/** `02` §3.10.4: a payload that no longer parses is dead, not retried. */
export const JOB_PAYLOAD_INVALID = 'JOB_PAYLOAD_INVALID';

/** `02` §3.10.1: the instance partition, for work that belongs to no group. */
export const INSTANCE_PARTITION: PartitionKey = '_instance';
