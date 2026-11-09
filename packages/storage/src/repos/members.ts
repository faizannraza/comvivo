/**
 * The member repository (`02` §3.7.1, §3.3.1).
 *
 * ## Handle allocation
 *
 * `05` S4 makes `handle` the short, stable name the model sees for a member (`m3`), and `02`
 * §3.3.1 adds `members_group_handle_uq` plus "never reused". Together those make allocation a
 * decision that must see **every handle the group has ever issued** — including those of members
 * who left, whose rows are still there. That view belongs to the repository, so `add` allocates
 * and `NewMember` has no `handle` field.
 *
 * The allocation is `m` followed by one past the highest number ever used, which satisfies "never
 * reused" without a counter column: the evidence is the rows themselves, so it survives a restore
 * from backup and cannot drift from the data the way a cached sequence can.
 *
 * ## The membership epoch
 *
 * `02` §3.2 requires `groups.membership_epoch` to move "in the same transaction as any member
 * status or role change", because `01` §7.2 caches eligibility against it. Every method here that
 * changes `role` or `status` bumps it; `setConsent` and `setNickname` do not, because consent
 * governs whether `04` extracts memory and a nickname is a display string — neither moves who may
 * read what. That asymmetry is the kind of thing a later reader would "tidy", so it is stated at
 * each method.
 */
import type {
  Consent,
  GroupRepository,
  Member,
  MemberReader,
  MemberRepository,
  MemberRole,
  MemberStatus,
  NewMember,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import {
  ageBandMatchesRole,
  defaultAgeBand,
  duplicate,
  notFound,
  writeConflict,
  writeOk,
} from '@comvivo/core';
import { type GroupId, type MemberId, type PersonId, StorageError } from '@comvivo/shared';
import { and, asc, eq, like } from 'drizzle-orm';
import type { Temporal } from 'temporal-polyfill';
import { type Db, exactlyOne, maybeOne, type Patch } from '../db/drizzle.js';
import { isUniqueViolation } from '../db/errors.js';
import { members } from '../schema/index.js';
import { toMember } from './rows.js';

/** `05` S4's handle shape: `m` and a number, so a prompt can carry it in three characters. */
const HANDLE_PREFIX = 'm';

export class SqliteMemberRepository implements MemberReader, MemberRepository {
  readonly #db: Db;
  readonly #groups: Pick<GroupRepository, 'bumpMembershipEpoch'>;

  /**
   * Takes the group repository, not the `groups` table.
   *
   * The epoch bump is a group write with its own reasoning (it deliberately leaves `version`
   * alone), and duplicating that `UPDATE` here would be two places that have to agree about it.
   * Narrowed to the one method, so this repository cannot quietly grow the ability to rename a
   * group.
   */
  constructor(db: Db, groups: Pick<GroupRepository, 'bumpMembershipEpoch'>) {
    this.#db = db;
    this.#groups = groups;
  }

  byId(groupId: GroupId, id: MemberId): Member | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(members)
        .where(and(eq(members.groupId, groupId), eq(members.id, id))),
    );
    return row === undefined ? undefined : toMember(row);
  }

  /** Q-ING-4, through `members_group_person_uq`. The second lookup on every message. */
  byPerson(groupId: GroupId, personId: PersonId): Member | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(members)
        .where(and(eq(members.groupId, groupId), eq(members.personId, personId))),
    );
    return row === undefined ? undefined : toMember(row);
  }

  byHandle(groupId: GroupId, handle: string): Member | undefined {
    const row = maybeOne(
      this.#db
        .select()
        .from(members)
        .where(and(eq(members.groupId, groupId), eq(members.handle, handle))),
    );
    return row === undefined ? undefined : toMember(row);
  }

  /**
   * Q-CTX-9, through `members_group_status_idx`.
   *
   * `status` defaults to `active`, which is what a context build wants, and `'any'` is spelled out
   * rather than reached by omitting the filter — so a caller that wants everyone says so, and a
   * caller that forgot to think about it gets the safe set.
   */
  list(
    groupId: GroupId,
    filter?: { readonly status?: MemberStatus | 'any' | undefined },
  ): readonly Member[] {
    const status = filter?.status ?? 'active';
    const where =
      status === 'any'
        ? eq(members.groupId, groupId)
        : and(eq(members.groupId, groupId), eq(members.status, status));
    const rows = this.#db.select().from(members).where(where).orderBy(asc(members.id)).all();
    return rows.map(toMember);
  }

  /** Q-PRV-1, through `members_person_idx`: every membership of one person, for erasure. */
  byPersonAcrossGroups(personId: PersonId): readonly Member[] {
    const rows = this.#db
      .select()
      .from(members)
      .where(eq(members.personId, personId))
      .orderBy(asc(members.groupId), asc(members.id))
      .all();
    return rows.map(toMember);
  }

  /**
   * Add a member, allocating the handle, and bump the group's epoch.
   *
   * `handleHint` is **refused rather than adjusted** when it is taken. Silently appending a digit
   * to a requested handle is how two imports end up disagreeing about who `m3` is, and the caller
   * that passed a hint is the one that can decide what to do instead. Tests and `02` §3.15's
   * import are the only callers that pass one.
   */
  add(uow: TxToken, member: NewMember, handleHint?: string): WriteResult<Member> {
    const ageBand = member.ageBand ?? defaultAgeBand(member.role);
    if (!ageBandMatchesRole(member.role, ageBand)) {
      // Checked before the write so the error names the pair, where the CHECK constraint would
      // only name itself. `02` §3.3.1's `members_ageband_ck` stays the thing enforced.
      throw new StorageError(
        'STORAGE_CONSTRAINT',
        `role ${member.role} and age band ${ageBand} contradict each other`,
        {
          hint:
            'The `child` role and a non-adult age band imply each other: a child or teen takes ' +
            'the `child` role, and an adult takes any other role.',
          category: 'bug',
        },
      );
    }

    const handle = handleHint ?? this.#nextHandle(member.groupId);
    try {
      const row = exactlyOne(
        this.#db
          .insert(members)
          .values({
            id: member.id,
            groupId: member.groupId,
            personId: member.personId,
            role: member.role,
            ageBand,
            handle,
            status: member.status,
            consent: member.consent ?? 'unknown',
            nickname: member.nickname,
            joinedAt: member.joinedAt,
            createdAt: uow.now,
            updatedAt: uow.now,
          })
          .returning(),
        'the member',
      );
      // A new member changes who the `group` audience admits, so the epoch moves (`02` §3.2) —
      // even for `status: 'invited'`, because `01` §7.2's snapshot is what decides whether an
      // invited member is in the audience, and that decision must not be made against a stale
      // epoch either way.
      const bumped = this.#groups.bumpMembershipEpoch(uow, member.groupId);
      if (bumped.kind !== 'ok') return notFound();
      return writeOk(toMember(row));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Two different unique indexes can fire: `(group, person)` means this person is already a
      // member, and `(group, handle)` means the hint was taken. They need different answers, so
      // the existing row decides which.
      const existing = this.byPerson(member.groupId, member.personId);
      if (existing !== undefined) return duplicate(existing.id);
      const taken = this.byHandle(member.groupId, handle);
      if (taken !== undefined) return duplicate(taken.id);
      // Neither index explains it, so the id itself collided.
      return duplicate(member.id);
    }
  }

  setRole(
    uow: TxToken,
    groupId: GroupId,
    id: MemberId,
    expectVersion: number,
    role: MemberRole,
    ageBand?: Member['ageBand'],
  ): WriteResult<Member> {
    const band = ageBand ?? defaultAgeBand(role);
    if (!ageBandMatchesRole(role, band)) {
      throw new StorageError(
        'STORAGE_CONSTRAINT',
        `role ${role} and age band ${band} contradict each other`,
        {
          hint: 'Pass the age band explicitly when changing to or from the `child` role.',
          category: 'bug',
        },
      );
    }
    // A role change moves authority, so eligibility computed before it must not be reused.
    return this.#versionedUpdate(uow, groupId, id, expectVersion, { role, ageBand: band }, 'bump');
  }

  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: MemberId,
    expectVersion: number,
    status: MemberStatus,
    at: Temporal.Instant,
  ): WriteResult<Member> {
    // `left_at` is stamped when they leave and cleared if they come back, so the column always
    // answers "when did this membership end" rather than "when did it last end".
    return this.#versionedUpdate(
      uow,
      groupId,
      id,
      expectVersion,
      { status, leftAt: status === 'left' ? at : null },
      'bump',
    );
  }

  /** No epoch bump: consent governs extraction (`04`), not who may read what. */
  setConsent(
    uow: TxToken,
    groupId: GroupId,
    id: MemberId,
    expectVersion: number,
    consent: Consent,
  ): WriteResult<Member> {
    return this.#versionedUpdate(uow, groupId, id, expectVersion, { consent }, 'no-bump');
  }

  /** No epoch bump: a nickname is a display string. */
  setNickname(
    uow: TxToken,
    groupId: GroupId,
    id: MemberId,
    expectVersion: number,
    nickname: string | null,
  ): WriteResult<Member> {
    return this.#versionedUpdate(uow, groupId, id, expectVersion, { nickname }, 'no-bump');
  }

  /**
   * One past the highest handle number the group has ever used.
   *
   * Derived from the rows rather than from a counter, so "never reused" (`05` S4) holds after a
   * restore from backup: a counter column could be restored to a value lower than the handles that
   * already exist, and the next allocation would collide with a departed member's name.
   *
   * `LIKE 'm%'` then parse, rather than a `MAX(CAST(...))`: a `handleHint` may have put a
   * non-numeric handle in the column, and `CAST('alice' AS INTEGER)` is `0` in SQLite — which would
   * make a group with a named member start allocating from `m1` again.
   */
  #nextHandle(groupId: GroupId): string {
    const rows = this.#db
      .select({ handle: members.handle })
      .from(members)
      .where(and(eq(members.groupId, groupId), like(members.handle, `${HANDLE_PREFIX}%`)))
      .all();
    let highest = 0;
    for (const row of rows) {
      const suffix = row.handle.slice(HANDLE_PREFIX.length);
      // `Number` and not `parseInt`: `parseInt('3x')` is 3, so a handle like `m3x` would make the
      // next allocation `m4` and leave `m3x` looking like it had been counted.
      const value = /^\d+$/.test(suffix) ? Number(suffix) : 0;
      if (value > highest) highest = value;
    }
    return `${HANDLE_PREFIX}${String(highest + 1)}`;
  }

  #versionedUpdate(
    uow: TxToken,
    groupId: GroupId,
    id: MemberId,
    expectVersion: number,
    patch: Patch<typeof members.$inferInsert>,
    epoch: 'bump' | 'no-bump',
  ): WriteResult<Member> {
    const row = maybeOne(
      this.#db
        .update(members)
        .set({ ...patch, updatedAt: uow.now, version: expectVersion + 1 })
        .where(
          and(eq(members.groupId, groupId), eq(members.id, id), eq(members.version, expectVersion)),
        )
        .returning(),
    );
    if (row === undefined) {
      const exists = this.byId(groupId, id);
      return exists === undefined ? notFound() : writeConflict();
    }
    if (epoch === 'bump') {
      const bumped = this.#groups.bumpMembershipEpoch(uow, groupId);
      // The member row exists, so its group does — a `not_found` here would mean the foreign key
      // is broken, which is a corrupt database rather than a condition the caller can act on.
      if (bumped.kind !== 'ok') {
        throw new StorageError('STORAGE_CORRUPT', `member ${id} has no group row for ${groupId}`, {
          hint: 'The `members.group_id` foreign key should make this impossible; run `doctor`.',
        });
      }
    }
    return writeOk(toMember(row));
  }
}
