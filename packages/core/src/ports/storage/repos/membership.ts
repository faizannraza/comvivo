/**
 * Ports for groups, persons, identities, members and conversations (`02` §3.7.1).
 *
 * The split into a `…Reader` and a `…Repository` is `02` §3.7.1's: a reader is what `ReadScope`
 * exposes and is available in both a read and a write transaction, while a repository is only on
 * `UnitOfWork`. That is the type system carrying the rule "this needs a write transaction" instead
 * of a comment, and it is why every write takes a `TxToken` as its first argument.
 *
 * Conventions, from `02` §3.7.1 and applied without exception below:
 *  - reads return the domain object or `undefined`;
 *  - writes return `WriteResult`, never throw for a condition the caller can act on;
 *  - infrastructure failures throw `StorageError`;
 *  - a read that could cross a group is scoped on `groupId` in its **signature**, so forgetting it
 *    is a type error rather than an `I4` hole.
 */

import type {
  ChannelIdentityId,
  ConstitutionVersionId,
  ConversationId,
  GroupId,
  MemberId,
  PersonId,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { ChannelId } from '../../../domain/channel.js';
import type {
  ChannelIdentity,
  Consent,
  Conversation,
  Group,
  Member,
  MemberRole,
  MemberStatus,
  NewChannelIdentity,
  NewConversation,
  NewGroup,
  NewMember,
  NewPerson,
  Person,
} from '../../../domain/membership.js';
import type { GroupSnapshot } from '../../../ifc/eligible.js';
import type { TxToken, WriteResult } from '../uow.js';

/* ───────────────────────────── Groups ───────────────────────────── */

export interface GroupReader {
  byId(id: GroupId): Group | undefined;
  /**
   * Every group, for the instance-wide views that legitimately span groups.
   *
   * Not an `I4` hole: `I4` is about one group's *content* reaching another, and the dashboard's
   * group list, the scheduler's sweep and the backup writer all need the set of groups to exist.
   * `status` narrows it because every one of those callers wants `active` and forgetting to filter
   * would quietly include groups mid-deletion.
   */
  list(filter?: { readonly status?: Group['status'] | undefined }): readonly Group[];
  /**
   * The group state an eligibility decision is made against (Q-CTX-9).
   *
   * Returns `membershipEpoch` and the active members together **from one read**, because the pair
   * is only meaningful if it is consistent: an epoch read before a membership change and a member
   * list read after it describes a group that never existed, and `01` §7.2 caches eligibility
   * against exactly that pair.
   */
  snapshot(id: GroupId): GroupSnapshot | undefined;
}

export interface GroupRepository {
  create(uow: TxToken, group: NewGroup): WriteResult<Group>;
  /**
   * Rename, re-home or re-settle a group.
   *
   * `expectVersion` is mandatory rather than optional: `02` §3.1 gives `groups` a `version` column
   * precisely so two admins editing settings cannot silently overwrite each other, and an optional
   * parameter is one a caller omits on the path that matters.
   */
  update(uow: TxToken, id: GroupId, expectVersion: number, patch: GroupPatch): WriteResult<Group>;
  /**
   * Point the group at its constitution version, or at its primary conversation.
   *
   * Separate from `update` because both are set **inside** the creating transaction, when the row
   * `update` would read does not have its final shape yet, and because neither is a user-facing
   * edit — folding them in would mean a settings form could change the constitution pointer.
   */
  link(
    uow: TxToken,
    id: GroupId,
    link:
      | { readonly constitutionVersionId: ConstitutionVersionId }
      | { readonly primaryConversationId: ConversationId },
  ): WriteResult<Group>;
  /**
   * Increment `membership_epoch` (`02` §3.2).
   *
   * Exposed, rather than left implicit in the member writes that call it, because `01` §14 A5's
   * outsider seats and `03`'s role changes both move eligibility without touching a `members` row —
   * so there are callers the member repository cannot cover. Idempotent it is **not**: every call
   * is a distinct statement that eligibility may have changed.
   */
  bumpMembershipEpoch(uow: TxToken, id: GroupId): WriteResult<number>;
  setStatus(
    uow: TxToken,
    id: GroupId,
    expectVersion: number,
    status: Group['status'],
  ): WriteResult<Group>;
}

/** The fields an admin may change on a group (`09`'s settings screen). */
export interface GroupPatch {
  readonly name?: string | undefined;
  readonly timezone?: Group['timezone'] | undefined;
  readonly locale?: string | undefined;
  readonly historyVisibility?: Group['historyVisibility'] | undefined;
  readonly weekStart?: number | undefined;
}

/* ───────────────────────────── Persons ───────────────────────────── */

export interface PersonReader {
  byId(id: PersonId): Person | undefined;
  /** Q-PRV-1: every person reachable through a group, for the erasure and departure paths. */
  byGroup(groupId: GroupId): readonly Person[];
}

export interface PersonRepository {
  create(uow: TxToken, person: NewPerson): WriteResult<Person>;
  /**
   * Change the display name, and record where the new one came from.
   *
   * `source` is not optional, because the distinction decides whether a *later* platform rename
   * may overwrite it: `06` lets a platform name update a `platform`-sourced name and never a
   * `member`-sourced one. A caller that could omit it would default to clobbering a chosen name.
   */
  rename(
    uow: TxToken,
    id: PersonId,
    displayName: string,
    source: Person['displayNameSource'],
  ): WriteResult<Person>;
  setPreferences(
    uow: TxToken,
    id: PersonId,
    preferences: {
      readonly locale?: string | null | undefined;
      readonly timezone?: Person['timezone'] | null | undefined;
    },
  ): WriteResult<Person>;
  /**
   * `08`'s erasure: replace the display name with the placeholder and stamp `erased_at`.
   *
   * The row is kept. `02` §3.13 chooses referential integrity over deleting history, so messages
   * and memories keep pointing at a person who now has no name and no identities.
   */
  erase(uow: TxToken, id: PersonId, at: Temporal.Instant): WriteResult<Person>;
}

/* ──────────────────────── Channel identities ──────────────────────── */

export interface ChannelIdentityReader {
  /** Q-ING-3, the first lookup on every inbound message. */
  byPlatform(channel: ChannelId, platformUserId: string): ChannelIdentity | undefined;
  byId(id: ChannelIdentityId): ChannelIdentity | undefined;
  /** Q-PRV-1: every platform account of one person, for erasure. */
  byPerson(personId: PersonId): readonly ChannelIdentity[];
}

export interface ChannelIdentityRepository {
  /**
   * Record a platform account, or report the one that already holds it.
   *
   * Returns `duplicate` with the existing id when `(channel, platformUserId)` is taken, because
   * that is the normal case on every message after the first — not an error, and not something to
   * resolve by overwriting: the existing row may point at a *different* person, which is a real
   * conflict for `06`'s identity linking to handle rather than for a repository to decide.
   */
  create(uow: TxToken, identity: NewChannelIdentity): WriteResult<ChannelIdentity>;
  /**
   * Update the parts of an identity the platform owns, from an inbound event.
   *
   * One method rather than four setters: these fields all arrive together in a `06` event, and
   * writing them in one `UPDATE` is what keeps the ingestion fast path to a single statement.
   */
  touch(
    uow: TxToken,
    id: ChannelIdentityId,
    seen: {
      readonly displayNameSnapshot?: string | undefined;
      readonly platformUsername?: string | undefined;
      readonly dmReachable?: boolean | undefined;
      readonly dmChatId?: string | undefined;
      readonly lastSeenAt: Temporal.Instant;
    },
  ): WriteResult<ChannelIdentity>;
  /** `08` erasure: an erased person keeps no platform accounts. */
  deleteForPerson(uow: TxToken, personId: PersonId): number;
}

/* ───────────────────────────── Members ───────────────────────────── */

export interface MemberReader {
  byId(groupId: GroupId, id: MemberId): Member | undefined;
  /** Q-ING-4, the second lookup on every inbound message. */
  byPerson(groupId: GroupId, personId: PersonId): Member | undefined;
  byHandle(groupId: GroupId, handle: string): Member | undefined;
  /** Q-CTX-9. `status` defaults to `active`, which is what every context build wants. */
  list(
    groupId: GroupId,
    filter?: { readonly status?: MemberStatus | 'any' | undefined },
  ): readonly Member[];
  /** Q-PRV-1: every membership of one person, across groups, for erasure and departure. */
  byPersonAcrossGroups(personId: PersonId): readonly Member[];
}

export interface MemberRepository {
  /**
   * Add a member, allocating the handle.
   *
   * The handle is **not** a caller input: `02` §3.3.1's `members_group_handle_uq` and `05` S4's
   * "stable … never reused" together mean allocation has to see every handle the group has ever
   * issued, including those of members who have left. The repository holds that view; a caller
   * does not. `handleHint` exists only for tests and imports that want a specific spelling, and is
   * refused rather than adjusted if it is taken — silently appending a digit to a requested handle
   * is how two imports end up disagreeing about who `m3` is.
   */
  add(uow: TxToken, member: NewMember, handleHint?: string): WriteResult<Member>;
  /**
   * Change a member's role, bumping the group's membership epoch in the same transaction.
   *
   * `02` §3.2 requires the bump "in the same transaction as any member status or role change", and
   * this is one of the two methods that satisfies it. The requirement is the reason these are not
   * just `update` calls: a generic patch method would let a caller change `role` without the bump,
   * and the symptom is a cached eligibility set that outlives the authority it was computed from.
   */
  setRole(
    uow: TxToken,
    groupId: GroupId,
    id: MemberId,
    expectVersion: number,
    role: MemberRole,
    ageBand?: Member['ageBand'],
  ): WriteResult<Member>;
  /** Change a member's status, bumping the membership epoch (`02` §3.2). */
  setStatus(
    uow: TxToken,
    groupId: GroupId,
    id: MemberId,
    expectVersion: number,
    status: MemberStatus,
    at: Temporal.Instant,
  ): WriteResult<Member>;
  /**
   * Record a consent answer (`03`).
   *
   * No epoch bump: consent governs whether `04` *extracts* memory from someone, not who may read
   * what, so it does not move eligibility. Stated here because the asymmetry with `setRole` is
   * exactly the kind of thing a later reader would "fix".
   */
  setConsent(
    uow: TxToken,
    groupId: GroupId,
    id: MemberId,
    expectVersion: number,
    consent: Consent,
  ): WriteResult<Member>;
  setNickname(
    uow: TxToken,
    groupId: GroupId,
    id: MemberId,
    expectVersion: number,
    nickname: string | null,
  ): WriteResult<Member>;
}

/* ────────────────────────── Conversations ────────────────────────── */

export interface ConversationReader {
  byId(groupId: GroupId, id: ConversationId): Conversation | undefined;
  /** Q-ING-2's second step: the conversation for a chat, within one group. */
  byPlatform(
    groupId: GroupId,
    channel: ChannelId,
    platformChatId: string,
  ): Conversation | undefined;
  /** `07` SC-2: the conversation whose membership is the whole group. */
  primary(groupId: GroupId): Conversation | undefined;
  list(
    groupId: GroupId,
    filter?: { readonly kind?: Conversation['kind'] | undefined },
  ): readonly Conversation[];
}

export interface ConversationRepository {
  /**
   * Bind a chat to a group (`06` §3.20, `01` §14 A27).
   *
   * Returns `duplicate` when `(channel, platformChatId, groupId)` is already bound, which is the
   * answer a redelivered bind event needs.
   */
  create(uow: TxToken, conversation: NewConversation): WriteResult<Conversation>;
  setTitle(
    uow: TxToken,
    groupId: GroupId,
    id: ConversationId,
    title: string | null,
  ): WriteResult<Conversation>;
  /**
   * Make this the group's primary conversation.
   *
   * A dedicated method because `conversations_one_primary_uq` is a *partial* unique index: setting
   * a second primary fails at the constraint, so the demotion of the current one and the promotion
   * of this one have to happen in one transaction and in that order.
   */
  setPrimary(uow: TxToken, groupId: GroupId, id: ConversationId): WriteResult<Conversation>;
}
