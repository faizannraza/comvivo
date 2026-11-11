/**
 * What the retention sweep deletes, and when (`02` §3.13.1, §3.13.2).
 *
 * One rule per sweepable table, in the order the sweep walks them. The order is `02` §3.13.2's,
 * and it is not cosmetic: `messages` comes first because it is the only table whose rows a member
 * can see, and a sweep interrupted after one table has at least honoured the promise the product
 * makes out loud.
 *
 * ## Why the windows are resolved before the sweep starts
 *
 * Every rule takes a `RetentionWindows` rather than reading configuration. A sweep is driven by a
 * job that loops for as long as the tables take, and a handler that re-read its settings per chunk
 * would be a handler whose behaviour changes mid-run — a host editing `privacy.usageRetentionDays`
 * at the wrong moment would get half a pass under each value, with no way to tell afterwards.
 *
 * `messages` is the exception that proves the rule: it has no window here at all, because `02`
 * §3.13.1 stamps `retention_until` **at insert** from the sender's consent and the group's
 * constitution. The sweep compares a column. That is what lets one group keep messages for 90 days
 * and another for 7 without the sweep knowing either number, and it is why shortening a group's
 * retention is a *recompute* job rather than a change the sweep picks up.
 *
 * ## Deletion is never the whole story
 *
 * Each of these deletes a parent row and lets the schema do the rest: `messages` takes its
 * attachments (FK), its FTS rows (trigger) and its reactions, and sets `memory_sources.message_id`
 * to NULL while keeping `source_ref` (`02` §3.13.2). `turns` takes its effects and its trace.
 * That is why a rule's count is its **own** rows — mixing in the cascade would make the progress
 * counter unreadable and the "did this step finish" test wrong.
 */
import type { AuditActor, RetentionWindows, SweepableTable, TxToken } from '@comvivo/core';
import { AUDIT_REANCHOR_ACTION } from '@comvivo/core';
import type { IdGenerator } from '@comvivo/shared';
import { and, eq, inArray, isNotNull, lte, ne, or, type SQL, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import type { SqliteAuditLog } from '../repos/audit.js';
import type { SqliteMessageRepository } from '../repos/messages.js';
import type { SqliteTraceRepository } from '../repos/traces.js';
import { jobs } from '../schema/jobs.js';
import { forgetSourceBlocks, memoryOpsApplied } from '../schema/memory.js';
import { outboxMessages, turns, turnTraceDebug, usageRecords } from '../schema/runtime.js';

/** `02` §3.13.1's "`memory_ops_applied` | 30 days". Not configurable: it is pure idempotency state. */
export const MEMORY_OPS_RETENTION_DAYS = 30;

/**
 * The actor a sweep writes its re-anchor events as.
 *
 * **Annotated**, not inferred. The first draft was
 * `{ kind: 'system', detail: 'retention.sweep' } as const`, which typechecks everywhere it is
 * passed — excess-property checking only fires on a direct object literal, never on a variable —
 * and would have been rejected by `AuditActorSchema` at the first write. `02` §3.3.6 has no
 * `detail`: a system action has nobody to attribute it to, which is the arm's whole meaning.
 */
export const RETENTION_ACTOR: AuditActor = { kind: 'system' };

export interface SweepRule {
  readonly table: SweepableTable;
  /**
   * The `02` §3.13.1 row this implements, verbatim enough to find.
   *
   * Carried in the rule rather than in a comment because `rules.spec.test.ts` reads §3.13.1 out of
   * the plan and matches on it: a row added to the spec table fails the test until a rule names it.
   */
  readonly spec: string;
  /** Delete at most `limit` expired rows. Returns how many — its own, never the cascade's. */
  readonly sweep: (
    uow: TxToken,
    now: Temporal.Instant,
    windows: RetentionWindows,
    limit: number,
  ) => number;
}

export interface SweepDeps {
  readonly db: Db;
  readonly messages: Pick<SqliteMessageRepository, 'deleteExpired'>;
  readonly traces: Pick<SqliteTraceRepository, 'deleteExpired'>;
  readonly audit: Pick<SqliteAuditLog, 'chainKeys' | 'reanchorBefore'>;
  readonly ids: IdGenerator;
}

/**
 * Delete at most `limit` rows matching `where`, newest-last, and say how many.
 *
 * By `rowid`, because four of these tables have a composite primary key and two have no natural
 * ordering column — and because SQLite's `DELETE` has no `LIMIT` in a default build, so the rows
 * have to be selected first anyway. `limit` then means what it says, which is the entire point of
 * a chunked sweep: an unbounded `DELETE` holds the write lock for as long as it takes.
 */
function deleteChunk(db: Db, table: SQLiteTable, where: SQL | undefined, limit: number): number {
  const doomed = db
    .select({ rowid: sql<number>`rowid` })
    .from(table)
    .where(where)
    .limit(limit)
    .all();
  if (doomed.length === 0) return 0;
  db.delete(table)
    .where(
      inArray(
        sql`rowid`,
        doomed.map((row) => row.rowid),
      ),
    )
    .run();
  return doomed.length;
}

/** `now` minus `days`, as the cutoff a row must be older than. */
function cutoff(now: Temporal.Instant, days: number): Temporal.Instant {
  return now.subtract({ hours: days * 24 });
}

/**
 * Every rule, in sweep order.
 *
 * A function rather than a constant because three of the rules delegate to a repository: `messages`
 * and `turn_traces` have owned their own retention predicate since `M1-T17` and `M1-T21`, and a
 * second copy here would be a second place to get `retention_until` wrong. `audit_events` delegates
 * for a stronger reason — its deletion has to re-anchor the hash chain, which only the audit log
 * can do.
 */
export function sweepRules(deps: SweepDeps): readonly SweepRule[] {
  const { db } = deps;
  return [
    {
      table: 'messages',
      spec: 'Raw messages (+ attachments, FTS rows)',
      // No window: `retention_until` was stamped at insert from the sender's consent and the
      // group's constitution, which is also how `02` §3.13.1's `consent.memoryOffRawRetentionDays`
      // row is honoured without the sweep knowing it exists.
      sweep: (uow, now, _windows, limit) => deps.messages.deleteExpired(uow, undefined, now, limit),
    },
    {
      table: 'turn_traces',
      spec: 'Turn traces (manifests only, never content)',
      sweep: (uow, now, _windows, limit) => deps.traces.deleteExpired(uow, now, limit),
    },
    {
      table: 'turn_trace_debug',
      spec: '`turn_trace_debug`',
      // `expires_at` rather than a window, because `11` §3.10.4 makes this row's lifetime 24 hours
      // by default and 1–30 days when captured model I/O is on — a per-row decision taken by
      // whoever wrote it, under the configuration in force *then*.
      sweep: (_uow, now, _windows, limit) =>
        deleteChunk(db, turnTraceDebug, lte(turnTraceDebug.expiresAt, now), limit),
    },
    {
      table: 'turns',
      spec: 'Turns + effects',
      sweep: (_uow, now, windows, limit) =>
        deleteChunk(
          db,
          turns,
          and(
            // Terminal only. A `queued` or `running` turn has no business being swept whatever its
            // age — if one is older than the retention window, recovery is broken and deleting the
            // evidence is the wrong response.
            ne(turns.status, 'queued'),
            ne(turns.status, 'running'),
            // `completed_at` is null for a turn that timed out or was cancelled, so the fallbacks
            // are in priority order and `deadline_at` is the last: it is always set and is at most
            // 180 s after the start (`05` §3), so it dates a terminal turn to within three minutes
            // either way — which a 30-day window does not care about, and which is strictly better
            // than a `NULL` that would make the row immortal.
            lte(
              sql`coalesce(${turns.completedAt}, ${turns.timedOutAt}, ${turns.deadlineAt})`,
              cutoff(now, windows.traceDays).epochMilliseconds,
            ),
          ),
          limit,
        ),
    },
    {
      table: 'usage_records',
      spec: 'Usage records',
      // `usage_daily` is not swept: `02` §3.13.1 keeps it forever because it holds counts and no
      // `turn_id`, so it survives the detail it was rolled up from.
      sweep: (_uow, now, windows, limit) =>
        deleteChunk(db, usageRecords, lte(usageRecords.at, cutoff(now, windows.usageDays)), limit),
    },
    {
      table: 'jobs',
      spec: 'Jobs',
      // Q-RET-3, through `jobs_terminal_finished_idx`. Two windows in one rule rather than two
      // rules, because the index is on `(status, finished_at)` and a single `OR` over the two
      // status groups is one index scan per group rather than two passes over the table.
      sweep: (_uow, now, windows, limit) =>
        deleteChunk(
          db,
          jobs,
          and(
            isNotNull(jobs.finishedAt),
            or(
              and(
                inArray(jobs.status, ['succeeded', 'cancelled']),
                lte(jobs.finishedAt, cutoff(now, windows.jobSucceededDays)),
              ),
              and(eq(jobs.status, 'dead'), lte(jobs.finishedAt, cutoff(now, windows.jobDeadDays))),
            ),
          ),
          limit,
        ),
    },
    {
      table: 'outbox_messages',
      spec: 'Outbox',
      sweep: (_uow, now, windows, limit) =>
        deleteChunk(
          db,
          outboxMessages,
          or(
            and(
              // `expired` joins `sent` and `cancelled` on the short window: an `expiry_class` that
              // refused delivery is a decision already taken, and `02` §3.9 keeps nothing from it
              // that a dead letter would not keep better.
              inArray(outboxMessages.status, ['sent', 'cancelled', 'expired']),
              // `sent_at` is null for a row that was cancelled before it was ever sent, which is
              // most of them — so `created_at` is the fallback rather than the exception.
              lte(
                sql`coalesce(${outboxMessages.sentAt}, ${outboxMessages.createdAt})`,
                cutoff(now, windows.outboxDays).epochMilliseconds,
              ),
            ),
            and(
              // 90 days, six times longer: a dead send is the record of a message the group was
              // promised and never received, and it is the first thing a host looks for.
              eq(outboxMessages.status, 'dead'),
              lte(outboxMessages.createdAt, cutoff(now, windows.outboxDeadDays)),
            ),
          ),
          limit,
        ),
    },
    {
      table: 'memory_ops_applied',
      spec: '`memory_ops_applied`',
      sweep: (_uow, now, windows, limit) =>
        deleteChunk(
          db,
          memoryOpsApplied,
          lte(memoryOpsApplied.appliedAt, cutoff(now, windows.memoryOpsDays)),
          limit,
        ),
    },
    {
      table: 'forget_source_blocks',
      spec: '`forget_source_blocks`',
      // `04` R9: the block expires with the message it suppresses, so the suppression cannot
      // outlive its reason. The column already says when, which is the whole design.
      sweep: (_uow, now, _windows, limit) =>
        deleteChunk(db, forgetSourceBlocks, lte(forgetSourceBlocks.expiresAt, now), limit),
    },
    {
      table: 'audit_events',
      spec: 'Audit events',
      sweep: (uow, now, windows, limit) => sweepAuditChains(deps, uow, now, windows, limit),
    },
  ];
}

/**
 * The audit sweep: nothing at all unless a host set a ceiling (`02` §3.13.1 against `08` §3.16.2).
 *
 * `02` §3.13.1 keeps audit events forever and `08` §3.16.2 offers one year with the chain
 * re-anchored; the default resolves to `02`'s, because an audit row holds ids, enums and counts and
 * never content — it is what *remains* after an erasure precisely because there is nothing personal
 * in it, so deleting it by default trades accountability for no privacy at all.
 *
 * One chain per chunk, and the chain with the oldest removable row first. A re-anchor event is one
 * row and it is written per call, so sweeping every chain in one chunk would write a dozen rows to
 * delete a thousand — and the chunk's job is to be bounded, not to be thorough.
 */
function sweepAuditChains(
  deps: SweepDeps,
  uow: TxToken,
  now: Temporal.Instant,
  windows: RetentionWindows,
  limit: number,
): number {
  if (windows.auditDays === null) return 0;
  const before = cutoff(now, windows.auditDays);
  for (const chainKey of deps.audit.chainKeys()) {
    const removed = deps.audit.reanchorBefore(uow, {
      chainKey,
      before,
      limit,
      id: deps.ids.next('aud'),
      actor: RETENTION_ACTOR,
      at: now,
    });
    // The first chain with anything to remove is the whole chunk. The next pass picks up where
    // this left off, because the rows it did not take are still older than `before`.
    if (removed > 0) return removed;
  }
  return 0;
}

/** Re-exported so the sweep can keep the one action name it must never delete. */
export { AUDIT_REANCHOR_ACTION };
