/**
 * `DeletionPrimitives` (`02` §3.13.3), and the two transactions that start a purge or an erasure.
 *
 * Everything here is **bounded**. `02` D18 rejected the one-giant-cascade design because a
 * million-row delete in a single transaction blocks the event loop for seconds while holding the
 * write lock, so each primitive does a chunk's worth of work and says what is left. The jobs in
 * `purge-group.ts` and `erase-person.ts` are the loops.
 *
 * ## Why `requestGroupPurge` is here and not in the group repository
 *
 * It writes to eight tables: `groups`, `job_partitions`, `jobs`, `job_schedules`,
 * `outbox_messages`, `deletions`, `audit_events` and `jobs` again to enqueue. A repository that
 * owns one aggregate cannot hold that without reaching into seven others, which is the coupling the
 * repository split exists to prevent — and `02` §3.7.1 puts `deletions` on the unit of work beside
 * the repositories for exactly this reason.
 *
 * The **order** inside that one transaction is the part to read carefully. `02` §3.13.4 lists it,
 * and it is: status first, then the partition pause, then the cancellations, then the job. Every
 * step after the first runs against a group that already answers `not_found`, and the job exists
 * only once nothing can add more work. Reverse any two and there is an instant in which the purge
 * is running against a live group.
 */
import type {
  AuditActor,
  DeletionPrimitives,
  DeletionProgress,
  DeletionRecord,
  LabelOwnerScope,
  RetentionWindows,
  SweepableTable,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { duplicate, notFound, writeOk } from '@comvivo/core';
import {
  type AuditId,
  type ConversationId,
  type DeletionId,
  type GroupId,
  type IdGenerator,
  type MemberId,
  type MemoryId,
  type MessageId,
  type PersonId,
  StorageError,
} from '@comvivo/shared';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import type { Db } from '../db/drizzle.js';
import { maybeOne } from '../db/drizzle.js';
import type { SqliteOutboxRepository } from '../outbox/repository.js';
import type { SqliteJobQueue } from '../queue/queue.js';
import type { SqliteScheduler } from '../queue/scheduler.js';
import type { SqliteAuditLog } from '../repos/audit.js';
import type { SqliteGroupRepository } from '../repos/groups.js';
import type { SqliteMessageRepository } from '../repos/messages.js';
import type { SqliteTraceRepository } from '../repos/traces.js';
import { conversations } from '../schema/groups.js';
import { labels, readerSetMembers, readerSets } from '../schema/ifc.js';
import { memoryItems } from '../schema/memory.js';
import { messageAttachments, messages } from '../schema/messages.js';
import { deletions } from '../schema/system.js';
import { labeledTables } from './inventory.js';
import type { RetentionJobKinds } from './jobs.js';
import { type SweepRule, sweepRules } from './rules.js';

/** `02` §3.10.1: both long deletions run on the `_instance` partition, serially. */
export const INSTANCE_PARTITION = '_instance';

export interface DeletionPrimitivesOptions {
  readonly db: Db;
  readonly connection: Parameters<typeof labeledTables>[0];
  readonly ids: IdGenerator;
  readonly groups: Pick<SqliteGroupRepository, 'byId' | 'setStatus'>;
  readonly messages: Pick<SqliteMessageRepository, 'deleteExpired' | 'tombstone'>;
  readonly traces: Pick<SqliteTraceRepository, 'deleteExpired'>;
  readonly audit: Pick<SqliteAuditLog, 'append' | 'chainKeys' | 'reanchorBefore'>;
  readonly outbox: Pick<SqliteOutboxRepository, 'cancelGroup'>;
  readonly jobs: Pick<SqliteJobQueue, 'enqueue' | 'cancelPartition' | 'setPartitionPaused'>;
  readonly schedules: Pick<SqliteScheduler, 'disablePartition'>;
  /**
   * The registered definitions of the kinds this enqueues.
   *
   * Injected rather than built here, because `JobKindRegistry.register` refuses a second
   * registration of the same kind — so a module that registered its own would make a second
   * `SqliteDeletionPrimitives` on the same registry throw, and the worker loop would be claiming
   * from a registry these defs are not in.
   */
  readonly kinds: RetentionJobKinds;
}

export class SqliteDeletionPrimitives implements DeletionPrimitives {
  readonly #db: Db;
  readonly #options: DeletionPrimitivesOptions;
  readonly #rules: ReadonlyMap<SweepableTable, SweepRule>;
  /**
   * The labeled tables, read once per connection.
   *
   * Introspection is three pragmas per table and the answer cannot change while the process runs —
   * a migration happens at boot, before the store exists. Caching it keeps `deleteByLabelOwner`
   * from paying for the discovery on every chunk of every erasure.
   */
  #labeled: readonly string[] | undefined;

  constructor(options: DeletionPrimitivesOptions) {
    this.#db = options.db;
    this.#options = options;
    this.#rules = new Map(
      sweepRules({
        db: options.db,
        messages: options.messages,
        traces: options.traces,
        audit: options.audit,
        ids: options.ids,
      }).map((rule) => [rule.table, rule]),
    );
  }

  /* ──────────────────────── Retention sweep (§3.13.2) ──────────────────────── */

  sweepChunk(
    uow: TxToken,
    table: SweepableTable,
    now: Temporal.Instant,
    windows: RetentionWindows,
    limit: number,
  ): number {
    const rule = this.#rules.get(table);
    if (rule === undefined) {
      // Unreachable through the port, whose parameter is the closed union these rules are keyed on.
      // Thrown rather than returned, because a missing rule means the two lists disagree and
      // *continuing* would report a swept table as clean.
      throw new StorageError('STORAGE_CONSTRAINT', `no retention rule for ${table}`, {
        hint: 'Add a rule in `retention/rules.ts`. Every member of `SWEEPABLE_TABLES` needs one.',
        category: 'bug',
        detail: { table },
      });
    }
    return rule.sweep(uow, now, windows, limit);
  }

  /* ─────────────────────── Deletion primitives (§3.13.3) ─────────────────────── */

  /**
   * Hard-delete a memory item (`02` §3.13.3).
   *
   * One statement, and everything else is the schema's: `memory_subjects` and `memory_sources`
   * cascade, the FTS and vec0 triggers remove their rows, and `decisions.memory_item_id` is
   * `ON DELETE SET NULL` so a decision outlives the memory that recorded it. Doing any of that here
   * would be a second implementation of a constraint the database already enforces — and the one
   * that drifts.
   *
   * Scoped on `group_id` (`I4`) even though `id` is unique: a primitive that deletes by id alone is
   * a primitive a caller can point at another group's row.
   */
  deleteMemory(_uow: TxToken, groupId: GroupId, id: MemoryId): WriteResult<void> {
    const removed = this.#db
      .delete(memoryItems)
      .where(and(eq(memoryItems.groupId, groupId), eq(memoryItems.id, id)))
      .returning({ rid: memoryItems.rid })
      .all();
    return removed.length === 0 ? notFound() : writeOk(undefined);
  }

  /**
   * Tombstone a message and everything derived from it (`02` §3.13.3).
   *
   * `derived_from` matters and is easy to miss: a transcription of a voice note, or a translation,
   * **is** the content of the message it came from. Redacting the parent and leaving the child is
   * the kind of partial erasure that reads as complete.
   *
   * Attachments are deleted rather than tombstoned, which is what makes the blob unreferenced so
   * `02` §3.11's GC can collect it after the grace period. The row carries no content itself — a
   * mime type and a size — but the file it points at is the content, and keeping the pointer keeps
   * the file.
   *
   * One level of `derived_from`, not a transitive walk: `02` §3.3.3 derives from a *member* message
   * and nothing derives from a derived message, so a recursive CTE would be a loop that always runs
   * once. If that ever changes, this is where it shows.
   */
  redactMessage(uow: TxToken, groupId: GroupId, id: MessageId): WriteResult<number> {
    const head = this.#options.messages.tombstone(uow, groupId, id, 'redaction', uow.now);
    if (head.kind !== 'ok') return head;

    const derived = this.#db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.groupId, groupId), eq(messages.derivedFromMessageId, id)))
      .all();
    let stamped = 1;
    for (const child of derived) {
      const result = this.#options.messages.tombstone(
        uow,
        groupId,
        child.id,
        'redaction',
        uow.now,
      );
      if (result.kind === 'ok') stamped += 1;
    }

    this.#db
      .delete(messageAttachments)
      .where(
        and(
          eq(messageAttachments.groupId, groupId),
          inArray(messageAttachments.messageId, [id, ...derived.map((child) => child.id)]),
        ),
      )
      .run();
    return writeOk(stamped);
  }

  /**
   * One chunk of a conversation's deletion (`02` §3.13.3).
   *
   * Messages first, then the conversation row when none are left. The conversation cannot go first:
   * `messages.conversation_id` cascades, so deleting the parent would take every message in one
   * statement — the exact unbounded delete the chunking exists to avoid, and it would report having
   * deleted one row.
   */
  deleteConversationChunk(
    _uow: TxToken,
    groupId: GroupId,
    id: ConversationId,
    limit: number,
  ): { readonly deleted: number; readonly remaining: boolean } {
    const doomed = this.#db
      .select({ rid: messages.rid })
      .from(messages)
      .where(and(eq(messages.groupId, groupId), eq(messages.conversationId, id)))
      .orderBy(asc(messages.rid))
      .limit(limit)
      .all();
    if (doomed.length > 0) {
      this.#db
        .delete(messages)
        .where(
          inArray(
            messages.rid,
            doomed.map((row) => row.rid),
          ),
        )
        .run();
      return { deleted: doomed.length, remaining: true };
    }
    const removed = this.#db
      .delete(conversations)
      .where(and(eq(conversations.groupId, groupId), eq(conversations.id, id)))
      .returning({ id: conversations.id })
      .all();
    return { deleted: removed.length, remaining: false };
  }

  /**
   * One chunk of `deleteByLabelOwner` (`02` §3.13.3, Q-PRV-3).
   *
   * The labels a member owns are found through `labels_owner_idx`, then every labeled table is
   * asked for rows carrying one. The table list is **introspected** rather than written down
   * (`inventory.ts`), because "all labeled tables" is twenty-six today and a list would be a list
   * of the ones that existed when it was written — and the rows it forgot are private data someone
   * asked to have deleted.
   *
   * `private_only` is `02` §3.13.3's `readers ⊆ {m}` example and is the default `03` applies on a
   * departure: a label the member owns whose reader set names only them is private, while one the
   * whole group can read is group data they happened to create. Deleting the second on a departure
   * would take the shopping list with the person who started it.
   *
   * Deletes from the first table that still has rows and reports `remaining`, so a resumption needs
   * no cursor beyond "run me again": each call strictly reduces the number of matching rows.
   */
  deleteByLabelOwnerChunk(
    _uow: TxToken,
    groupId: GroupId,
    memberId: MemberId,
    scope: LabelOwnerScope,
    limit: number,
  ): { readonly deleted: number; readonly remaining: boolean } {
    const labelIds = this.#ownedLabelIds(groupId, memberId, scope);
    if (labelIds.length === 0) return { deleted: 0, remaining: false };

    for (const table of this.#labeledTables()) {
      const deleted = this.#deleteLabeledChunk(table, labelIds, limit);
      if (deleted > 0) return { deleted, remaining: true };
    }
    return { deleted: 0, remaining: false };
  }

  /* ──────────────────── The two long deletions (§3.13.4, §3.13.5) ──────────────────── */

  requestGroupPurge(
    uow: TxToken,
    request: { readonly groupId: GroupId; readonly requestedBy: AuditActor },
  ): WriteResult<DeletionRecord> {
    const { groupId, requestedBy } = request;
    const group = this.#options.groups.byId(groupId);
    if (group === undefined) return notFound();

    // Already requested. A duplicate rather than a second row: `02` §3.13.4's whole point is that
    // the group stops answering the moment this runs, so a second request has nothing to do — and
    // two `deletions` rows for one group would give the job two cursors.
    const existing = this.oldestUnfinished('group', groupId);
    if (existing !== undefined) return duplicate(existing.id);

    // 1. Access stops. Everything below runs against a group that already reads as `not_found`.
    const marked = this.#options.groups.setStatus(uow, groupId, group.version, 'deleting');
    if (marked.kind !== 'ok') return marked;
    // 2. Nothing new can be claimed, including work enqueued a millisecond from now.
    this.#options.jobs.setPartitionPaused(uow, groupId, true);
    // 3. Clear what is already queued, stop the recurring work, and cancel undelivered sends.
    this.#options.jobs.cancelPartition(uow, groupId);
    this.#options.schedules.disablePartition(uow, groupId);
    this.#options.outbox.cancelGroup(uow, groupId, {
      code: 'GROUP_DELETING',
      message: 'the group is being deleted',
      // Not retryable, and that is the point: `02` §3.9's dispatcher retries anything marked
      // retryable, and a send that came back for a deleted group must never be tried again.
      retryable: false,
      at: uow.now.toString(),
    });

    const record = this.#insertDeletion(uow, {
      scope: 'group',
      subjectRef: groupId,
      groupId,
      requestedBy,
    });
    // The audit row goes on the **instance** chain, not the group's: the group's chain is about to
    // be deleted with the group, and a record that a group was purged has to outlive it (`02`
    // §3.3.7). `groupId` is left out for the same reason — it is a foreign key with a cascade.
    this.#options.audit.append(uow, {
      id: this.#options.ids.next('aud') as AuditId,
      actor: requestedBy,
      action: 'group.purge_requested',
      target: groupId,
      decision: {
        outcome: 'allow',
        reason: null,
        capability: 'group.delete',
        constitutionVersionId: null,
      },
      details: { deletionId: record.id, subjectRef: groupId },
      at: uow.now,
    });
    // 4. Last, so no work exists until nothing can add more.
    this.#options.jobs.enqueue(uow, this.#options.kinds.purge, {
      partitionKey: INSTANCE_PARTITION,
      payload: { deletionId: record.id },
      // One purge per group, forever. A second request finds the `deletions` row above and returns
      // a duplicate, so this key only has to survive the case where that row has been *completed*
      // and the group somehow exists again — which it cannot, because the group id is gone.
      idempotencyKey: `purge:${groupId}`,
      enqueuedBy: 'cli',
      runAt: uow.now,
    });
    return writeOk(record);
  }

  requestPersonErasure(
    uow: TxToken,
    request: { readonly personId: PersonId; readonly requestedBy: AuditActor },
  ): WriteResult<DeletionRecord> {
    const { personId, requestedBy } = request;
    const existing = this.oldestUnfinished('person', personId);
    if (existing !== undefined) return duplicate(existing.id);

    const record = this.#insertDeletion(uow, {
      scope: 'person',
      subjectRef: personId,
      groupId: undefined,
      requestedBy,
    });
    this.#options.audit.append(uow, {
      id: this.#options.ids.next('aud') as AuditId,
      actor: requestedBy,
      action: 'privacy.erase_requested',
      target: personId,
      decision: {
        outcome: 'allow',
        reason: null,
        capability: 'privacy.erase',
        constitutionVersionId: null,
      },
      details: { deletionId: record.id, subjectRef: personId },
      at: uow.now,
    });
    this.#options.jobs.enqueue(uow, this.#options.kinds.erase, {
      partitionKey: INSTANCE_PARTITION,
      payload: { deletionId: record.id },
      idempotencyKey: `erase:${personId}`,
      enqueuedBy: 'cli',
      runAt: uow.now,
    });
    return writeOk(record);
  }

  /* ────────────────────────── The resume point (§3.3.8) ────────────────────────── */

  byId(id: DeletionId): DeletionRecord | undefined {
    const row = maybeOne(this.#db.select().from(deletions).where(eq(deletions.id, id)));
    return row === undefined ? undefined : toDeletionRecord(row);
  }

  oldestUnfinished(
    scope: DeletionRecord['scope'],
    subjectRef: string,
  ): DeletionRecord | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(deletions)
        .where(
          and(
            eq(deletions.scope, scope),
            eq(deletions.subjectRef, subjectRef),
            ne(deletions.status, 'completed'),
          ),
        )
        .orderBy(asc(deletions.requestedAt)),
    );
    return row === undefined ? undefined : toDeletionRecord(row);
  }

  advance(
    _uow: TxToken,
    id: DeletionId,
    progress: DeletionProgress,
  ): WriteResult<DeletionRecord> {
    const row = maybeOne(
      this.#db
        .update(deletions)
        .set({ progress, status: 'running' })
        // `ne(status, 'completed')` is a fence, not a filter: a handler whose lease expired mid-step
        // can wake after the purge finished, and advancing a completed row would reopen it.
        .where(and(eq(deletions.id, id), ne(deletions.status, 'completed')))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toDeletionRecord(row));
  }

  complete(_uow: TxToken, id: DeletionId, at: Temporal.Instant): WriteResult<DeletionRecord> {
    const row = maybeOne(
      this.#db
        .update(deletions)
        .set({ status: 'completed', completedAt: at })
        .where(and(eq(deletions.id, id), ne(deletions.status, 'completed')))
        .returning(),
    );
    if (row !== undefined) return writeOk(toDeletionRecord(row));
    // Already completed is a **duplicate**, not a failure: the job is at-least-once, so finishing
    // twice is the expected shape of a retry after a lost lease.
    return this.byId(id) === undefined ? notFound() : duplicate(id);
  }

  /* ───────────────────────────────── internals ───────────────────────────────── */

  #insertDeletion(
    uow: TxToken,
    record: {
      readonly scope: DeletionRecord['scope'];
      readonly subjectRef: string;
      readonly groupId: GroupId | undefined;
      readonly requestedBy: AuditActor;
    },
  ): DeletionRecord {
    const id = this.#options.ids.next('del') as DeletionId;
    const row = this.#db
      .insert(deletions)
      .values({
        id,
        scope: record.scope,
        subjectRef: record.subjectRef,
        groupId: record.groupId ?? null,
        requestedBy: record.requestedBy,
        status: 'pending',
        progress: { step: 'queued', cursor: null, counts: {} },
        requestedAt: uow.now,
      })
      .returning()
      .all();
    const inserted = row[0];
    if (inserted === undefined) {
      throw new StorageError('STORAGE_CONSTRAINT', 'the deletion record was not written', {
        hint: 'A `RETURNING` clause yielded no row, which means the insert was refused.',
        category: 'bug',
      });
    }
    return toDeletionRecord(inserted);
  }

  #labeledTables(): readonly string[] {
    this.#labeled ??= labeledTables(this.#options.connection);
    return this.#labeled;
  }

  /**
   * The label ids a member owns, narrowed by `scope`.
   *
   * `private_only` adds `02` §3.13.3's `readers ⊆ {m}`: the label's reader set is an explicit
   * `members` set, every seat in it is this member, and there are no other seats. Expressed as "no
   * `reader_set_members` row naming anyone else", which is one anti-join rather than a count
   * comparison — a count would call a set with two seats for the same member private.
   */
  #ownedLabelIds(groupId: GroupId, memberId: MemberId, scope: LabelOwnerScope): readonly number[] {
    const owned = this.#db
      .select({ id: labels.id, readerSetId: labels.readerSetId })
      .from(labels)
      .where(and(eq(labels.groupId, groupId), eq(labels.ownerMemberId, memberId)))
      .all();
    if (scope === 'all') return owned.map((row) => row.id);

    const privateSets = new Set(
      this.#db
        .select({ id: readerSets.id })
        .from(readerSets)
        .where(
          and(
            eq(readerSets.groupId, groupId),
            // A `group` set is everyone, by definition, so it is never private however it is owned.
            eq(readerSets.kind, 'members'),
            sql`NOT EXISTS (
              SELECT 1 FROM ${readerSetMembers} rsm
              WHERE rsm.reader_set_id = ${readerSets.id} AND rsm.member_id <> ${memberId}
            )`,
          ),
        )
        .all()
        .map((row) => row.id),
    );
    return owned.filter((row) => privateSets.has(row.readerSetId)).map((row) => row.id);
  }

  /**
   * Delete up to `limit` rows of one labeled table carrying one of `labelIds`.
   *
   * SQL built from an identifier, which nothing else in this package does, and the two reasons it
   * is safe here are worth stating: the name comes from `sqlite_schema` (it is a table that exists,
   * not caller input) and it goes through drizzle's `sql.identifier`, which quotes it. Every value
   * is still bound. The alternative is a `switch` over twenty-six drizzle table objects — the list
   * this module exists in order not to maintain.
   *
   * **Filtered on `label_id` alone, not on `group_id`.** Two of the labeled tables (`poll_votes`,
   * `proposal_votes`) have no `group_id` column at all, so a group predicate would have to be
   * conditional — and it would add nothing: `labels.id` is instance-wide autoincrement and `I4`
   * (`trg_*_label_group`) refuses a row whose label belongs to another group, so a label id already
   * names exactly one group. The scoping is upstream, in `#ownedLabelIds`.
   */
  #deleteLabeledChunk(table: string, labelIds: readonly number[], limit: number): number {
    const ident = sql.identifier(table);
    const ids = sql.join(
      labelIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const doomed = this.#db.all<{ rid: number }>(
      sql`SELECT rowid AS rid FROM ${ident} WHERE label_id IN (${ids}) LIMIT ${limit}`,
    );
    if (doomed.length === 0) return 0;
    this.#db.run(
      sql`DELETE FROM ${ident} WHERE rowid IN (${sql.join(
        doomed.map((row) => sql`${row.rid}`),
        sql`, `,
      )})`,
    );
    return doomed.length;
  }
}

/** Map a row to the port's shape. */
function toDeletionRecord(row: typeof deletions.$inferSelect): DeletionRecord {
  return {
    id: row.id,
    scope: row.scope,
    subjectRef: row.subjectRef,
    groupId: row.groupId ?? undefined,
    requestedBy: row.requestedBy,
    status: row.status,
    progress: row.progress,
    requestedAt: row.requestedAt,
    completedAt: row.completedAt ?? undefined,
  };
}
