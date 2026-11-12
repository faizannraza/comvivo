/**
 * Groups, persons, members and conversations as domain objects (`02` §3.3.1).
 *
 * These are what repositories return (`02` §3.7.1: "Reads return domain objects … or `undefined`").
 * They are **not** row types: a row carries `created_at`/`updated_at` bookkeeping and nullable
 * columns that only exist for a moment inside a creation transaction, while a domain object is the
 * value the rest of the system reasons about.
 *
 * Three shaping decisions, each from the spec rather than from taste:
 *
 *  - **A person is not a member.** `02` §3.3.1 separates them because one human in three groups is
 *    one `persons` row and three `members` rows, with a different role, handle and consent in each.
 *    Code that conflates them leaks one group's role into another, which is `I4`.
 *  - **`handle` is group-scoped and never reused.** `05` S4 makes it the name the model sees, so a
 *    reissued handle would silently re-attribute history.
 *  - **Timezone and locale are nullable on a person and not on a group.** `02` §3.3.1 spells the
 *    `NULL` as "inherit group", so the inheritance lives in the data rather than in a default that
 *    each caller would have to remember. `resolveTimeZone` below is the one place that resolves it.
 */
import {
  type ChannelIdentityId,
  type ConstitutionVersionId,
  type ConversationId,
  type GroupId,
  idSchema,
  instantSchema,
  type MemberId,
  type PersonId,
  type TimeZoneId,
  timeZoneIdSchema,
  z,
} from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import { type ChannelId, channelIdSchema } from './channel.js';
import { ARCHETYPES, type GroupArchetype } from './group.js';

/* ─────────────────────────────── Group ─────────────────────────────── */

/** `02` §3.3.1: whether members see history from before they joined. */
export const HISTORY_VISIBILITIES = ['since_join', 'all'] as const;
export type HistoryVisibility = (typeof HISTORY_VISIBILITIES)[number];

/**
 * `02` §3.3.1's `groups.status`.
 *
 * `deleting` is a *state*, not a flag: `02` §3.13's deletion runs in stages and a group in this
 * state must stop accepting writes while still being readable by the process removing it.
 */
export const GROUP_STATUSES = ['active', 'archived', 'deleting'] as const;
export type GroupStatus = (typeof GROUP_STATUSES)[number];

/**
 * A group (`02` §3.3.1).
 *
 * `membershipEpoch` is the field `01` §7.2 makes part of every eligibility cache key, and `02`
 * §3.2 requires it to be "incremented in the same transaction as any member status or role
 * change". It is therefore not a statistic — it is a correctness mechanism, and the repository
 * owns bumping it rather than callers.
 */
export interface Group {
  readonly id: GroupId;
  readonly name: string;
  readonly archetype: GroupArchetype;
  /** `NULL` only inside the creation transaction (`02` §3.3.1), hence `undefined` here. */
  readonly constitutionVersionId: ConstitutionVersionId | undefined;
  readonly historyVisibility: HistoryVisibility;
  readonly timezone: TimeZoneId;
  readonly locale: string;
  /** The conversation whose membership *is* the group (`07` SC-2); absent until a chat is bound. */
  readonly primaryConversationId: ConversationId | undefined;
  /** ISO weekday 1–7 (`07`). */
  readonly weekStart: number;
  readonly status: GroupStatus;
  readonly membershipEpoch: number;
  readonly extensionsVersion: number;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

/**
 * What a caller supplies to create a group.
 *
 * Everything the schema defaults is optional here, and the five bookkeeping fields
 * (`membershipEpoch`, `extensionsVersion`, the timestamps, `version`) are absent entirely: they are
 * the repository's to set, and accepting them would let a caller create a group that claims to have
 * a membership history.
 */
export interface NewGroup {
  readonly id: GroupId;
  readonly name: string;
  readonly archetype: GroupArchetype;
  readonly timezone: TimeZoneId;
  readonly locale?: string | undefined;
  readonly historyVisibility?: HistoryVisibility | undefined;
  readonly weekStart?: number | undefined;
  readonly status?: GroupStatus | undefined;
}

/* ─────────────────────────────── Person ─────────────────────────────── */

/** `02` §3.3.1: whether `displayName` came from the platform or the member chose it (`06`). */
export const DISPLAY_NAME_SOURCES = ['platform', 'member'] as const;
export type DisplayNameSource = (typeof DISPLAY_NAME_SOURCES)[number];

/**
 * A human, across every group and channel they appear in (`02` §3.3.1).
 *
 * `erasedAt` set means `08`'s erasure has run: `displayName` has been replaced with the
 * `FORMER_MEMBER_NAME` placeholder and the identities are gone. The row stays because messages and
 * memories reference it, and `02` §3.13 keeps referential integrity over deleting history.
 */
export interface Person {
  readonly id: PersonId;
  readonly displayName: string;
  readonly displayNameSource: DisplayNameSource;
  /** BCP 47; `undefined` means inherit the group's (`02` §3.3.1). */
  readonly locale: string | undefined;
  /** `undefined` means inherit the group's (`02` §3.3.1). */
  readonly timezone: TimeZoneId | undefined;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly erasedAt: Temporal.Instant | undefined;
}

/** `02` §3.3.1: what `displayName` becomes after erasure. */
export const FORMER_MEMBER_NAME = 'Former member';

/** What a caller supplies to create a person. */
export interface NewPerson {
  readonly id: PersonId;
  readonly displayName: string;
  readonly displayNameSource?: DisplayNameSource | undefined;
  readonly locale?: string | undefined;
  readonly timezone?: TimeZoneId | undefined;
}

/**
 * The timezone to use for a person acting in a group (`02` §3.3.1, `07` SC-2).
 *
 * The person's own if they set one, the group's otherwise. Written once here because the fallback
 * is the kind of rule that gets re-implemented slightly differently at each call site — and a
 * reminder fired in the wrong zone is the symptom.
 */
export function resolveTimeZone(
  person: Pick<Person, 'timezone'>,
  group: Pick<Group, 'timezone'>,
): TimeZoneId {
  return person.timezone ?? group.timezone;
}

/** The locale to use for a person acting in a group (`02` §3.3.1, `07` SC-2). */
export function resolveLocale(
  person: Pick<Person, 'locale'>,
  group: Pick<Group, 'locale'>,
): string {
  return person.locale ?? group.locale;
}

/* ───────────────────────────── Member ───────────────────────────── */

/** `02` §3.3.1 / `03` `RoleId`. */
export const MEMBER_ROLES = ['admin', 'member', 'child', 'guest'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** `02` §3.3.1 / `03`. */
export const AGE_BANDS = ['adult', 'teen', 'child'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

/** `02` §3.3.1: `left` keeps the row, because its messages and memories still reference it. */
export const MEMBER_STATUSES = ['invited', 'active', 'left'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/**
 * `02` §3.3.1's `members.consent` (`03` consent semantics).
 *
 * `unknown` is the default and is **not** permission: `04` treats anything short of `memory_on` as
 * "do not extract", so the absence of an answer never reads as yes.
 */
export const CONSENTS = ['unknown', 'informed', 'memory_on', 'memory_off'] as const;
export type Consent = (typeof CONSENTS)[number];

/** One person's membership of one group (`02` §3.3.1). */
export interface Member {
  readonly id: MemberId;
  readonly groupId: GroupId;
  readonly personId: PersonId;
  readonly role: MemberRole;
  readonly ageBand: AgeBand;
  /** `05` S4: stable and unique per group (e.g. `m3`), never reused. */
  readonly handle: string;
  readonly status: MemberStatus;
  readonly consent: Consent;
  readonly nickname: string | undefined;
  readonly joinedAt: Temporal.Instant;
  readonly leftAt: Temporal.Instant | undefined;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

/**
 * What a caller supplies to add a member.
 *
 * `handle` is **not** here: `02` §3.3.1's `members_group_handle_uq` plus `05` S4's "never reused"
 * make handle allocation a decision that needs to see every handle the group has ever issued, which
 * is the repository's view and not the caller's. See `MemberRepository.add`.
 */
export interface NewMember {
  readonly id: MemberId;
  readonly groupId: GroupId;
  readonly personId: PersonId;
  readonly role: MemberRole;
  readonly ageBand?: AgeBand | undefined;
  readonly status: MemberStatus;
  readonly consent?: Consent | undefined;
  readonly nickname?: string | undefined;
  readonly joinedAt: Temporal.Instant;
}

/**
 * `02` §3.3.1's `members_ageband_ck`, as a function.
 *
 * The check is `(role = 'child') = (ageBand <> 'adult')`, which reads oddly until you say it aloud:
 * the `child` **role** and a non-adult **age band** must agree. A teen gets the `child` role, and an
 * adult guest cannot be given a `teen` band to borrow its protections.
 *
 * Duplicated from the CHECK constraint on purpose, and that is the point of having it here: a
 * constraint violation arrives as a `StorageError` with a constraint name, while this answers the
 * question before the write and lets the caller say something useful. The constraint stays as the
 * thing that is actually enforced.
 */
export function ageBandMatchesRole(role: MemberRole, ageBand: AgeBand): boolean {
  return (role === 'child') === (ageBand !== 'adult');
}

/**
 * The default age band for a role, so a caller that has no age information still writes a row that
 * satisfies `members_ageband_ck`.
 *
 * `child` → `child` rather than `teen`: `03`'s protections are strongest for the youngest band, and
 * the safe direction for a missing answer is the more protective one.
 */
export function defaultAgeBand(role: MemberRole): AgeBand {
  return role === 'child' ? 'child' : 'adult';
}

/* ───────────────────────── Channel identity ───────────────────────── */

/**
 * One account on one platform, pointing at a person (`02` §3.3.1).
 *
 * `platformUsername` is explicitly "never a Signal phone number" in `02` §3.3.1 — a phone number is
 * an identifier that reaches someone outside the product, so it belongs with the channel's own
 * credentials and not in a column the dashboard renders.
 */
export interface ChannelIdentity {
  readonly id: ChannelIdentityId;
  readonly channel: ChannelId;
  readonly platformUserId: string;
  readonly personId: PersonId;
  /** `06` `platformDisplayName` as it was last seen. */
  readonly displayNameSnapshot: string;
  readonly platformUsername: string | undefined;
  readonly isBot: boolean;
  /** `06` §3.18: the bot may open a DM with this identity. */
  readonly dmReachable: boolean;
  readonly dmChatId: string | undefined;
  readonly verifiedAt: Temporal.Instant | undefined;
  readonly lastSeenAt: Temporal.Instant | undefined;
  readonly createdAt: Temporal.Instant;
}

/** What a caller supplies to record a platform account. */
export interface NewChannelIdentity {
  readonly id: ChannelIdentityId;
  readonly channel: ChannelId;
  readonly platformUserId: string;
  readonly personId: PersonId;
  readonly displayNameSnapshot: string;
  readonly platformUsername?: string | undefined;
  readonly isBot?: boolean | undefined;
  readonly dmReachable?: boolean | undefined;
  readonly dmChatId?: string | undefined;
  readonly verifiedAt?: Temporal.Instant | undefined;
  readonly lastSeenAt?: Temporal.Instant | undefined;
}

/* ───────────────────────── Conversation ───────────────────────── */

/** `02` §3.3.1. A `dm` has a `memberId`; a `group` conversation does not. */
export const CONVERSATION_KINDS = ['group', 'dm'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

/**
 * A bound chat (`02` §3.3.1, `06` §3.20, `01` §14 A27).
 *
 * Created **only** when a chat is bound: an unclaimed chat persists a `chat_bindings` row and
 * nothing else, so this row existing is itself the evidence that a group claimed the chat.
 */
export interface Conversation {
  readonly id: ConversationId;
  readonly groupId: GroupId;
  readonly channel: ChannelId;
  readonly platformChatId: string;
  readonly kind: ConversationKind;
  /** The DM's owner; `undefined` for a group conversation (`conversations_dm_ck`). */
  readonly memberId: MemberId | undefined;
  /** `03` §3.4.4: this conversation's membership *is* the whole group (`01` §14 A7). */
  readonly primary: boolean;
  readonly title: string | undefined;
  readonly boundAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

/** What a caller supplies to bind a chat. */
export interface NewConversation {
  readonly id: ConversationId;
  readonly groupId: GroupId;
  readonly channel: ChannelId;
  readonly platformChatId: string;
  readonly kind: ConversationKind;
  readonly memberId?: MemberId | undefined;
  readonly primary?: boolean | undefined;
  readonly title?: string | undefined;
  readonly boundAt: Temporal.Instant;
}

/**
 * `02` §3.3.1's `conversations_dm_ck` and `conversations_primary_ck`, as functions.
 *
 * Returns the violated rule's name, or `undefined` when both hold — the name rather than a boolean
 * so a caller can say *which* rule it broke without re-deriving it.
 */
export function conversationShapeError(
  conversation: Pick<NewConversation, 'kind' | 'memberId' | 'primary'>,
): 'dm_needs_member' | 'group_has_no_member' | 'primary_must_be_group' | undefined {
  const isDm = conversation.kind === 'dm';
  if (isDm && conversation.memberId === undefined) return 'dm_needs_member';
  if (!isDm && conversation.memberId !== undefined) return 'group_has_no_member';
  if (conversation.primary === true && isDm) return 'primary_must_be_group';
  return undefined;
}

/* ───────────────────────── Boundary schemas ───────────────────────── */

/**
 * Boundary schemas for the fields an HTTP or CLI caller supplies (`CLAUDE.md` §2).
 *
 * Only the *inputs* get schemas. A `Group` that a repository built from its own row does not cross
 * a boundary and validating it again would be checking SQLite against itself — the column types in
 * `02` §3.1 are what guarantee that shape.
 */
export const newGroupSchema: z.ZodType<NewGroup> = z.object({
  id: idSchema('grp'),
  name: z.string().min(1).max(120),
  archetype: z.enum(ARCHETYPES),
  timezone: timeZoneIdSchema,
  locale: z.string().min(2).max(35).optional(),
  historyVisibility: z.enum(HISTORY_VISIBILITIES).optional(),
  weekStart: z.int().min(1).max(7).optional(),
  status: z.enum(GROUP_STATUSES).optional(),
});

export const newPersonSchema: z.ZodType<NewPerson> = z.object({
  id: idSchema('prs'),
  displayName: z.string().min(1).max(120),
  displayNameSource: z.enum(DISPLAY_NAME_SOURCES).optional(),
  locale: z.string().min(2).max(35).optional(),
  timezone: timeZoneIdSchema.optional(),
});

export const newChannelIdentitySchema: z.ZodType<NewChannelIdentity> = z.object({
  id: idSchema('chid'),
  channel: channelIdSchema,
  platformUserId: z.string().min(1).max(200),
  personId: idSchema('prs'),
  displayNameSnapshot: z.string().min(1).max(120),
  platformUsername: z.string().min(1).max(200).optional(),
  isBot: z.boolean().optional(),
  dmReachable: z.boolean().optional(),
  dmChatId: z.string().min(1).max(200).optional(),
  verifiedAt: instantSchema.optional(),
  lastSeenAt: instantSchema.optional(),
});
