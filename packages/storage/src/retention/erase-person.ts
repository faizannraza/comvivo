/**
 * `privacy.erase_person` — the right to be forgotten (`02` §3.13.5).
 *
 * §3.13.5 numbers nine steps and says the mechanics are what `03` parameterises. The two policy
 * choices are in `ErasePolicy` below; everything else here is the mechanism, and it is written as a
 * list of small, named, **idempotent** steps because that is what makes it resumable: `02` D18 puts
 * the cursor in `deletions.progress`, a crash restarts the step it names, and a step that is safe
 * to run twice needs no cursor finer than its own name.
 *
 * ## Why step 1 is one transaction and the rest are not
 *
 * Step 1 is the part that has to be atomic: the person is marked erased, every membership becomes
 * `left`, their channel identities go, their schedules go, and their undelivered DMs are cancelled.
 * Half of that is worse than none — a person marked erased whose identities still resolve is a
 * person the router will still route, and a membership still `active` whose person row says
 * `erased_at` is a state no query expects. After it commits, nothing new can arrive about them, and
 * the remaining steps are deleting rows at leisure.
 *
 * ## What is deliberately kept, and why that is not a loophole
 *
 * §3.13.5 step 8 keeps `audit_events`, `ledger_entries`, `usage_records`, `labels` and
 * `reader_sets`. All five hold **pseudonymous ids and no content**: an audit row is ids, enums and
 * counts (`02` §3.3.9, enforced by `AuditDetailsSchema`'s 120-character values), a ledger entry is
 * a number, a usage record is tokens and a cost. Once `persons.display_name` is `Former member` and
 * every identity is gone, a `mbr_…` in an audit row resolves to nothing — which is the reasoning
 * `AuditDetailsSchema`'s header records, and the reason a free-text field there would have broken
 * it irreversibly.
 *
 * `labels` and `reader_sets` are immutable by trigger and are the audience of rows that still
 * exist. Rewriting them is not an option (`02` §3.13.6: "Reader sets are never rewritten"), and
 * leaving them is safe for the same reason: a member id in a reader set that no longer has a member
 * grants nothing.
 */
import type { Store, TxToken, UnitOfWork } from '@comvivo/core';
import { PURGE_CHUNK_ROWS } from '@comvivo/core';
import {
  type DeletionId,
  type GroupId,
  type Logger,
  type MemberId,
  type PersonId,
  StorageError,
} from '@comvivo/shared';
import type Database from 'better-sqlite3-multiple-ciphers';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/drizzle.js';
import { conversations, members } from '../schema/groups.js';
import { channelIdentities, persons } from '../schema/identity.js';
import { messages } from '../schema/messages.js';
import { tasks } from '../schema/tasks.js';
import { deleteByColumnChunk } from './chunk.js';

/**
 * The two decisions `02` §3.13.5 leaves to `03`.
 *
 * Defaults are §3.13.5's own: redact the member's group messages, and delete the memories they are
 * the sole subject of. Both are the privacy-preserving choice, and both are defaults rather than
 * constants because a group's constitution may legitimately want the other — a decision log that
 * loses the message it was made from is a decision nobody can explain.
 */
export interface ErasePolicy {
  /** §3.13.5 step 4. `redact` empties the text and keeps the row; `keep` leaves it. */
  readonly messages: 'redact' | 'keep';
  /** §3.13.5 step 5. Delete memories whose only subject is this member, or keep them. */
  readonly soleSubjectMemories: 'delete' | 'keep';
}

export const DEFAULT_ERASE_POLICY: ErasePolicy = {
  messages: 'redact',
  soleSubjectMemories: 'delete',
};

/** The display name a person's row keeps, so a foreign key still resolves to something sayable. */
export const ERASED_DISPLAY_NAME = 'Former member';

export interface PersonErasureOptions {
  readonly store: Pick<Store, 'write'>;
  readonly db: Db;
  readonly connection: Database.Database;
  readonly logger: Logger;
  readonly policy?: ErasePolicy;
  readonly chunkRows?: number;
}

export interface PersonErasureResult {
  readonly personId: PersonId;
  readonly memberIds: readonly MemberId[];
  readonly counts: Readonly<Record<string, number>>;
  readonly total: number;
}

/**
 * One step: a name for `deletions.progress`, and a bounded piece of work.
 *
 * The callback takes the whole `UnitOfWork` rather than a `TxToken`, unlike the group purge's,
 * because three of these steps go **through the primitives** — `deleteByLabelOwnerChunk`,
 * `deleteConversationChunk` and `redactMessage` are each a cross-aggregate deletion that `02`
 * §3.13.3 already names, and reimplementing them here would be two places for the same cascade.
 */
interface EraseStep {
  readonly name: string;
  readonly run: (uow: UnitOfWork, limit: number) => number;
}

const FINISH_STEP = 'finish';

/** Where a membership lives, for the steps that are per-group rather than per-member. */
interface Membership {
  readonly memberId: MemberId;
  readonly groupId: GroupId;
}

export class PersonErasure {
  readonly #options: PersonErasureOptions;
  readonly #policy: ErasePolicy;

  constructor(options: PersonErasureOptions) {
    this.#options = options;
    this.#policy = options.policy ?? DEFAULT_ERASE_POLICY;
  }

  async run(deletionId: DeletionId): Promise<PersonErasureResult> {
    const limit = this.#options.chunkRows ?? PURGE_CHUNK_ROWS;
    const record = this.#options.store.write((uow) => uow.deletions.byId(deletionId));
    if (record === undefined || record.scope !== 'person') {
      throw new StorageError('STORAGE_CONSTRAINT', 'that deletion is not a person erasure', {
        hint: 'The payload names a `deletions` row that does not exist or has another scope.',
        category: 'bug',
        detail: { deletionId },
      });
    }
    const personId = record.subjectRef as PersonId;
    this.#options.logger.info('deletion.started', { detail: { scope: 'person' } });

    // Read **before** step 1, which is also the only step that could change the answer — and it
    // marks memberships `left` rather than deleting them, precisely so a resumption still finds
    // them. A resumed erasure that could not find the member ids would have nothing to delete by.
    const memberships = this.#memberships(personId);
    const steps = this.#steps(personId, memberships);
    const counts: Record<string, number> = {};
    let total = record.progress.counts['deleted'] ?? 0;
    const resumeAt = Math.max(
      0,
      steps.findIndex((step) => step.name === record.progress.step),
    );

    for (const step of steps.slice(resumeAt)) {
      const touched = await this.#drain(step, deletionId, limit);
      if (touched > 0) counts[step.name] = touched;
      total += touched;
      this.#options.store.write((uow) =>
        uow.deletions.advance(uow, deletionId, {
          step: step.name,
          cursor: null,
          counts: { deleted: total },
        }),
      );
    }

    this.#finish(deletionId, total);
    this.#options.logger.info('deletion.completed', {
      count: total,
      detail: { scope: 'person' },
    });
    return {
      personId,
      memberIds: memberships.map((m) => m.memberId),
      counts,
      total,
    };
  }

  async #drain(step: EraseStep, deletionId: DeletionId, limit: number): Promise<number> {
    let touched = 0;
    for (;;) {
      const n = this.#options.store.write((uow) => {
        const live = uow.deletions.byId(deletionId);
        if (live === undefined || live.status === 'completed') return 0;
        return step.run(uow, limit);
      });
      if (n === 0) return touched;
      touched += n;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  #finish(deletionId: DeletionId, total: number): void {
    this.#options.store.write((uow) => {
      uow.deletions.advance(uow, deletionId, {
        step: FINISH_STEP,
        cursor: null,
        counts: { deleted: total },
      });
      uow.deletions.complete(uow, deletionId, uow.now);
    });
    this.#options.connection.pragma('wal_checkpoint(TRUNCATE)');
    this.#options.connection.pragma('incremental_vacuum(2048)');
  }

  #memberships(personId: PersonId): readonly Membership[] {
    return this.#options.db
      .select({ memberId: members.id, groupId: members.groupId })
      .from(members)
      .where(eq(members.personId, personId))
      .all();
  }

  /* ──────────────────────────── the nine steps ──────────────────────────── */

  #steps(personId: PersonId, memberships: readonly Membership[]): readonly EraseStep[] {
    const memberIds = memberships.map((m) => m.memberId);
    return [
      { name: 'identity', run: (uow) => this.#eraseIdentity(uow, personId, memberIds) },
      ...this.#labelSteps(memberships),
      { name: 'conversations.dm', run: (uow, limit) => this.#deleteDms(uow, memberIds, limit) },
      { name: 'messages.redact', run: (uow, limit) => this.#redactSent(uow, memberIds, limit) },
      { name: 'memory.sole_subject', run: (_uow, limit) => this.#deleteSoleSubject(memberIds, limit) },
      ...memberColumnSteps(this.#options.db, memberIds),
      { name: 'tasks.unassign', run: (uow, limit) => this.#unassign(uow, memberIds, limit) },
    ];
  }

  /**
   * §3.13.5 step 1, as one transaction.
   *
   * Returns 1 the first time and 0 afterwards, which is what makes it a step like any other: the
   * drain loop runs it until it reports nothing left to do, and "nothing left" here means the person
   * row already carries `erased_at`. Idempotent by that check rather than by the writes being
   * harmless — `members.left_at` would otherwise move forward on every retry.
   */
  #eraseIdentity(uow: TxToken, personId: PersonId, memberIds: readonly MemberId[]): number {
    const { db } = this.#options;
    const already = db
      .select({ erasedAt: persons.erasedAt })
      .from(persons)
      .where(eq(persons.id, personId))
      .all();
    const row = already[0];
    if (row === undefined || row.erasedAt !== null) return 0;

    db.update(persons)
      .set({
        erasedAt: uow.now,
        // Kept rather than nulled: `members.person_id` is a foreign key and a dashboard rendering a
        // three-year-old decision needs *something* to print. `02` §3.13.5 chooses this string.
        displayName: ERASED_DISPLAY_NAME,
        displayNameSource: 'member',
        locale: null,
        timezone: null,
        updatedAt: uow.now,
      })
      .where(eq(persons.id, personId))
      .run();

    if (memberIds.length > 0) {
      db.update(members)
        .set({ status: 'left', leftAt: uow.now, updatedAt: uow.now })
        .where(inArray(members.id, [...memberIds]))
        .run();
    }
    // Every identity, so nothing routes to them again. This is the write that makes the erasure
    // take effect for the product rather than only for the database.
    db.delete(channelIdentities).where(eq(channelIdentities.personId, personId)).run();
    return 1;
  }

  /** §3.13.5 step 2: everything the member owns a label for, per membership. */
  #labelSteps(memberships: readonly Membership[]): readonly EraseStep[] {
    return memberships.map((membership) => ({
      // The member id in the step name, so a resumption is per-membership: a person in four groups
      // whose erasure crashed in the third resumes in the third.
      name: `labels.${membership.memberId}`,
      run: (uow: UnitOfWork, limit: number) =>
        uow.deletions.deleteByLabelOwnerChunk(
          uow,
          membership.groupId,
          membership.memberId,
          // `all`, not `private_only`: §3.13.5 step 2 says "covering private memories, constraint
          // policies and DM-only data", and an erasure is not a departure. `03`'s `onLeave` policy
          // is the one that chooses; this is the right to be forgotten.
          'all',
          limit,
        ).deleted,
    }));
  }

  /** §3.13.5 step 3: DM conversations and their messages. */
  #deleteDms(uow: UnitOfWork, memberIds: readonly MemberId[], limit: number): number {
    if (memberIds.length === 0) return 0;
    const dms = this.#options.db
      .select({ id: conversations.id, groupId: conversations.groupId })
      .from(conversations)
      .where(inArray(conversations.memberId, [...memberIds]))
      .all();
    let deleted = 0;
    for (const dm of dms) {
      const chunk = uow.deletions.deleteConversationChunk(uow, dm.groupId, dm.id, limit);
      deleted += chunk.deleted;
      if (deleted >= limit) break;
    }
    return deleted;
  }

  /**
   * §3.13.5 step 4: redact the group messages this member sent (Q-PRV-4).
   *
   * Redaction, not deletion, and `02` §3.3.3 is why: a message is the anchor of replies, reactions,
   * a turn's trigger and a decision's provenance. Deleting the row would take the conversation's
   * shape with it — "Ana suggested Thursday" becomes a decision nobody proposed. The text goes, the
   * row stays, `redacted_at` says why.
   *
   * `redactMessage` also takes the message's derived children and deletes its attachments, which is
   * what makes the blobs unreferenced for `02` §3.11's GC.
   */
  #redactSent(uow: UnitOfWork, memberIds: readonly MemberId[], limit: number): number {
    if (this.#policy.messages === 'keep' || memberIds.length === 0) return 0;
    const doomed = this.#options.db
      .select({ id: messages.id, groupId: messages.groupId })
      .from(messages)
      .where(
        and(
          inArray(messages.senderMemberId, [...memberIds]),
          // Already redacted rows are the loop's own output, so without this the drain never ends.
          isNull(messages.redactedAt),
        ),
      )
      .limit(limit)
      .all();
    let stamped = 0;
    for (const message of doomed) {
      const result = uow.deletions.redactMessage(uow, message.groupId, message.id);
      if (result.kind === 'ok') stamped += result.value;
    }
    return stamped;
  }

  /**
   * §3.13.5 step 5, first half: memories whose **only** subject is this member.
   *
   * Runs before the `memory_subjects` rows themselves are deleted, and the order is not negotiable:
   * the subject rows are the only record of what a memory is about, so deleting them first makes
   * "whose only subject is the member" unanswerable and leaves the memory behind forever.
   *
   * `NOT EXISTS` rather than a count: a memory with two subject rows naming the same member is
   * still sole-subject, and `count(*) = 1` would say otherwise.
   */
  #deleteSoleSubject(memberIds: readonly MemberId[], limit: number): number {
    if (this.#policy.soleSubjectMemories === 'keep' || memberIds.length === 0) return 0;
    const refs = sql.join(
      memberIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const doomed = this.#options.db.all<{ rid: number }>(
      sql`SELECT DISTINCT s.memory_rid AS rid
            FROM memory_subjects s
           WHERE s.subject_ref IN (${refs})
             AND NOT EXISTS (
                   SELECT 1 FROM memory_subjects o
                    WHERE o.memory_rid = s.memory_rid
                      AND o.subject_ref NOT IN (${refs}))
           LIMIT ${limit}`,
    );
    if (doomed.length === 0) return 0;
    this.#options.db.run(
      sql`DELETE FROM memory_items WHERE rid IN (${sql.join(
        doomed.map((row) => sql`${row.rid}`),
        sql`, `,
      )})`,
    );
    return doomed.length;
  }

  /** §3.13.5 step 7's last clause: an open task loses its assignee rather than its row. */
  #unassign(uow: TxToken, memberIds: readonly MemberId[], limit: number): number {
    if (memberIds.length === 0) return 0;
    const open = this.#options.db
      .select({ rid: tasks.rid })
      .from(tasks)
      .where(and(inArray(tasks.assigneeMemberId, [...memberIds]), eq(tasks.status, 'open')))
      .limit(limit)
      .all();
    if (open.length === 0) return 0;
    return this.#options.db
      .update(tasks)
      .set({ assigneeMemberId: null, assignmentState: 'unassigned', updatedAt: uow.now })
      .where(
        inArray(
          tasks.rid,
          open.map((row) => row.rid),
        ),
      )
      .returning({ rid: tasks.rid })
      .all().length;
  }
}

/**
 * The tables an erasure empties by a plain `member_id`-shaped column (`02` §3.13.5 steps 5–7).
 *
 * A table, not a sequence of hand-written steps, because every one of them is the same statement
 * with a different name — and because the list is then **readable as the spec's list**, which is
 * how a missing table gets noticed. Each entry is `[table, columns]`, and a table with several
 * member-shaped columns (a guardian relation has three) gets one step per column: `guardian_relations`
 * holds the ward, the guardian and whoever set it up, and an erasure has to take the row whichever
 * role the erased person played.
 *
 * `memory_subjects` comes **after** `memory.sole_subject` in the step order for the reason given
 * there, and `02` §3.13.5 numbers it that way too.
 */
const MEMBER_SCOPED: readonly (readonly [string, readonly string[]])[] = [
  // Step 6.
  ['consent_events', ['member_id']],
  ['private_constraint_policies', ['member_id']],
  ['poll_votes', ['member_id']],
  ['proposal_votes', ['member_id']],
  // Step 5, second half: the subject rows themselves, once the sole-subject memories are gone.
  ['memory_subjects', ['subject_ref']],
  // Step 7.
  ['event_attendees', ['member_id']],
  ['event_attendee_overrides', ['member_id']],
  ['rotation_participants', ['member_id']],
  ['guardian_relations', ['ward_member_id', 'guardian_member_id', 'created_by_member_id']],
  ['standing_approvals', ['guardian_member_id', 'ward_member_id']],
  ['catchup_cursors', ['member_id']],
  ['proactivity_feedback', ['member_id']],
  ['message_reactions', ['member_id']],
];

/** One step per (table, column, member), in the order above. */
function memberColumnSteps(db: Db, memberIds: readonly MemberId[]): readonly EraseStep[] {
  const steps: EraseStep[] = [];
  for (const [table, columns] of MEMBER_SCOPED) {
    for (const column of columns) {
      steps.push({
        name: `${table}.${column}`,
        run: (_uow: UnitOfWork, limit: number) => {
          let deleted = 0;
          for (const memberId of memberIds) {
            deleted += deleteByColumnChunk(db, table, column, memberId, limit - deleted);
            if (deleted >= limit) break;
          }
          return deleted;
        },
      });
    }
  }
  return steps;
}

/** Exported for the erasure test, which asserts the list against `02` §3.13.5 as data. */
export const MEMBER_SCOPED_TABLES: readonly string[] = MEMBER_SCOPED.map(([table]) => table);
