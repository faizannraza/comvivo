/**
 * The group repository (`02` §3.7.1, §3.3.1).
 *
 * ## Why every write here returns a fresh row
 *
 * `02` §3.7.1 says writes return `WriteResult`, and the `ok` value is the row **as it now stands**
 * rather than the patch that was applied. SQLite's `UPDATE … RETURNING` gives that for free in one
 * statement, so there is no read-after-write and no window in which the caller's copy disagrees
 * with the row. It also makes the `version` in the returned object the one a caller must pass to
 * its *next* write, which is the whole mechanism behind optimistic concurrency.
 *
 * ## Why `membership_epoch` is bumped here and not by callers
 *
 * `02` §3.2 requires the epoch to move "in the same transaction as any member status or role
 * change", because `01` §7.2 caches eligibility against it. A caller that remembered to bump it
 * most of the time would produce a cache that is correct most of the time, and the failure is
 * silent: an audience keeps reading a label set computed before someone's role changed. So the
 * member repository calls `bumpMembershipEpoch` itself, and this method exists for the changes that
 * move eligibility without touching a `members` row — `01` §14 A5's outsider seats, and `03`'s
 * role grants.
 */

import type {
  Group,
  GroupPatch,
  GroupReader,
  GroupRepository,
  GroupSnapshot,
  NewGroup,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import { duplicate, notFound, writeConflict, writeOk } from '@comvivo/core';
import type { ConstitutionVersionId, ConversationId, GroupId } from '@comvivo/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { type Db, exactlyOne, maybeOne, type Patch } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import { groups, members } from '../schema/index.js';
import { toGroup } from './rows.js';

/** `02` §3.3.1's defaults, so a `NewGroup` that omits them produces the row the schema would. */
const GROUP_DEFAULTS = {
  locale: 'en',
  historyVisibility: 'since_join',
  weekStart: 1,
  status: 'active',
} as const satisfies Partial<Group>;

export class SqliteGroupRepository implements GroupReader, GroupRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  byId(id: GroupId): Group | undefined {
    const row = maybeOne(this.#db.select().from(groups).where(eq(groups.id, id)));
    return row === undefined ? undefined : toGroup(row);
  }

  list(filter?: { readonly status?: Group['status'] | undefined }): readonly Group[] {
    // `groups_status_idx` covers the filtered form; the unfiltered one is a full scan of a table
    // with one row per group, which is tens of rows on any real instance.
    const query = this.#db.select().from(groups);
    const rows =
      filter?.status === undefined
        ? query.orderBy(asc(groups.createdAt)).all()
        : query.where(eq(groups.status, filter.status)).orderBy(asc(groups.createdAt)).all();
    return rows.map(toGroup);
  }

  /**
   * Q-CTX-9: the epoch and the active members, from one read.
   *
   * Two statements, deliberately, rather than a join: the join would repeat the group's columns
   * once per member, and the two statements are inside the caller's transaction, so they see one
   * snapshot. `02` §3.7.1's `read` is `BEGIN DEFERRED` for exactly this — a multi-statement
   * consistent read.
   *
   * Returns `undefined` for a group that does not exist, and a snapshot with **no members** for a
   * group that has none. Those are different answers and conflating them would make "the group is
   * gone" and "everyone left" the same event; `02` §3.13 has to distinguish them.
   */
  snapshot(id: GroupId): GroupSnapshot | undefined {
    const row = maybeOne(
      this.#db.select({ epoch: groups.membershipEpoch }).from(groups).where(eq(groups.id, id)),
    );
    if (row === undefined) return undefined;
    const memberRows = this.#db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.groupId, id), eq(members.status, 'active')))
      .orderBy(asc(members.id))
      .all();
    return {
      groupId: id,
      membershipEpoch: row.epoch,
      // Sorted by the index order, which is already ascending by id — the `orderBy` states the
      // guarantee rather than creating it, because `01` §7.2's cache key is built from this list
      // and an unordered list would hash differently for the same membership.
      memberIds: memberRows.map((m) => m.id),
    };
  }

  create(_uow: TxToken, group: NewGroup): WriteResult<Group> {
    const now = _uow.now;
    try {
      const row = exactlyOne(
        this.#db
          .insert(groups)
          .values({
            id: group.id,
            name: group.name,
            archetype: group.archetype,
            timezone: group.timezone,
            locale: group.locale ?? GROUP_DEFAULTS.locale,
            historyVisibility: group.historyVisibility ?? GROUP_DEFAULTS.historyVisibility,
            weekStart: group.weekStart ?? GROUP_DEFAULTS.weekStart,
            status: group.status ?? GROUP_DEFAULTS.status,
            createdAt: now,
            updatedAt: now,
          })
          .returning(),
        'the group',
      );
      return writeOk(toGroup(row));
    } catch (error) {
      // A group id is caller-supplied, so a collision means the caller reused one. `duplicate`
      // rather than a throw, with the id it collided on as the existing one — there is nothing
      // else it could be, since `groups.id` is the primary key.
      if (isUniqueViolation(error)) return duplicate(group.id);
      throw error;
    }
  }

  update(uow: TxToken, id: GroupId, expectVersion: number, patch: GroupPatch): WriteResult<Group> {
    return this.#versionedUpdate(uow, id, expectVersion, {
      name: patch.name,
      timezone: patch.timezone,
      locale: patch.locale,
      historyVisibility: patch.historyVisibility,
      weekStart: patch.weekStart,
    });
  }

  setStatus(
    uow: TxToken,
    id: GroupId,
    expectVersion: number,
    status: Group['status'],
  ): WriteResult<Group> {
    return this.#versionedUpdate(uow, id, expectVersion, { status });
  }

  /**
   * Set the constitution or primary-conversation pointer.
   *
   * **No `expectVersion`**, unlike every other write here, and that is the reason it is a separate
   * method: both pointers are set inside the transaction that creates the thing they point at, when
   * the group row was written microseconds earlier by the same code. Demanding a version there
   * would make every creation path thread a number through for no benefit, and the risk optimistic
   * concurrency protects against — two humans editing the same field — does not exist for a pointer
   * no human sets.
   *
   * It still bumps `version`, so a concurrent *settings* edit is not silently lost: a caller that
   * read the group before this ran gets a `conflict` on its own next write, which is correct.
   */
  link(
    uow: TxToken,
    id: GroupId,
    link:
      | { readonly constitutionVersionId: ConstitutionVersionId }
      | { readonly primaryConversationId: ConversationId },
  ): WriteResult<Group> {
    const patch =
      'constitutionVersionId' in link
        ? { constitutionVersionId: link.constitutionVersionId }
        : { primaryConversationId: link.primaryConversationId };
    const row = maybeOne(
      this.#db
        .update(groups)
        .set({ ...patch, updatedAt: uow.now, version: sql`${groups.version} + 1` })
        .where(eq(groups.id, id))
        .returning(),
    );
    return row === undefined ? notFound() : writeOk(toGroup(row));
  }

  /**
   * Increment `membership_epoch` (`02` §3.2).
   *
   * Returns the **new** value, because the caller's next act is usually to invalidate a cache keyed
   * on it, and handing back the old one would invalidate nothing.
   *
   * Does not touch `version`: the epoch is not a field a human edits, and bumping `version` here
   * would make every role change conflict with any settings edit in flight — which would turn a
   * correctness mechanism into a source of spurious refusals.
   */
  bumpMembershipEpoch(uow: TxToken, id: GroupId): WriteResult<number> {
    const row = maybeOne(
      this.#db
        .update(groups)
        .set({ membershipEpoch: sql`${groups.membershipEpoch} + 1`, updatedAt: uow.now })
        .where(eq(groups.id, id))
        .returning({ epoch: groups.membershipEpoch }),
    );
    if (row === undefined) return notFound();
    return writeOk(row.epoch);
  }

  /**
   * One `UPDATE … WHERE id = ? AND version = ?`, which is the whole of optimistic concurrency.
   *
   * The `version` predicate is in the `WHERE` rather than checked after a read: a read-then-write
   * has a window between them, and while `BEGIN IMMEDIATE` closes that window *within* this
   * process, the single statement is what makes the check true of the row rather than of a copy.
   * When it matches nothing, the row is either gone or at a different version — so it reads the
   * version back to tell the caller which, and that second read is only on the failing path.
   */
  #versionedUpdate(
    uow: TxToken,
    id: GroupId,
    expectVersion: number,
    patch: Patch<typeof groups.$inferInsert>,
  ): WriteResult<Group> {
    const row = maybeOne(
      this.#db
        .update(groups)
        .set({ ...patch, updatedAt: uow.now, version: expectVersion + 1 })
        .where(and(eq(groups.id, id), eq(groups.version, expectVersion)))
        .returning(),
    );
    if (row !== undefined) return writeOk(toGroup(row));
    // Nothing matched, so the row is either gone or at a different version. One extra `SELECT`
    // tells the caller which, and it only runs on the failing path — a caller that gets
    // `not_found` must stop, while one that gets `conflict` re-reads and decides again.
    const exists = maybeOne(
      this.#db.select({ id: groups.id }).from(groups).where(eq(groups.id, id)),
    );
    return exists === undefined ? notFound() : writeConflict();
  }
}
