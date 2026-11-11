/**
 * The scheduler: recurring jobs and their next fire (`02` §3.10.5; ADR-012).
 *
 * ## `TzRef` is resolved at fire time, never stored resolved
 *
 * `02` §3.10.5 gives three references — `{fixed}`, `{member}`, `{group}` — and the last two are
 * resolved as `person.timezone ?? group.timezone` **when the tick runs**. Storing a resolved zone
 * instead would mean a member who moves keeps getting their morning brief at their old local time
 * until somebody noticed, and nobody would: the schedule would look correct in the dashboard.
 *
 * That is also why `recomputeFor` exists. A timezone change has to move every `next_run_at` that
 * points at the thing that changed, **in the same transaction** as the change — otherwise there is
 * a window in which the stored instant and the stored zone disagree, and a tick inside it fires at
 * the old local time.
 *
 * ## Misfire is a product decision, not a retry policy
 *
 * After an outage, `02` §3.10.5 distinguishes `run_once` from `skip`, and the examples say why:
 * a missed nightly backup should run when the machine comes back, and a missed morning digest
 * should **not** — delivering yesterday morning's brief at 3pm is worse than not delivering it.
 * `misfire_grace_ms` bounds how late `run_once` is still willing to fire.
 *
 * ## Catch-up happens at most once
 *
 * `next_run_at = nextFireAfter(spec, max(fire, now − 1 ms), …)`. The `max` is what stops a
 * fortnight's outage from enqueuing a fortnight of digests: the schedule resumes from *now* rather
 * than walking forward through every occurrence it missed.
 */
import type {
  EnqueueResult,
  JobKindDef,
  PartitionKey,
  ScheduleSpec,
  TxToken,
  TzRef,
} from '@comvivo/core';
import {
  type GroupId,
  type JobScheduleId,
  type MemberId,
  nextFireAfter,
  type SchedulePattern,
  UTC,
} from '@comvivo/shared';
import { and, asc, eq, lte } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { exactlyOne, maybeOne } from '../db/drizzle.js';
import { groups, members, persons } from '../schema/index.js';
import { jobSchedules } from '../schema/jobs.js';
import type { SqliteJobQueue } from './queue.js';

/** `02` §3.10.5: how a missed occurrence is treated. */
export const MISFIRE_POLICIES = ['run_once', 'skip'] as const;
export type MisfirePolicy = (typeof MISFIRE_POLICIES)[number];

/** One row of `job_schedules` (`02` §3.3.8). */
export interface JobSchedule {
  readonly id: JobScheduleId;
  readonly kind: string;
  readonly partitionKey: PartitionKey;
  readonly spec: ScheduleSpec;
  readonly payload: string;
  readonly misfire: MisfirePolicy;
  readonly misfireGraceMs: number;
  readonly enabled: boolean;
  readonly nextRunAt: Temporal.Instant | undefined;
  readonly lastFiredAt: Temporal.Instant | undefined;
  /** `'mbr_…:digest.morning'`. Unique, so re-running setup cannot give somebody two briefs. */
  readonly ownerRef: string;
}

export interface NewJobSchedule {
  readonly id: JobScheduleId;
  readonly kind: string;
  readonly partitionKey: PartitionKey;
  readonly spec: ScheduleSpec;
  readonly payload: string;
  readonly misfire: MisfirePolicy;
  readonly misfireGraceMs: number;
  readonly ownerRef: string;
  readonly enabled?: boolean | undefined;
}

/** What one tick did, for the metrics in `02` §3.10.4 and for a test to assert on. */
export interface TickResult {
  readonly fired: readonly { readonly scheduleId: JobScheduleId; readonly job: EnqueueResult }[];
  readonly skipped: readonly JobScheduleId[];
}

export interface SchedulerOptions {
  readonly db: Db;
  /**
   * The queue the tick enqueues through.
   *
   * No `clock` and no `ids`: every write here takes a `TxToken`, whose `now` is the transaction's
   * own reading — so the tick cannot disagree with the rows it writes — and a schedule's id is
   * minted by whoever creates it, because `owner_ref` is what identifies it.
   */
  readonly queue: SqliteJobQueue;
}

/** `02` §3.10.5's tick batch: "ORDER BY next_run_at LIMIT 100". */
const TICK_LIMIT = 100;

export class SqliteScheduler {
  readonly #db: Db;
  readonly #queue: SqliteJobQueue;

  constructor(options: SchedulerOptions) {
    this.#db = options.db;
    this.#queue = options.queue;
  }

  /* ───────────────────────────── Reads ───────────────────────────── */

  schedule(id: JobScheduleId): JobSchedule | undefined {
    const row = maybeOne(this.#db.select().from(jobSchedules).where(eq(jobSchedules.id, id)));
    return row === undefined ? undefined : toSchedule(row);
  }

  byOwner(ownerRef: string): JobSchedule | undefined {
    const row = maybeOne(
      this.#db.select().from(jobSchedules).where(eq(jobSchedules.ownerRef, ownerRef)),
    );
    return row === undefined ? undefined : toSchedule(row);
  }

  /** Q-SCH-1: schedules due to fire, through `job_schedules_due_idx`. */
  due(now: Temporal.Instant, limit = TICK_LIMIT): readonly JobSchedule[] {
    return this.#db
      .select()
      .from(jobSchedules)
      .where(and(eq(jobSchedules.enabled, true), lte(jobSchedules.nextRunAt, now)))
      .orderBy(asc(jobSchedules.nextRunAt))
      .limit(limit)
      .all()
      .map(toSchedule);
  }

  /**
   * The zone a schedule runs in (`02` §3.10.5's `TzRef`).
   *
   * `{member}` resolves as `person.timezone ?? group.timezone` — the person's own, falling back to
   * the group's — because a member who has never set a timezone should get the group's day, not
   * UTC. A missing row falls back to UTC rather than throwing: a schedule whose member has left is
   * a row for the retention sweep to remove, and a tick that threw would stop every *other*
   * schedule in the same batch.
   */
  resolveTz(ref: TzRef): string {
    if ('fixed' in ref) return ref.fixed;
    if ('group' in ref) return this.#groupTz(ref.group) ?? UTC;
    return this.#memberTz(ref.member) ?? UTC;
  }

  /* ───────────────────────────── Writes ───────────────────────────── */

  /**
   * Create or replace a schedule, computing its first `next_run_at`.
   *
   * Keyed on `owner_ref`, which `job_schedules_owner_uq` makes unique: `'mbr_…:digest.morning'`
   * identifies "this member's morning brief", so re-running setup updates the schedule instead of
   * giving somebody two.
   */
  upsert(uow: TxToken, schedule: NewJobSchedule): JobSchedule {
    const tz = tzOf(schedule.spec, (ref) => this.resolveTz(ref));
    const nextRunAt = nextFireAfter(patternOf(schedule.spec), uow.now, tz);
    const row = exactlyOne(
      this.#db
        .insert(jobSchedules)
        .values({
          id: schedule.id,
          kind: schedule.kind,
          partitionKey: schedule.partitionKey,
          spec: schedule.spec,
          payload: schedule.payload,
          misfire: schedule.misfire,
          misfireGraceMs: schedule.misfireGraceMs,
          enabled: schedule.enabled ?? true,
          nextRunAt,
          ownerRef: schedule.ownerRef,
          createdAt: uow.now,
          updatedAt: uow.now,
        })
        .onConflictDoUpdate({
          target: jobSchedules.ownerRef,
          set: {
            kind: schedule.kind,
            partitionKey: schedule.partitionKey,
            spec: schedule.spec,
            payload: schedule.payload,
            misfire: schedule.misfire,
            misfireGraceMs: schedule.misfireGraceMs,
            enabled: schedule.enabled ?? true,
            nextRunAt,
            updatedAt: uow.now,
          },
        })
        .returning(),
      'the schedule',
    );
    return toSchedule(row);
  }

  setEnabled(uow: TxToken, id: JobScheduleId, enabled: boolean): JobSchedule | undefined {
    const row = maybeOne(
      this.#db
        .update(jobSchedules)
        .set({ enabled, updatedAt: uow.now })
        .where(eq(jobSchedules.id, id))
        .returning(),
    );
    return row === undefined ? undefined : toSchedule(row);
  }

  /**
   * `02` §3.10.5: recompute `next_run_at` for every schedule whose `TzRef` points at `ref`.
   *
   * Called **in the same transaction** as the `persons.timezone` or `groups.timezone` write.
   * Outside it there would be a window where the stored instant and the stored zone disagree, and
   * a tick landing in that window fires at the old local time — once, silently, and only for
   * whoever moved.
   *
   * Returns how many moved. Matching is done in TypeScript rather than SQL because the reference
   * is inside a JSON column and a `json_extract` predicate would not use an index anyway; the
   * table holds one row per member-schedule, not per message.
   */
  recomputeFor(uow: TxToken, ref: TzRef): number {
    const rows = this.#db.select().from(jobSchedules).where(eq(jobSchedules.enabled, true)).all();
    let moved = 0;
    for (const row of rows) {
      const schedule = toSchedule(row);
      if (!pointsAt(schedule.spec, ref)) continue;
      const tz = tzOf(schedule.spec, (own) => this.resolveTz(own));
      // From `now`, not from the stored `next_run_at`: the point of the recompute is that the old
      // instant was computed in the wrong zone, so it is not a base to count from.
      const nextRunAt = nextFireAfter(patternOf(schedule.spec), uow.now, tz);
      this.#db
        .update(jobSchedules)
        .set({ nextRunAt, updatedAt: uow.now })
        .where(eq(jobSchedules.id, schedule.id))
        .run();
      moved += 1;
    }
    return moved;
  }

  /**
   * One scheduler tick (`02` §3.10.5).
   *
   * For each due schedule, in one transaction: decide whether the occurrence is too late to fire,
   * enqueue it if not, and advance `next_run_at`. The idempotency key is
   * `'sched:' + id + ':' + fire.epochMs`, so a tick that runs twice — two processes, a retry —
   * enqueues the occurrence once.
   */
  tick(uow: TxToken, defFor: (kind: string) => JobKindDef<unknown> | undefined): TickResult {
    const now = uow.now;
    const fired: { scheduleId: JobScheduleId; job: EnqueueResult }[] = [];
    const skipped: JobScheduleId[] = [];

    for (const schedule of this.due(now)) {
      const fire = schedule.nextRunAt;
      if (fire === undefined) continue;
      const lateBy = now.epochMilliseconds - fire.epochMilliseconds;
      const tooLate = lateBy > schedule.misfireGraceMs;
      // `02` §3.10.5: "If `now − fire > misfire_grace_ms` and `misfire = 'skip'`, do not enqueue."
      // Both halves — a `run_once` schedule fires however late it is, which is what a missed
      // nightly backup needs, and `skip` drops it, which is what a missed morning digest needs.
      if (tooLate && schedule.misfire === 'skip') {
        skipped.push(schedule.id);
      } else {
        const def = defFor(schedule.kind);
        if (def === undefined) {
          // A schedule for a kind nobody registered. Skipped rather than thrown: the tick is a
          // batch, and one unregistered kind must not stop the other ninety-nine schedules.
          skipped.push(schedule.id);
          this.#advance(uow, schedule, fire);
          continue;
        }
        fired.push({
          scheduleId: schedule.id,
          job: this.#queue.enqueue(uow, def, {
            partitionKey: schedule.partitionKey,
            payload: JSON.parse(schedule.payload) as never,
            runAt: now,
            // `02` §3.10.5's key, verbatim. The **fire** instant, not `now`: two ticks a second
            // apart would otherwise mint two keys for one occurrence.
            idempotencyKey: `sched:${schedule.id}:${String(fire.epochMilliseconds)}`,
            enqueuedBy: schedule.id,
          }),
        });
      }
      this.#advance(uow, schedule, fire);
    }
    return { fired, skipped };
  }

  /* ───────────────────────────── Internals ───────────────────────────── */

  /**
   * `next_run_at = nextFireAfter(spec, max(fire, now − 1 ms), …)`; `last_fired_at = fire`.
   *
   * Both halves of that `max` are load-bearing, and I nearly removed the wrong one.
   *
   * **`now − 1 ms`** is `02` §3.10.5's "This catches up at most once": after a fortnight's outage
   * the schedule resumes from now rather than walking forward through every missed occurrence,
   * which would enqueue a fortnight of morning digests and deliver them at once. The millisecond
   * is there because `nextFireAfter` is *strictly* after its argument, so `now` on its own would
   * skip an occurrence falling exactly on it.
   *
   * **`fire`** covers the punctual case, which the millisecond above would otherwise break: when
   * the tick runs in the same millisecond the occurrence is due, `now − 1 ms` is *before* the
   * occurrence we have just fired, so the strict search returns **it again** — and `next_run_at`
   * never advances. The idempotency key stops it running twice, so the symptom would not be
   * duplicate digests but a schedule permanently stuck one occurrence behind, re-enqueuing a
   * duplicate on every tick.
   *
   * Recorded at length because the first version of this comment claimed the `max` was redundant,
   * on the strength of a mutation that changed no test. It changed no test because no test was
   * punctual; the input that reaches it is a clock set exactly to the occurrence, and there is now
   * one.
   */
  #advance(uow: TxToken, schedule: JobSchedule, fire: Temporal.Instant): void {
    const floor = uow.now.subtract({ milliseconds: 1 });
    const base = Temporal.Instant.compare(fire, floor) >= 0 ? fire : floor;
    const tz = tzOf(schedule.spec, (ref) => this.resolveTz(ref));
    this.#db
      .update(jobSchedules)
      .set({
        nextRunAt: nextFireAfter(patternOf(schedule.spec), base, tz),
        lastFiredAt: fire,
        updatedAt: uow.now,
      })
      .where(eq(jobSchedules.id, schedule.id))
      .run();
  }

  #groupTz(groupId: GroupId): string | undefined {
    const row = maybeOne(
      this.#db.select({ timezone: groups.timezone }).from(groups).where(eq(groups.id, groupId)),
    );
    return row?.timezone;
  }

  /** `person.timezone ?? group.timezone`, which is `02` §3.10.5's rule for `{member}`. */
  #memberTz(memberId: MemberId): string | undefined {
    const row = maybeOne(
      this.#db
        .select({ personTz: persons.timezone, groupTz: groups.timezone })
        .from(members)
        .innerJoin(persons, eq(persons.id, members.personId))
        .innerJoin(groups, eq(groups.id, members.groupId))
        .where(eq(members.id, memberId)),
    );
    return row?.personTz ?? row?.groupTz;
  }
}

/** The pattern half of a spec, which is all the evaluator needs. */
function patternOf(spec: ScheduleSpec): SchedulePattern {
  return spec;
}

/** The zone a spec runs in. `interval` has none and never needs one. */
function tzOf(spec: ScheduleSpec, resolve: (ref: TzRef) => string): string {
  return spec.kind === 'interval' ? UTC : resolve(spec.tz);
}

/** Whether a spec's `TzRef` is the one that just changed. */
function pointsAt(spec: ScheduleSpec, ref: TzRef): boolean {
  if (spec.kind === 'interval') return false;
  const own = spec.tz;
  if ('fixed' in ref) return 'fixed' in own && own.fixed === ref.fixed;
  if ('group' in ref) return 'group' in own && own.group === ref.group;
  return 'member' in own && own.member === ref.member;
}

function toSchedule(row: typeof jobSchedules.$inferSelect): JobSchedule {
  return {
    id: row.id,
    kind: row.kind,
    partitionKey: row.partitionKey,
    spec: row.spec,
    payload: row.payload,
    misfire: row.misfire,
    misfireGraceMs: row.misfireGraceMs,
    enabled: row.enabled,
    nextRunAt: row.nextRunAt ?? undefined,
    lastFiredAt: row.lastFiredAt ?? undefined,
    ownerRef: row.ownerRef,
  };
}
