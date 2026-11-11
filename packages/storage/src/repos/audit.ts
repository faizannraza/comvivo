/**
 * The audit chain (`02` §3.7.1, §3.3.7; `08` T-T02).
 *
 * ## What the chain actually defends against
 *
 * `08` T-T02's threat is "admin erases evidence", and the controls are three, together: the table
 * is append-only (`trg_audit_events_append_only`), there is no delete API, and every row's hash
 * covers the row before it. The third is what makes the first two checkable — without it, a host
 * with filesystem access could rewrite history and nothing would know.
 *
 * `hash = sha256(prevHash ‖ JCS(event without hashes))`, from `02` §3.3.7. Three details in that
 * formula are load-bearing:
 *
 *  - **JCS** (RFC 8785) rather than `JSON.stringify`, because the hash has to be reproducible from
 *    the row as read back. Key order after a round trip through SQLite's JSON is not the order the
 *    writer used, and a verification that depended on it would report tampering on every honest
 *    row.
 *  - **Without the hashes**, or the definition would be circular.
 *  - **`prevHash` first**, so the chain is a chain: altering row *n* changes row *n*'s hash, which
 *    is row *n+1*'s input, and so on to the head.
 *
 * ## Why `seq` and the hashes are computed here
 *
 * All three come from the chain head inside the write transaction. A caller-supplied hash would be
 * derived from whatever that caller had — so a forged row carrying a matching forged hash would
 * verify, which is the one thing a tamper-evident chain exists to prevent. The same argument as a
 * constitution's yaml digest and a message's dedupe key, and here it is the entire point rather
 * than a nicety.
 */
import type {
  AuditEvent,
  AuditLog,
  AuditReader,
  ChainVerification,
  NewAuditEvent,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { chainKeyFor, duplicate, writeOk } from '@comvivo/core';
import { type AuditId, type CanonicalValue, canonicalJson, type GroupId } from '@comvivo/shared';
import { secureEqual, sha256 } from '@comvivo/shared/crypto';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { exactlyOne, maybeOne } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import { auditEvents } from '../schema/runtime.js';
import { toAuditEvent } from './rows.js';

/** `02` §3.3.7: 32 bytes of zeros is the genesis `prev_hash`, for `seq` 1. */
export const GENESIS_HASH: Uint8Array = new Uint8Array(32);

/** `11` §1116: a health check re-hashes the last 10 000 events; `--full` checks all of them. */
export const DEFAULT_VERIFY_LIMIT = 10_000;

/**
 * The hashed form of an event — everything but the hashes themselves.
 *
 * Written out field by field rather than by deleting keys from the row, so that adding a column to
 * `audit_events` is a **compile error here** rather than a silent change of meaning. A new field
 * that quietly joined the digest would make every existing row fail to verify; one that quietly
 * stayed out would be unprotected. Neither is something to discover from a health check.
 */
function hashedForm(event: {
  readonly id: AuditId;
  readonly chainKey: string;
  readonly seq: number;
  readonly groupId: GroupId | null | undefined;
  readonly actor: unknown;
  readonly action: string;
  readonly target: string | null | undefined;
  readonly decision: unknown;
  readonly details: unknown;
  readonly at: Temporal.Instant;
}): CanonicalValue {
  return {
    id: event.id,
    chainKey: event.chainKey,
    seq: event.seq,
    groupId: event.groupId ?? null,
    actor: event.actor as CanonicalValue,
    action: event.action,
    target: event.target ?? null,
    decision: event.decision as CanonicalValue,
    details: event.details as CanonicalValue,
    // Epoch milliseconds, not `toString()`: the column stores an integer, so a round trip through
    // SQLite returns the same number, while an ISO rendering could differ in offset or precision
    // and would then hash differently than it did on the way in.
    at: event.at.epochMilliseconds,
  };
}

/** `02` §3.3.7's formula: `sha256(prevHash ‖ JCS(event without hashes))`. */
export function auditHash(prevHash: Uint8Array, event: Parameters<typeof hashedForm>[0]): Buffer {
  const body = canonicalJson(hashedForm(event));
  return sha256(Buffer.concat([Buffer.from(prevHash), Buffer.from(body, 'utf8')]));
}

export class SqliteAuditLog implements AuditReader, AuditLog {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  event(id: AuditId): AuditEvent | undefined {
    const row = maybeOne(this.#db.select().from(auditEvents).where(eq(auditEvents.id, id)));
    return row === undefined ? undefined : toAuditEvent(row);
  }

  /** Q-DASH-3, through `audit_group_at_idx`. */
  groupEvents(query: {
    readonly groupId: GroupId;
    readonly since?: Temporal.Instant | undefined;
    readonly limit: number;
  }): readonly AuditEvent[] {
    return this.#db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.groupId, query.groupId),
          ...(query.since === undefined ? [] : [gte(auditEvents.at, query.since)]),
        ),
      )
      .orderBy(desc(auditEvents.at), desc(auditEvents.seq))
      .limit(query.limit)
      .all()
      .map(toAuditEvent);
  }

  /** Q-AUD-1, through `audit_chain_seq_uq`: the highest `seq` in this chain. */
  chainHead(chainKey: string): AuditEvent | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.chainKey, chainKey))
        .orderBy(desc(auditEvents.seq)),
    );
    return row === undefined ? undefined : toAuditEvent(row);
  }

  chainKeys(): readonly string[] {
    return this.#db
      .selectDistinct({ chainKey: auditEvents.chainKey })
      .from(auditEvents)
      .orderBy(asc(auditEvents.chainKey))
      .all()
      .map((row) => row.chainKey);
  }

  /**
   * Re-hash a chain and say whether it holds.
   *
   * Three things are checked, and they are not interchangeable:
   *
   *  - **Every row's own hash recomputes.** Catches an edited row.
   *  - **Every `prev_hash` equals the previous row's `hash`.** Catches a row removed or reordered
   *    in the middle: the rows either side no longer link, because the gap's hash is still what the
   *    survivor points at.
   *  - **The chain starts where it says it does**: `seq` 1, carrying the genesis `prev_hash`. This
   *    is the check a link-by-link verification leaves out, and it is the one that catches `08`
   *    T-T02's actual threat — deleting the *oldest* rows leaves a chain that verifies perfectly
   *    from its new first row onwards, because the survivors all link to each other.
   *
   * The start check is skipped when the fetch was truncated by `limit`, because then the rows
   * before the window genuinely exist and were not examined. A bounded verification takes its first
   * row's `prev_hash` on trust and says so by reporting `checked` — it proves nothing was altered
   * *within* the window, which is the question `11` §1116's health check is asking.
   *
   * **A purge therefore has to re-anchor**, and `08` §895 says it does. The mechanism is *not*
   * here: the obvious one — rewrite the surviving first row's `prev_hash` to the genesis value —
   * does not work, because that row's own `hash` covers its `prev_hash`, so the hash changes, so
   * the *next* row's `prev_hash` no longer matches, and the whole surviving chain would have to be
   * rehashed. The alternative is to store the purged-up-to `(seq, hash)` per chain and have this
   * function accept a first row that continues it. Which of those `M1-T26`'s retention sweep wants
   * is its decision, and until it makes one an un-re-anchored purge reads as broken — which is the
   * safe direction: a host is told to look rather than reassured.
   */
  verifyChain(chainKey: string, limit = DEFAULT_VERIFY_LIMIT): ChainVerification {
    const rows = this.#db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.chainKey, chainKey))
      .orderBy(desc(auditEvents.seq))
      .limit(limit)
      .all()
      .reverse();
    const first = rows[0];
    if (first === undefined) return { chainKey, ok: true, checked: 0, brokenAtSeq: undefined };

    const truncated = rows.length === limit;
    if (!truncated && (first.seq !== 1 || !secureEqual(first.prevHash, GENESIS_HASH))) {
      return { chainKey, ok: false, checked: rows.length, brokenAtSeq: first.seq };
    }

    let previous: typeof auditEvents.$inferSelect | undefined;
    for (const row of rows) {
      if (brokenLink(row, previous)) {
        return { chainKey, ok: false, checked: rows.length, brokenAtSeq: row.seq };
      }
      previous = row;
    }
    return { chainKey, ok: true, checked: rows.length, brokenAtSeq: undefined };
  }

  /**
   * Append to the chain, in the caller's transaction.
   *
   * `02` §3.8 puts this in the same transaction as the state change it records, which is what makes
   * the trail an account of what *happened* rather than of what was attempted: a rolled-back effect
   * takes its audit row with it.
   */
  append(_uow: TxToken, event: NewAuditEvent): WriteResult<AuditEvent> {
    const chainKey = chainKeyFor(event.groupId);
    const head = maybeOne(
      this.#db
        .select({ seq: auditEvents.seq, hash: auditEvents.hash })
        .from(auditEvents)
        .where(eq(auditEvents.chainKey, chainKey))
        .orderBy(desc(auditEvents.seq)),
    );
    const seq = (head?.seq ?? 0) + 1;
    const prevHash = head?.hash ?? GENESIS_HASH;
    const body = {
      id: event.id,
      chainKey,
      seq,
      groupId: event.groupId,
      actor: event.actor,
      action: event.action,
      target: event.target,
      decision: event.decision,
      details: event.details,
      at: event.at,
    };
    try {
      const row = exactlyOne(
        this.#db
          .insert(auditEvents)
          .values({
            ...body,
            // Both derived, never supplied. See the module header.
            prevHash: Buffer.from(prevHash),
            hash: auditHash(prevHash, body),
          })
          .returning(),
        'the audit event',
      );
      return writeOk(toAuditEvent(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two appends to the same chain in one transaction cannot collide — they are serialised by
      // the transaction — so a unique violation here is the same `id` twice, which is a retry.
      return duplicate(event.id);
    }
  }
}

/** Whether this row breaks the chain, given the row before it (`undefined` for the first checked). */
function brokenLink(
  row: typeof auditEvents.$inferSelect,
  previous: typeof auditEvents.$inferSelect | undefined,
): boolean {
  if (!secureEqual(auditHash(row.prevHash, row), row.hash)) return true;
  if (previous === undefined) return false;
  // Either of the next two catches a row removed from the middle, and they are kept separate
  // because they report it differently: a gap names the *missing* position, while a `prev_hash`
  // mismatch names the row that no longer links. A host chasing a break wants both.
  if (row.seq !== previous.seq + 1) return true;
  return !secureEqual(row.prevHash, previous.hash);
}
