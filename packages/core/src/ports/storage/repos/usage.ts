/**
 * The usage port (`02` §3.7.1, §3.3.7; `01` §8).
 *
 * `02` §4.1 names it `UsageRepository` with "`record` + rollup, `spend(groupKey, window)`". The
 * rollup is in the **same transaction** as the record, and that is the whole design: `05`'s budget
 * guard runs on every turn, so a separate rollup job would leave a window in which spend had
 * happened and the guard could not see it — which is how a budget gets exceeded by a burst.
 * `M1-T21` asserts as a property that the rollup equals the sum of its records.
 */
import type { GroupId, UsageId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { NewUsageRecord, UsageDailyRow, UsageRecord } from '../../../runtime/aggregates.js';
import type { TxToken, WriteResult } from '../uow.js';

/** What a window of spend came to (`01` §8's cost guard). */
export interface Spend {
  readonly calls: number;
  readonly costMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens: number;
}

export interface UsageReader {
  /**
   * One record by id.
   *
   * Named `byId` like every other reader in `02` §3.7.1, and **not** `record`: `02` §4.1 names the
   * writer `record`, and one class implements both halves of an aggregate (the two share prepared
   * statements, and a reader that could not see a write made earlier in the same transaction would
   * be its own kind of bug). Two methods called `record` with different arities on one class is not
   * expressible, and a method whose meaning depended on how many arguments it got would be a trap
   * for every caller. Found while implementing `M1-T21`.
   */
  byId(id: UsageId): UsageRecord | undefined;
  /** Q-USE-2: the cost report's rows for a window. */
  records(query: {
    readonly groupId?: GroupId | undefined;
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
    readonly limit: number;
  }): readonly UsageRecord[];
  /**
   * Q-USE-1: what a group has spent over a range of its **local** days.
   *
   * Read from the rollup rather than summed from the records, because that is what the rollup is
   * for — the guard runs on every turn and a scan of `usage_records` would grow without bound. The
   * property test is what lets this be trusted: the two must agree.
   */
  spend(groupKey: string, window: { readonly fromDay: string; readonly toDay: string }): Spend;
  /** The rollup rows themselves, for the dashboard's per-route breakdown. */
  daily(query: {
    readonly groupKey: string;
    readonly fromDay: string;
    readonly toDay: string;
  }): readonly UsageDailyRow[];
}

export interface UsageRepository {
  /** Record one model call and fold it into the day's rollup, in one transaction. */
  record(uow: TxToken, usage: NewUsageRecord): WriteResult<UsageRecord>;
}
