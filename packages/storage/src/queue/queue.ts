/**
 * The durable job queue (`02` §3.7.1, §3.10; ADR-012).
 *
 * ## The claim is one statement, and that is the whole concurrency story
 *
 * `02` §3.10.3 writes it out: a single `UPDATE … WHERE id IN (SELECT …) RETURNING *`, inside
 * `BEGIN IMMEDIATE` together with the `job_partitions` upsert. Three things ride on its being one
 * statement rather than a select followed by an update:
 *
 *  - **No double-run.** The rows it returns are the rows it moved, so two workers cannot both
 *    think they claimed the same job.
 *  - **Fairness.** `row_number() OVER (PARTITION BY partition_key …)` takes at most one job per
 *    partition per round, and the outer `ORDER BY` puts least-recently-served partitions first. A
 *    group with 10 000 backlogged extractions and a group with one job each get a slot per round;
 *    a `priority`-only ordering would starve the second group indefinitely. `02` §9's
 *    `queue.fairness` pins it.
 *  - **Serial kinds.** `NOT EXISTS (… status='leased' AND serial=1 …)` keeps at most one leased
 *    serial job per partition, which is what `01` §1's "all writes to one group's state happen
 *    inside that group's actor" needs from the queue.
 *
 * The inner `LIMIT 2000` is `02` §3.10.3's bound on window work: under a huge backlog the fairness
 * becomes approximate rather than the claim becoming slow. Worth knowing it is approximate.
 *
 * ## `attempts` is the fencing token
 *
 * The claim increments it, so it changes exactly when ownership does. Every later write by that
 * worker carries `AND lease_owner = ? AND attempts = ? AND status = 'leased'`, and a write that
 * matches no row is `lease_lost` — which `02` §3.10.4 turns into a rolled-back handler
 * transaction, so work is never committed under a lease its owner no longer holds.
 */
import type {
  ClaimedJob,
  ClaimRequest,
  DebounceArgs,
  EnqueueArgs,
  EnqueueResult,
  ErrorInfo,
  FailResult,
  Job,
  JobKindDef,
  JobQueue,
  JobQueueTx,
  JobStatus,
  LeaseResult,
  PartitionKey,
  TxToken,
} from '@comvivo/core';
import { attemptsExhausted, backoffMs, JOB_BACKOFF } from '@comvivo/core';
import {
  type Clock,
  type IdGenerator,
  type JobId,
  parseOrThrow,
  type Rng,
  StorageError,
} from '@comvivo/shared';
import { and, asc, eq, inArray, lte, type SQL, sql } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { maybeOne } from '../db/drizzle.js';
import { jobPartitions, jobs } from '../schema/jobs.js';
import { assertPartition } from './kinds.js';

/** `02` §3.10.3's bound on the inner selection window. Fairness is approximate past this. */
const CLAIM_WINDOW = 2_000;

export interface JobQueueOptions {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** `02` §3.10.3's injected `rng`, so a backoff is deterministic in a test. */
  readonly rng: Rng;
}

export class SqliteJobQueue implements JobQueueTx, JobQueue {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #rng: Rng;

  constructor(options: JobQueueOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#rng = options.rng;
  }

  /* ───────────────────────── JobQueueTx ───────────────────────── */

  enqueue<P>(uow: TxToken, def: JobKindDef<P>, args: EnqueueArgs<P>): EnqueueResult {
    assertPartition(def, args.partitionKey);
    // Validated on enqueue **and** on claim (`02` §3.10.1). Here, so a caller learns immediately;
    // on claim, because a row can outlive the code that wrote it.
    const payload = parseOrThrow(def.payload, args.payload, `${def.kind} payload`);
    // `02` §3.10.2's SQL is `INSERT … ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT
    // NULL DO NOTHING RETURNING id`, and **drizzle 0.45.4 cannot emit it**: measured, its
    // `onConflictDoNothing({ target, where })` places the predicate *after* `DO NOTHING`, which
    // SQLite rejects as a syntax error, and without the predicate the statement does not match
    // `jobs_idempotency_uq` at all — that index is partial, and SQLite matches an upsert's target
    // against the index including its `WHERE`.
    //
    // So the key is checked first, which is the same shape the outbox's enqueue settled on and has
    // the same justification: both branches are reachable by a test, where a conflict clause's
    // "the row must be there" follow-up has a case nothing can exercise. Safe to look before
    // leaping because `02` §3.7.2 gives the store one write connection and better-sqlite3
    // serialises writes.
    if (args.idempotencyKey !== undefined) {
      const existing = maybeOne(
        this.#db
          .select({ id: jobs.id })
          .from(jobs)
          .where(eq(jobs.idempotencyKey, args.idempotencyKey)),
      );
      // Q-JOB-3, I6: a retried trigger is answered, not refused — and the answer is the id that is
      // **in the table**, because a caller threading a job id through a trace needs the real one.
      if (existing !== undefined) return { kind: 'duplicate', id: existing.id };
    }
    const id = this.#ids.next('job') as JobId;
    const row = maybeOne(
      this.#db
        .insert(jobs)
        .values({
          id,
          kind: def.kind,
          partitionKey: args.partitionKey,
          serial: def.serial,
          payload: JSON.stringify(payload),
          status: 'queued',
          priority: args.priority ?? def.priority,
          runAt: args.runAt ?? uow.now,
          idempotencyKey: args.idempotencyKey,
          maxAttempts: def.maxAttempts,
          enqueuedBy: args.enqueuedBy,
          traceId: args.traceId,
          createdAt: uow.now,
        })
        .returning({ id: jobs.id }),
    );
    if (row === undefined) {
      throw new StorageError('STORAGE_IO', `enqueuing ${def.kind} returned no row`, {
        hint: 'This is a bug: `INSERT … RETURNING` always yields a row when it succeeds.',
        category: 'bug',
      });
    }
    return { kind: 'enqueued', id: row.id };
  }

  /**
   * `02` §3.10.2's debounce.
   *
   * `run_at = min(debounce_deadline_at, now + quietMs)` — and the `min` is the part that matters.
   * The deadline is fixed when the **first** message arrives, so no amount of further activity can
   * push the job past it: a conversation that never goes quiet still gets extracted. Without it,
   * `01` §6.1's "12 messages / 90 s" would be a rule a busy family chat could outrun forever.
   *
   * `02` §3.10.2's threshold case needs no branch here: the caller passes `quietMs = 0`, which
   * makes `now + quietMs` the minimum, so the job runs now.
   */
  enqueueDebounced<P>(uow: TxToken, def: JobKindDef<P>, args: DebounceArgs<P>): EnqueueResult {
    assertPartition(def, args.partitionKey);
    const next = parseOrThrow(def.payload, args.payload, `${def.kind} payload`);
    // Q-JOB-4's unique index is scoped to `status = 'queued'`, so a job already leased frees its
    // key and the next message starts a new debounce window rather than merging into work in
    // flight.
    const queued = maybeOne(
      this.#db
        .select()
        .from(jobs)
        .where(and(eq(jobs.debounceKey, args.debounceKey), eq(jobs.status, 'queued'))),
    );
    if (queued !== undefined) {
      const previous = parseOrThrow(
        def.payload,
        JSON.parse(queued.payload) as unknown,
        `${def.kind} payload`,
      );
      const deadline = queued.debounceDeadlineAt ?? uow.now;
      const quiet = uow.now.add({ milliseconds: args.quietMs });
      this.#db
        .update(jobs)
        .set({
          payload: JSON.stringify(args.merge(previous, next)),
          runAt: Temporal.Instant.compare(deadline, quiet) <= 0 ? deadline : quiet,
        })
        .where(eq(jobs.id, queued.id))
        .run();
      return { kind: 'duplicate', id: queued.id };
    }
    const id = this.#ids.next('job') as JobId;
    const row = maybeOne(
      this.#db
        .insert(jobs)
        .values({
          id,
          kind: def.kind,
          partitionKey: args.partitionKey,
          serial: def.serial,
          payload: JSON.stringify(next),
          status: 'queued',
          priority: def.priority,
          runAt: uow.now.add({ milliseconds: args.quietMs }),
          debounceKey: args.debounceKey,
          debounceDeadlineAt: uow.now.add({ milliseconds: args.maxWaitMs }),
          maxAttempts: def.maxAttempts,
          enqueuedBy: args.enqueuedBy,
          createdAt: uow.now,
        })
        .returning({ id: jobs.id }),
    );
    if (row === undefined) {
      throw new StorageError('STORAGE_IO', `debouncing ${def.kind} returned no row`, {
        hint: 'This is a bug: no row was queued under that debounce key a moment ago.',
        category: 'bug',
      });
    }
    return { kind: 'enqueued', id: row.id };
  }

  /**
   * `02` §3.10.2's `completeIn`: the handler's own transaction commits its work and this.
   *
   * Fenced, and the fence is the reason this exists at all rather than a `complete` the worker
   * calls afterwards. `lease_lost` here means the handler must **not** commit — `02` §3.10.4 says
   * the transaction rolls back — because the work would otherwise land under a lease somebody else
   * now holds, and the other holder would do it again.
   */
  completeIn(
    _uow: TxToken,
    job: ClaimedJob,
    _result?: { readonly note?: string | undefined },
  ): LeaseResult {
    return this.#finish(job, 'succeeded') ? 'ok' : 'lease_lost';
  }

  cancelPartition(_uow: TxToken, partitionKey: PartitionKey, kinds?: readonly string[]): number {
    const rows = this.#db
      .update(jobs)
      .set({ status: 'cancelled', finishedAt: this.#clock.now() })
      .where(
        and(
          eq(jobs.partitionKey, partitionKey),
          // Only queued work. A **leased** job is running right now, and cancelling the row under
          // its handler would make the handler's `completeIn` report `lease_lost` after it had
          // already done the work — so a cancel waits for the lease instead.
          eq(jobs.status, 'queued'),
          ...(kinds === undefined || kinds.length === 0 ? [] : [inArray(jobs.kind, [...kinds])]),
        ),
      )
      .returning({ id: jobs.id })
      .all();
    return rows.length;
  }

  /* ───────────────────────── JobQueue ───────────────────────── */

  claim(workerId: string, request: ClaimRequest): readonly ClaimedJob[] {
    const { kinds, max, leaseMs } = request;
    if (kinds.length === 0 || max <= 0) return [];
    const now = this.#clock.now();
    const nowMs = now.epochMilliseconds;
    const kindList = sql.join(
      kinds.map((kind) => sql`${kind}`),
      sql`, `,
    );
    // `02` §3.10.3: "For kinds with `singleFlightByKey`, the inner selection adds `AND NOT EXISTS
    // (… l.debounce_key = j.debounce_key AND l.status='leased' AND l.lease_until > :now)`."
    //
    // `04` R11 is why: two extractions of one conversation would consolidate the same messages
    // into two different memory sets. The serial flag is not enough — it is per **partition**, and
    // a group has many conversations, so two conversations' extractions can and should run at once.
    const singleFlight = request.singleFlightKinds ?? [];
    const singleFlightClause =
      singleFlight.length === 0
        ? sql``
        : sql` AND (j.debounce_key IS NULL
                    OR j.kind NOT IN (${sql.join(
                      singleFlight.map((kind) => sql`${kind}`),
                      sql`, `,
                    )})
                    OR NOT EXISTS (SELECT 1 FROM ${jobs} l
                                   WHERE l.debounce_key = j.debounce_key
                                     AND l.status = 'leased' AND l.lease_until > ${nowMs}))`;
    // `02` §3.10.3, transcribed. The window subquery, the partition round-robin and the serial
    // exclusion are all in the one statement.
    const rows = this.#db
      .update(jobs)
      .set({
        status: 'leased',
        leaseOwner: workerId,
        leaseUntil: sql`${nowMs} + ${leaseMs}`,
        attempts: sql`${jobs.attempts} + 1`,
        startedAt: now,
      })
      .where(
        sql`${jobs.id} IN (
          SELECT d.id FROM (
            SELECT c.*, row_number() OVER (
              PARTITION BY c.partition_key ORDER BY c.priority DESC, c.run_at, c.id
            ) AS rn
            FROM (SELECT j.id, j.partition_key, j.priority, j.run_at, j.serial
                  FROM ${jobs} j
                  WHERE j.status = 'queued' AND j.run_at <= ${nowMs}
                    AND j.kind IN (${kindList})${singleFlightClause}
                  ORDER BY j.run_at
                  LIMIT ${CLAIM_WINDOW}) c
          ) d
          LEFT JOIN ${jobPartitions} p ON p.partition_key = d.partition_key
          WHERE d.rn = 1 AND coalesce(p.paused, 0) = 0
            AND (d.serial = 0 OR NOT EXISTS (
              SELECT 1 FROM ${jobs} l WHERE l.partition_key = d.partition_key
                AND l.status = 'leased' AND l.serial = 1 AND l.lease_until > ${nowMs}))
          ORDER BY d.priority DESC, coalesce(p.last_claimed_at, 0) ASC, d.run_at ASC
          LIMIT ${max})`,
      )
      .returning()
      .all();

    // `02` §3.10.3's second statement. Without it `last_claimed_at` never moves and the round-robin
    // degenerates to "whichever partition sorts first", which is a starvation bug that looks like
    // fairness in any test with one partition.
    for (const row of rows) {
      this.#db
        .insert(jobPartitions)
        .values({ partitionKey: row.partitionKey, lastClaimedAt: now })
        .onConflictDoUpdate({
          target: jobPartitions.partitionKey,
          set: { lastClaimedAt: now },
        })
        .run();
    }
    return rows.map(toClaimedJob).toSorted((left, right) => right.priority - left.priority);
  }

  heartbeat(job: ClaimedJob, extendMs: number): LeaseResult {
    const row = maybeOne(
      this.#db
        .update(jobs)
        .set({ leaseUntil: this.#clock.now().add({ milliseconds: extendMs }) })
        .where(this.#fence(job))
        .returning({ id: jobs.id }),
    );
    return row === undefined ? 'lease_lost' : 'ok';
  }

  complete(job: ClaimedJob): LeaseResult {
    return this.#finish(job, 'succeeded') ? 'ok' : 'lease_lost';
  }

  fail(
    job: ClaimedJob,
    error: ErrorInfo,
    options: { readonly retryable: boolean; readonly retryAfterMs?: number | undefined },
  ): FailResult {
    const now = this.#clock.now();
    // `02` §3.10.3: dead when the error is not retryable or the attempts are spent. Both halves —
    // a retryable error with no attempts left is still dead, and a permanent one is dead on the
    // first try, because retrying something that cannot succeed is a loop with no exit.
    const dead = !options.retryable || attemptsExhausted(job.attempts, job.maxAttempts);
    if (dead) {
      return this.#finish(job, 'dead', error) ? 'dead' : 'lease_lost';
    }
    const delay = backoffMs(
      job.attempts,
      JOB_BACKOFF,
      // A bound arrow, not `this.#rng.next` — an unbound method reference would lose `this` and
      // any seeded generator's state with it, which is the one thing an injected `rng` is for.
      () => this.#rng.next(),
      options.retryAfterMs,
    );
    const row = maybeOne(
      this.#db
        .update(jobs)
        .set({
          status: 'queued',
          runAt: now.add({ milliseconds: delay }),
          lastError: error,
          leaseOwner: null,
          leaseUntil: null,
          // `started_at` is cleared so `job_wait_ms` measures this attempt's wait rather than the
          // first one's (`02` §3.10.4's histogram).
          startedAt: null,
        })
        .where(this.#fence(job))
        .returning({ id: jobs.id }),
    );
    return row === undefined ? 'lease_lost' : 'requeued';
  }

  /**
   * `02` §3.10.3's expired-lease recovery.
   *
   * Two predicates, because they catch different things: `lease_until < now` is a handler that
   * hung or a machine that paused, and `lease_owner NOT LIKE :bootId || ':%'` is a **restart** —
   * the lease may be minutes from expiring and the process that held it is gone. Without the
   * second, a boot would wait out its predecessor's leases before doing any work.
   */
  recoverExpiredLeases(bootId: string): number {
    const now = this.#clock.now();
    const rows = this.#db
      .update(jobs)
      .set({
        status: 'queued',
        leaseOwner: null,
        leaseUntil: null,
        startedAt: null,
        lastError: {
          code: 'LEASE_EXPIRED',
          message: 'the worker holding this job did not finish it',
          retryable: true,
          at: now.toString(),
        },
      })
      .where(
        and(
          eq(jobs.status, 'leased'),
          sql`(${jobs.leaseUntil} < ${now.epochMilliseconds}
               OR ${jobs.leaseOwner} NOT LIKE ${`${bootId}:%`})`,
        ),
      )
      .returning({ id: jobs.id })
      .all();
    return rows.length;
  }

  retryDead(id: JobId): 'requeued' | 'not_found' {
    const row = maybeOne(
      this.#db
        .update(jobs)
        // `02` §3.10.3: "`retryDead` sets `queued`, `attempts=0`, `run_at=now`". The attempts reset
        // is the point — a host asking for a retry has fixed the cause, and a row that came back
        // with its budget spent would die again on the first hiccup.
        .set({
          status: 'queued',
          attempts: 0,
          runAt: this.#clock.now(),
          leaseOwner: null,
          leaseUntil: null,
          finishedAt: null,
          startedAt: null,
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, 'dead')))
        .returning({ id: jobs.id }),
    );
    return row === undefined ? 'not_found' : 'requeued';
  }

  job(id: JobId): Job | undefined {
    const row = maybeOne(this.#db.select().from(jobs).where(eq(jobs.id, id)));
    return row === undefined ? undefined : toJob(row);
  }

  jobsByStatus(status: JobStatus, limit: number): readonly Job[] {
    return this.#db
      .select()
      .from(jobs)
      .where(eq(jobs.status, status))
      .orderBy(asc(jobs.runAt), asc(jobs.id))
      .limit(limit)
      .all()
      .map(toJob);
  }

  /** `02` §3.10.4's `jobs_queued{kind}` and `jobs_due_oldest_age_ms{kind}` gauges. */
  queueDepth(now: Temporal.Instant): readonly {
    readonly kind: string;
    readonly queued: number;
    readonly oldestDueAgeMs: number;
  }[] {
    return this.#db
      .select({
        kind: jobs.kind,
        queued: sql<number>`count(*)`,
        oldestRunAt: sql<number>`min(${jobs.runAt})`,
      })
      .from(jobs)
      .where(and(eq(jobs.status, 'queued'), lte(jobs.runAt, now)))
      .groupBy(jobs.kind)
      .orderBy(asc(jobs.kind))
      .all()
      .map((row) => ({
        kind: row.kind,
        queued: row.queued,
        // Age of the oldest **due** job, which is the number that says whether the queue is
        // keeping up. A count alone cannot: a thousand jobs due in an hour is healthy.
        oldestDueAgeMs: Math.max(0, now.epochMilliseconds - row.oldestRunAt),
      }));
  }

  /* ───────────────────────── Internals ───────────────────────── */

  /**
   * `02` §3.10.3's fence: `lease_owner = ? AND attempts = ? AND status = 'leased'`.
   *
   * One place, because three methods carry it and three copies would be three chances to drop a
   * clause — and the clause that gets dropped is the one that matters: without `attempts`, a worker
   * whose lease expired and was re-claimed would still complete the job it no longer owns.
   */
  #fence(job: ClaimedJob): SQL {
    const predicate = and(
      eq(jobs.id, job.id),
      eq(jobs.status, 'leased'),
      eq(jobs.leaseOwner, job.leaseOwner),
      eq(jobs.attempts, job.attempts),
    );
    if (predicate === undefined) {
      throw new StorageError('STORAGE_IO', 'the job fence built no predicate', {
        hint: 'This is a bug: `and` over four defined conditions always yields one.',
        category: 'bug',
      });
    }
    return predicate;
  }

  #finish(job: ClaimedJob, status: 'succeeded' | 'dead', error?: ErrorInfo): boolean {
    const now = this.#clock.now();
    const row = maybeOne(
      this.#db
        .update(jobs)
        .set({
          status,
          finishedAt: now,
          lastError: error,
          durationMs: Math.max(0, now.epochMilliseconds - job.startedAt.epochMilliseconds),
          leaseOwner: null,
          leaseUntil: null,
        })
        .where(this.#fence(job))
        .returning({ id: jobs.id }),
    );
    return row !== undefined;
  }
}

/** `02` §3.10.1's default lease, for a pool whose kinds do not raise it. */
export const DEFAULT_CLAIM_LEASE_MS = 60_000;

function toClaimedJob(row: typeof jobs.$inferSelect): ClaimedJob {
  if (row.leaseOwner === null || row.leaseUntil === null || row.startedAt === null) {
    throw new StorageError('STORAGE_IO', 'a claimed job came back without its lease', {
      hint: 'This is a bug: the claim sets `lease_owner`, `lease_until` and `started_at` in the same statement.',
      category: 'bug',
    });
  }
  return {
    id: row.id,
    kind: row.kind,
    partitionKey: row.partitionKey,
    serial: row.serial,
    payload: row.payload,
    priority: row.priority,
    runAt: row.runAt,
    idempotencyKey: row.idempotencyKey ?? undefined,
    debounceKey: row.debounceKey ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    leaseOwner: row.leaseOwner,
    leaseUntil: row.leaseUntil,
    enqueuedBy: row.enqueuedBy ?? undefined,
    traceId: row.traceId ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
  };
}

function toJob(row: typeof jobs.$inferSelect): Job {
  return {
    id: row.id,
    kind: row.kind,
    partitionKey: row.partitionKey,
    serial: row.serial,
    payload: row.payload,
    status: row.status,
    priority: row.priority,
    runAt: row.runAt,
    idempotencyKey: row.idempotencyKey ?? undefined,
    debounceKey: row.debounceKey ?? undefined,
    debounceDeadlineAt: row.debounceDeadlineAt ?? undefined,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseUntil: row.leaseUntil ?? undefined,
    lastError: row.lastError ?? undefined,
    enqueuedBy: row.enqueuedBy ?? undefined,
    traceId: row.traceId ?? undefined,
    createdAt: row.createdAt,
    startedAt: row.startedAt ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
    durationMs: row.durationMs ?? undefined,
  };
}
