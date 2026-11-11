/**
 * The deletion primitives (`02` §3.13.3; policy in `03`, erasure defaults in `08` §3.16.2).
 *
 * `02` §3.7.1 puts `deletions: DeletionPrimitives` on the unit of work, beside the repositories
 * and not among them, and the distinction is real: every method here **spans aggregates**. Deleting
 * a memory touches subjects, sources, the FTS index and a decision's back-reference; redacting a
 * message touches its attachments and its derived children. A repository that owns one aggregate
 * cannot hold any of that without reaching into another's tables, which is exactly the coupling the
 * repository split exists to prevent.
 *
 * ## Everything here is chunked, and that is the whole design
 *
 * `02` D18 rejected the one-giant-cascade design: a million-row delete in a single transaction
 * blocks the event loop for seconds and holds the write lock while it does. So each primitive does
 * **bounded** work and reports what is left, and the job that drives it loops with a yield in
 * between (`02` §3.13.2). The consequence a caller has to know about is that a purge is *visible*
 * while it runs — half the rows are gone and half are not — which is why `02` §3.13.4 marks the
 * group `deleting` in the same transaction that enqueues the purge, before any row is touched.
 *
 * ## What a count means
 *
 * Every chunked method returns the number of rows **it** deleted, never the number the cascade
 * removed underneath it. The two differ by orders of magnitude for `messages` (attachments, FTS
 * rows, reactions) and a progress counter that mixed them would be unreadable. The resumption
 * predicate is "did this step delete zero rows", and that only works if the number is the step's
 * own.
 */
import type {
  ConversationId,
  DeletionId,
  GroupId,
  MemberId,
  MemoryId,
  MessageId,
  PersonId,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { AuditActor } from '../../../domain/audit.js';
import type { DeletionProgress } from '../../../domain/deletion.js';
import type { TxToken, WriteResult } from '../uow.js';

/**
 * How many rows one chunk of a sweep or a purge touches.
 *
 * `02` §3.13.2 says 1 000 for the retention sweep and §3.13.4 says 5 000 for a group purge, and
 * the difference is not arbitrary: the sweep runs daily against a database a host is also using,
 * while a purge runs once and wants to finish. Both are exported because a test needs to drive a
 * resumption without seeding five thousand rows.
 */
export const SWEEP_CHUNK_ROWS = 1_000;
export const PURGE_CHUNK_ROWS = 5_000;

/**
 * The tables the retention sweep deletes from (`02` §3.13.2).
 *
 * A closed union rather than a string, so a typo is a compile error and so the set is *countable*:
 * `02` §3.13.1 is the specification of what must be in here, and `retention/rules.ts` is checked
 * against that table as data. Several of §3.13.1's rows name tables a later milestone creates
 * (`sessions`, `domain_events`, `chat_bindings`, the MCP logs); those are listed there with the
 * milestone that adds them, so the list shrinks rather than being quietly incomplete.
 */
export const SWEEPABLE_TABLES = [
  'messages',
  'turn_traces',
  'turn_trace_debug',
  'turns',
  'usage_records',
  'jobs',
  'outbox_messages',
  'memory_ops_applied',
  'forget_source_blocks',
  'audit_events',
] as const;

export type SweepableTable = (typeof SWEEPABLE_TABLES)[number];

/**
 * How long each kind of record is kept.
 *
 * Resolved from the spine configuration before the sweep runs, rather than read inside it: the
 * sweep is driven by a job and a job handler that read configuration per chunk would be a job whose
 * behaviour changes mid-run. `messages` is absent on purpose — its window is stamped into
 * `retention_until` at insert, from the *sender's* consent and the group's constitution (`02`
 * §3.13.1), so the sweep compares a column and never a setting.
 */
export interface RetentionWindows {
  readonly traceDays: number;
  readonly usageDays: number;
  readonly jobSucceededDays: number;
  readonly jobDeadDays: number;
  readonly outboxDays: number;
  readonly outboxDeadDays: number;
  readonly memoryOpsDays: number;
  /** `null` means forever, which is the default (`02` §3.13.1 against `08` §3.16.2). */
  readonly auditDays: number | null;
}

/** What one sweep chunk did. */
export interface SweepChunkResult {
  readonly table: SweepableTable;
  readonly deleted: number;
}

/** A row of the `deletions` table (`02` §3.3.8) — that a deletion happened, and who asked. */
export interface DeletionRecord {
  readonly id: DeletionId;
  readonly scope: 'group' | 'person' | 'member_departure' | 'memory' | 'conversation';
  readonly subjectRef: string;
  readonly groupId: GroupId | undefined;
  readonly requestedBy: AuditActor;
  readonly status: 'pending' | 'running' | 'completed';
  readonly progress: DeletionProgress;
  readonly requestedAt: Temporal.Instant;
  readonly completedAt: Temporal.Instant | undefined;
}

/**
 * Which rows `deleteByLabelOwner` takes (`02` §3.13.3, Q-PRV-3).
 *
 * `02` §3.13.3's `filter` is "e.g. `readers ⊆ {m}`", and that example is the important case: a
 * label owned by the departing member whose *only* reader is that member is private data, while a
 * label they own that the whole group can read is group data they happened to create. `03` decides
 * which applies (`onLeave: keep | delete_private | delete_all`); this is the mechanism.
 */
export type LabelOwnerScope = 'private_only' | 'all';

export interface DeletionPrimitives {
  /**
   * `02` §3.13.2: delete at most `limit` expired rows from one table. Returns how many.
   *
   * Zero means the table is clean, which is how the driving loop knows to move on. The `now` is
   * the transaction's, so every chunk of one pass uses one reading rather than drifting forward
   * while it runs.
   */
  sweepChunk(
    uow: TxToken,
    table: SweepableTable,
    now: Temporal.Instant,
    windows: RetentionWindows,
    limit: number,
  ): number;

  /** Hard-delete a memory item and everything that hangs off it (`02` §3.13.3). */
  deleteMemory(uow: TxToken, groupId: GroupId, id: MemoryId): WriteResult<void>;

  /**
   * Tombstone a message and everything derived from it (`02` §3.13.3).
   *
   * Returns how many rows were stamped: the message itself plus its `derived_from` children, which
   * `02` §3.13.3 requires be redacted too. A transcription of a redacted voice note is the content
   * of that voice note.
   */
  redactMessage(uow: TxToken, groupId: GroupId, id: MessageId): WriteResult<number>;

  /** One chunk of a conversation's deletion. `remaining` is false when the row itself is gone. */
  deleteConversationChunk(
    uow: TxToken,
    groupId: GroupId,
    id: ConversationId,
    limit: number,
  ): { readonly deleted: number; readonly remaining: boolean };

  /**
   * One chunk of `deleteByLabelOwner` (`02` §3.13.3, Q-PRV-3).
   *
   * Walks the labeled tables in a fixed order and deletes from the first that still has rows, so
   * a resumption needs no cursor beyond "run me again".
   */
  deleteByLabelOwnerChunk(
    uow: TxToken,
    groupId: GroupId,
    memberId: MemberId,
    scope: LabelOwnerScope,
    limit: number,
  ): { readonly deleted: number; readonly remaining: boolean };

  /**
   * `02` §3.13.4's first transaction: stop access, then enqueue the purge.
   *
   * One transaction, and the order inside it is the point — the group is marked `deleting` and its
   * partition paused *before* the job exists, so there is no instant in which the purge is running
   * against a group that still answers reads.
   */
  requestGroupPurge(
    uow: TxToken,
    request: { readonly groupId: GroupId; readonly requestedBy: AuditActor },
  ): WriteResult<DeletionRecord>;

  /** `02` §3.13.5's first transaction: the person's own rows, then enqueue the erasure. */
  requestPersonErasure(
    uow: TxToken,
    request: { readonly personId: PersonId; readonly requestedBy: AuditActor },
  ): WriteResult<DeletionRecord>;

  /** The resume point of a running deletion. */
  byId(id: DeletionId): DeletionRecord | undefined;

  /** The oldest deletion of this scope that has not finished, for a handler that lost its payload. */
  oldestUnfinished(scope: DeletionRecord['scope'], subjectRef: string): DeletionRecord | undefined;

  /** Move a deletion's cursor. `status` becomes `running` on the first call. */
  advance(uow: TxToken, id: DeletionId, progress: DeletionProgress): WriteResult<DeletionRecord>;

  /** Mark a deletion finished. Idempotent: a second call on a completed row is a duplicate. */
  complete(uow: TxToken, id: DeletionId, at: Temporal.Instant): WriteResult<DeletionRecord>;
}
