/**
 * Usage records and the daily rollup (`02` §3.7.1, §3.3.7; `01` §8).
 *
 * ## The rollup is in the same transaction as the record
 *
 * `02` §3.3.7 says so at the table, and `05`'s budget guard is why: it runs on **every turn**, so a
 * rollup maintained by a separate job would leave a window in which spend had happened and the
 * guard could not see it — which is how a budget gets blown by a burst rather than by a trend.
 * Writing both here means the guard's reading is never behind the ledger it guards.
 *
 * `M1-T21`'s acceptance criterion is the property that falls out of that: the rollup equals the sum
 * of its records, for any sequence of writes.
 *
 * ## Why `day_local` is supplied rather than derived
 *
 * A daily budget resets when the **group's** day does, not at UTC midnight, so the rollup key is a
 * date in the group's timezone. Deriving it here would mean this module reading group settings and
 * doing timezone arithmetic; `05`'s caller already knows the zone it rendered the turn in. The
 * repository takes the date and the instant, and they are checked against nothing — which is
 * deliberate: a group that changes timezone has days that overlap, and inventing a rule for that
 * here would make the rollup disagree with whatever `05` decides.
 */
import type {
  NewUsageRecord,
  Spend,
  TxToken,
  UsageDailyRow,
  UsageReader,
  UsageRecord,
  UsageRepository,
  WriteResult,
} from '@comvivo/core';
import { duplicate, usageGroupKey, writeOk } from '@comvivo/core';
import type { GroupId, UsageId } from '@comvivo/shared';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { exactlyOne, maybeOne } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import { usageDaily, usageRecords } from '../schema/runtime.js';
import { toUsageDailyRow, toUsageRecord } from './rows.js';

export class SqliteUsageRepository implements UsageReader, UsageRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  byId(id: UsageId): UsageRecord | undefined {
    const row = maybeOne(this.#db.select().from(usageRecords).where(eq(usageRecords.id, id)));
    return row === undefined ? undefined : toUsageRecord(row);
  }

  /** Q-USE-2, through `usage_group_at_idx`. */
  records(query: {
    readonly groupId?: GroupId | undefined;
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
    readonly limit: number;
  }): readonly UsageRecord[] {
    return this.#db
      .select()
      .from(usageRecords)
      .where(
        and(
          // `IS NULL` for the instance's own calls, because `group_id = NULL` matches nothing —
          // the mistake that would make instance-level spend invisible to every report.
          query.groupId === undefined
            ? isNull(usageRecords.groupId)
            : eq(usageRecords.groupId, query.groupId),
          gte(usageRecords.at, query.from),
          lte(usageRecords.at, query.to),
        ),
      )
      .orderBy(desc(usageRecords.at), desc(usageRecords.id))
      .limit(query.limit)
      .all()
      .map(toUsageRecord);
  }

  /**
   * Q-USE-1: what a group has spent across a range of its local days.
   *
   * Summed from the **rollup**, which is the whole reason the rollup exists: the guard runs on
   * every turn, and a scan of `usage_records` would grow without bound over a year. The property
   * test is what makes reading the rollup as safe as reading the records.
   */
  spend(groupKey: string, window: { readonly fromDay: string; readonly toDay: string }): Spend {
    // An aggregate with no `GROUP BY` returns exactly one row, and `coalesce` makes every column
    // a number — so an empty window reads as zeros, which is what `05`'s guard compares on the
    // first turn of every install. `exactlyOne` says that rather than a `?? ZERO` fallback whose
    // branch nothing can reach.
    const row = exactlyOne(
      this.#db
        .select({
          calls: sql<number>`coalesce(sum(${usageDaily.calls}), 0)`,
          costMicros: sql<number>`coalesce(sum(${usageDaily.costMicros}), 0)`,
          inputTokens: sql<number>`coalesce(sum(${usageDaily.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${usageDaily.outputTokens}), 0)`,
          cachedReadTokens: sql<number>`coalesce(sum(${usageDaily.cachedReadTokens}), 0)`,
        })
        .from(usageDaily)
        .where(
          and(
            eq(usageDaily.groupKey, groupKey),
            gte(usageDaily.dayLocal, window.fromDay),
            lte(usageDaily.dayLocal, window.toDay),
          ),
        ),
      'the spend window',
    );
    return row;
  }

  daily(query: {
    readonly groupKey: string;
    readonly fromDay: string;
    readonly toDay: string;
  }): readonly UsageDailyRow[] {
    return this.#db
      .select()
      .from(usageDaily)
      .where(
        and(
          eq(usageDaily.groupKey, query.groupKey),
          gte(usageDaily.dayLocal, query.fromDay),
          lte(usageDaily.dayLocal, query.toDay),
        ),
      )
      .orderBy(asc(usageDaily.dayLocal), asc(usageDaily.route))
      .all()
      .map(toUsageDailyRow);
  }

  /**
   * Record one model call and fold it into the day's rollup.
   *
   * The rollup write is an upsert that **adds** to the existing row rather than replacing it, in
   * SQL: `calls = calls + 1`, and so on. Read-modify-write in TypeScript would be correct inside
   * one transaction and wrong the moment two connections record at once, which `01` §8's worker
   * pools make routine — the model pool alone has four slots.
   */
  record(_uow: TxToken, usage: NewUsageRecord): WriteResult<UsageRecord> {
    try {
      const row = exactlyOne(
        this.#db
          .insert(usageRecords)
          .values({
            id: usage.id,
            groupId: usage.groupId,
            turnId: usage.turnId,
            jobId: usage.jobId,
            route: usage.route,
            provider: usage.provider,
            model: usage.model,
            servedModel: usage.servedModel,
            purpose: usage.purpose,
            via: usage.via,
            effort: usage.effort,
            kind: usage.kind,
            inputTokens: usage.inputTokens,
            cachedReadTokens: usage.cachedReadTokens,
            cacheWrite5mTokens: usage.cacheWrite5mTokens,
            cacheWrite1hTokens: usage.cacheWrite1hTokens,
            outputTokens: usage.outputTokens,
            costMicros: usage.costMicros,
            priceTableVersion: usage.priceTableVersion,
            batch: usage.batch,
            at: usage.at,
          })
          .returning(),
        'the usage record',
      );
      this.#rollUp(usage);
      return writeOk(toUsageRecord(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A retried record must not be counted twice — the rollup is not touched on this path, which
      // is what keeps the property true across retries.
      return duplicate(usage.id);
    }
  }

  /** The same transaction's rollup write. Additive in SQL, never read-modify-write. */
  #rollUp(usage: NewUsageRecord): void {
    const groupKey = usageGroupKey(usage.groupId);
    this.#db
      .insert(usageDaily)
      .values({
        groupKey,
        dayLocal: usage.dayLocal,
        route: usage.route,
        calls: 1,
        costMicros: usage.costMicros,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedReadTokens: usage.cachedReadTokens,
      })
      .onConflictDoUpdate({
        target: [usageDaily.groupKey, usageDaily.dayLocal, usageDaily.route],
        set: {
          calls: sql`${usageDaily.calls} + 1`,
          costMicros: sql`${usageDaily.costMicros} + ${usage.costMicros}`,
          inputTokens: sql`${usageDaily.inputTokens} + ${usage.inputTokens}`,
          outputTokens: sql`${usageDaily.outputTokens} + ${usage.outputTokens}`,
          cachedReadTokens: sql`${usageDaily.cachedReadTokens} + ${usage.cachedReadTokens}`,
        },
      })
      .run();
  }
}
