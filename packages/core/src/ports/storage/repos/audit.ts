/**
 * The audit log port (`02` §3.7.1, §3.3.7; `08` T-T02).
 *
 * `02` §4.1 names it `AuditLog` with "`append` in tx, `verifyChain`", and both halves carry a rule:
 *
 *  - **`append` computes `seq`, `prev_hash` and `hash` itself.** All three come from the chain head
 *    inside the write transaction. A caller-supplied hash would be derived from whatever that
 *    caller had, so a forged row with a matching forged hash would verify — which is the one thing
 *    a tamper-evident chain exists to prevent. `08` T-T02's threat is "admin erases evidence", and
 *    the control is that there is no delete API and no way to write a row that hashes correctly
 *    without the row before it.
 *  - **`verifyChain` is bounded by default.** `11` §1116 verifies the last 10 000 events, with
 *    `--full` for all of them: a year of audit rows on a Raspberry Pi is not something a health
 *    check should re-hash on every boot.
 */
import type { AuditId, GroupId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { AuditEvent, ChainVerification, NewAuditEvent } from '../../../runtime/aggregates.js';
import type { TxToken, WriteResult } from '../uow.js';

export interface AuditReader {
  event(id: AuditId): AuditEvent | undefined;
  /** Q-DASH-3: a group's audit trail, newest first. */
  groupEvents(query: {
    readonly groupId: GroupId;
    readonly since?: Temporal.Instant | undefined;
    readonly limit: number;
  }): readonly AuditEvent[];
  /** Q-AUD-1: the chain head, which is what `append` extends. */
  chainHead(chainKey: string): AuditEvent | undefined;
  /**
   * Re-hash a chain and say whether it holds.
   *
   * `limit` bounds how far back it goes (`11` §1116: 10 000 by default, all with `--full`). A
   * bounded verification starts from the oldest row it will check and takes that row's own
   * `prev_hash` on trust, which is the honest reading: it proves nothing was altered *since* that
   * point, which is the question a health check is asking.
   */
  verifyChain(chainKey: string, limit?: number): ChainVerification;
  /** Every chain with at least one event — `09`'s `/instance/audit/verify` iterates these. */
  chainKeys(): readonly string[];
}

export interface AuditLog {
  /**
   * Append an event to its chain, in the caller's transaction.
   *
   * `02` §3.8 puts this in the same transaction as the state change it records, which is what makes
   * the audit trail an account of what *happened* rather than of what was attempted: a rolled-back
   * effect takes its audit row with it.
   */
  append(uow: TxToken, event: NewAuditEvent): WriteResult<AuditEvent>;
}
