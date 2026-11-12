/**
 * The durable job queue (`02` §3.3.8, §3.10).
 *
 * Everything slow happens here: extraction, embedding, attachment fetches, digests, purges. The
 * table is designed around four claims the queue has to make, each of which is an index.
 *
 * **Claim the next due job** — `jobs_queued_due_idx` on `(run_at, priority)`, partial on
 * `status = 'queued'`. Partial matters more than usual: a healthy instance accumulates thousands of
 * `succeeded` rows, and a non-partial index would make every claim scan them.
 *
 * **Keep serial kinds serial** — `jobs_leased_partition_idx` is partial on
 * `status = 'leased' AND serial = 1`, so "is anything already running for this partition?" is one
 * index probe. Without it, serialising per group would mean a scan of all leased jobs.
 *
 * **Never run the same work twice** — `jobs_idempotency_uq`, unique over non-null keys.
 *
 * **Collapse a burst into one run** — `jobs_debounce_uq` is unique on `debounce_key` *among queued
 * rows only*. That scoping is the whole trick: a new message arriving while an extraction is
 * already queued moves the existing row's `run_at` forward instead of enqueuing a second, and once
 * the job leases, the key is free for the next burst.
 *
 * `attempts` doubles as the **fencing token** (`02` §3.10): a worker that resumes after its lease
 * expired finds the attempt count moved on and knows its lease is stale.
 */
import { ErrorInfoSchema, ScheduleSpecSchema } from '@comvivo/core';
import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { bool, boolCheckSql, createdAt, instantMs, jsonOf, tid, updatedAt } from './_columns.js';

export const jobs = sqliteTable(
  'jobs',
  {
    id: tid('job')('id').primaryKey(),
    /** A `JobKind` registry key, e.g. `extract.conversation`. */
    kind: text('kind').notNull(),
    /** `groupId` or `'_instance'`. Serial kinds run one at a time per partition. */
    partitionKey: text('partition_key').notNull(),
    serial: bool('serial').notNull(),
    /**
     * JSON validated by the kind's own payload schema (`02` §3.10.1), not by this column — the
     * schema is per-kind and known only once the kind is dispatched, so a single `jsonOf` schema
     * could not validate it.
     *
     * `02` §3.3.9 nonetheless gives this column a 64 KiB cap, which `jobs_payload_size_ck` below
     * enforces. That split is the resolution of an inconsistency in the spec: §3.3.8 declares the
     * column as plain `text` while §3.3.9 catalogs it with a cap, and the cap is the half that is
     * kind-independent and that protects the database. Found at `M1-T12`.
     */
    payload: text('payload').notNull(),
    status: text('status', {
      enum: ['queued', 'leased', 'succeeded', 'dead', 'cancelled'],
    }).notNull(),
    /** Higher first, −10..10. */
    priority: integer('priority').notNull().default(0),
    runAt: instantMs('run_at').notNull(),
    idempotencyKey: text('idempotency_key'),
    debounceKey: text('debounce_key'),
    /** The latest a debounced job may be pushed to, so a busy chat still gets extracted. */
    debounceDeadlineAt: instantMs('debounce_deadline_at'),
    /** Also the fencing token: a stale lease holder sees this has moved on. */
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    leaseOwner: text('lease_owner'),
    leaseUntil: instantMs('lease_until'),
    lastError: jsonOf(ErrorInfoSchema, 'jobs.last_error')('last_error'),
    /** `trn_`/`jsch_`/`job_`/`'boot'`/`'cli'` — what caused this job to exist. */
    enqueuedBy: text('enqueued_by'),
    traceId: text('trace_id'),
    createdAt: createdAt(),
    startedAt: instantMs('started_at'),
    finishedAt: instantMs('finished_at'),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    // Q-JOB-1: claim. Partial, so finished jobs are not in the hot index.
    index('jobs_queued_due_idx').on(t.runAt, t.priority).where(sql`${t.status} = 'queued'`),
    // Q-JOB-2: expired leases.
    index('jobs_leased_until_idx').on(t.leaseUntil).where(sql`${t.status} = 'leased'`),
    // Q-JOB-1b: is a serial partition already busy?
    index('jobs_leased_partition_idx')
      .on(t.partitionKey)
      .where(sql`${t.status} = 'leased' AND ${t.serial} = 1`),
    // Q-JOB-3: exactly-once enqueue.
    uniqueIndex('jobs_idempotency_uq')
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    // Q-JOB-4: debounce, scoped to queued rows so the key frees on lease.
    uniqueIndex('jobs_debounce_uq')
      .on(t.debounceKey)
      .where(sql`${t.debounceKey} IS NOT NULL AND ${t.status} = 'queued'`),
    // Q-RET-3: the sweep that removes finished jobs.
    index('jobs_terminal_finished_idx')
      .on(t.status, t.finishedAt)
      .where(sql`${t.status} IN ('succeeded','dead','cancelled')`),
    // Q-JOB-5: purge and cancel by partition.
    index('jobs_partition_status_idx').on(t.partitionKey, t.status),
    // `02` §3.3.9's 64 KiB cap, as a CHECK because the column is not `jsonOf`. `length()` on a
    // text value counts characters, so this is a character bound — stricter than the byte cap for
    // any payload containing non-ASCII, which is the safe direction.
    check('jobs_payload_size_ck', sql`length(${t.payload}) <= 65536`),
    check('jobs_serial_bool_ck', boolCheckSql(t.serial)),
    check('jobs_priority_ck', sql`${t.priority} BETWEEN -10 AND 10`),
    check('jobs_attempts_ck', sql`${t.attempts} >= 0 AND ${t.maxAttempts} >= 1`),
  ],
);

/**
 * Per-partition queue state (`02` §3.3.8).
 *
 * `last_claimed_at` is what makes the queue *fair*: `M1-T23`'s `queue.fairness` test requires that
 * one group's single job starts within two claim rounds despite another group's thousand, which
 * needs least-recently-served ordering rather than pure priority.
 *
 * `paused` stops a partition without touching its jobs — used while a group is being deleted, and
 * by `05`'s budget guard. Cancelling the jobs instead would lose work that should resume.
 */
export const jobPartitions = sqliteTable(
  'job_partitions',
  {
    partitionKey: text('partition_key').primaryKey(),
    lastClaimedAt: instantMs('last_claimed_at').notNull(),
    paused: bool('paused').notNull().default(false),
  },
  (t) => [check('job_partitions_paused_bool_ck', boolCheckSql(t.paused))],
);

/**
 * Recurring job schedules (`02` §3.3.8, §3.10.5).
 *
 * `misfire` is the field that matters after an outage. A missed nightly backup should `run_once`
 * when the machine comes back; a missed morning digest should `skip`, because delivering yesterday
 * morning's brief at 3pm is worse than not delivering it. `misfire_grace_ms` bounds how late
 * `run_once` is still willing to fire.
 *
 * `job_schedules_owner_uq` on `owner_ref` is what stops a duplicate schedule: `'mbr_…:digest.morning'`
 * is unique, so re-running setup cannot give someone two morning briefs.
 */
export const jobSchedules = sqliteTable(
  'job_schedules',
  {
    id: tid('jsch')('id').primaryKey(),
    kind: text('kind').notNull(),
    partitionKey: text('partition_key').notNull(),
    spec: jsonOf(ScheduleSpecSchema, 'job_schedules.spec')('spec').notNull(),
    payload: text('payload').notNull(),
    /** After an outage: fire once, or skip the missed occurrence entirely. */
    misfire: text('misfire', { enum: ['run_once', 'skip'] }).notNull(),
    misfireGraceMs: integer('misfire_grace_ms').notNull(),
    enabled: bool('enabled').notNull().default(true),
    nextRunAt: instantMs('next_run_at'),
    lastFiredAt: instantMs('last_fired_at'),
    /** e.g. `mbr_…:digest.morning`. Unique, so a schedule cannot be created twice. */
    ownerRef: text('owner_ref').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Q-SCH-1: schedules due to fire.
    index('job_schedules_due_idx').on(t.nextRunAt).where(sql`${t.enabled} = 1`),
    uniqueIndex('job_schedules_owner_uq').on(t.ownerRef),
    check('job_schedules_enabled_bool_ck', boolCheckSql(t.enabled)),
    check('job_schedules_grace_ck', sql`${t.misfireGraceMs} >= 0`),
  ],
);
